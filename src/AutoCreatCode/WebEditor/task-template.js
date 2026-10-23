(() => {
  'use strict';

  const FORMAT = 'BoTech.EquipmentFlowTaskTemplate';
  const VERSION = 1;
  const decoder = new TextDecoder('utf-8');

  function safeRelativePath(path) {
    if (typeof path !== 'string' || !path.trim()) throw new Error('模板清单中的源码路径为空。');
    const normalized = path.replace(/\\/g, '/');
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)
      || normalized.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error(`模板源码路径“${path}”必须是安全的相对路径。`);
    return normalized;
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function extractRegions(source, filePath) {
    const regions = [];
    const stack = [];
    const lines = source.split(/\r?\n/);
    lines.forEach((line, index) => {
      const region = line.match(/^\s*#region\b\s*(.*?)\s*$/);
      if (region) {
        const originalName = region[1].trim();
        const name = originalName.replace(/\s*\/\/.*$/, '').trim() || `未命名区域 ${index + 1}`;
        const item = { Name: name, OriginalName: originalName, Line: index + 1, EndLine: null, Depth: stack.length, Parent: stack.length ? stack[stack.length - 1].Name : '' };
        regions.push(item);
        stack.push(item);
        return;
      }
      if (/^\s*#endregion\b/.test(line)) {
        if (!stack.length) throw new Error(`${filePath} 第 ${index + 1} 行存在没有对应 #region 的 #endregion。`);
        stack.pop().EndLine = index + 1;
      }
    });
    if (stack.length) {
      const openRegion = stack[stack.length - 1];
      throw new Error(`${filePath} 第 ${openRegion.Line} 行的 #region“${openRegion.Name}”没有对应 #endregion。`);
    }
    return regions;
  }

  function validateTaskData(items) {
    const list = Array.isArray(items) ? items : [];
    const names = new Set();
    list.forEach(item => {
      if (!item || typeof item.Name !== 'string' || !item.Name.trim()) throw new Error('TaskData 中存在没有名称的数据成员。');
      if (names.has(item.Name)) throw new Error(`TaskData 数据成员“${item.Name}”重复。`);
      names.add(item.Name);
    });
    return list;
  }

  async function parseFile(file) {
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择 Task 模板 ZIP 文件。');
    const entries = await window.FlowArchive.readEntries(await file.arrayBuffer());
    const manifestPaths = Array.from(entries.keys()).filter(path => path.split('/').pop().toLowerCase() === 'task-template.json');
    if (manifestPaths.length !== 1) throw new Error('模板 ZIP 必须且只能包含一个 task-template.json 清单文件。');

    let manifest;
    try { manifest = JSON.parse(decoder.decode(entries.get(manifestPaths[0]))); }
    catch (error) { throw new Error(`模板清单无法读取：${error.message}`); }
    if (!manifest || manifest.Format !== FORMAT) throw new Error(`模板格式不匹配，要求 ${FORMAT}。`);
    if (Number(manifest.Version) !== VERSION) throw new Error(`暂不支持 Task 模板版本 ${manifest.Version}。`);

    const task = manifest.Template || {};
    ['ClassName', 'Namespace', 'BaseType'].forEach(key => {
      if (typeof task[key] !== 'string' || !task[key].trim()) throw new Error(`模板清单缺少 Template.${key}。`);
    });
    if (!Array.isArray(manifest.SourceFiles) || !manifest.SourceFiles.length) throw new Error('模板清单没有 SourceFiles。');
    const sourceDescriptors = manifest.SourceFiles.map(descriptor => ({
      ...descriptor,
      Path: safeRelativePath(descriptor && descriptor.Path),
    }));
    const sourcePaths = new Set();
    sourceDescriptors.forEach(descriptor => {
      if (sourcePaths.has(descriptor.Path)) throw new Error(`模板清单重复引用“${descriptor.Path}”。`);
      sourcePaths.add(descriptor.Path);
      if (!descriptor.Path.toLowerCase().endsWith('.cs')) throw new Error(`模板源码“${descriptor.Path}”不是 .cs 文件。`);
      if (!entries.has(descriptor.Path)) throw new Error(`模板 ZIP 缺少清单引用的源码“${descriptor.Path}”。`);
    });
    const primarySource = safeRelativePath(manifest.PrimarySource || '');
    if (!sourcePaths.has(primarySource)) throw new Error('PrimarySource 必须引用 SourceFiles 中的一个文件。');

    const parser = window.EquipmentFlowCSharpCatalog;
    if (!parser || typeof parser.parseSource !== 'function') throw new Error('C# 源码解析器尚未加载。');
    const files = [];
    const methods = [];
    const allRegions = [];
    const diagnostics = [];
    sourceDescriptors.forEach(descriptor => {
      const source = decoder.decode(entries.get(descriptor.Path));
      if (!source.trim()) throw new Error(`模板源码“${descriptor.Path}”为空。`);
      const parsed = parser.parseSource(source, descriptor.Path);
      const taskClasses = parsed.classes.filter(type => type.name === task.ClassName && type.namespace === task.Namespace);
      if (taskClasses.length !== 1) throw new Error(`${descriptor.Path} 必须且只能声明一个 ${task.Namespace}.${task.ClassName}。`);
      const taskClass = taskClasses[0];
      if (taskClass.kind !== 'class' || !(taskClass.Modifiers || []).includes('partial'))
        throw new Error(`${descriptor.Path} 中的 ${task.ClassName} 必须声明为 partial class。`);
      const declaration = new RegExp(`\\bclass\\s+${escapeRegExp(task.ClassName)}\\b([^\\{;]*)`).exec(source);
      if (!declaration) throw new Error(`${descriptor.Path} 中的 ${task.ClassName} 类声明无法读取。`);
      if (descriptor.Path === primarySource) {
        const baseType = String(task.BaseType).split('.').pop();
        if (!new RegExp(`:\\s*(?:[\\w.]+\\.)?${escapeRegExp(baseType)}\\b`).test(declaration[1]))
          throw new Error(`主 Task 源码的基类与清单声明的“${task.BaseType}”不一致。`);
      }
      const regions = extractRegions(source, descriptor.Path);
      const defaultCategory = descriptor.MethodCategory || descriptor.DisplayName || descriptor.Role || '未分类';
      const fileMethods = taskClass.methods.map(method => {
        const containingRegion = descriptor.UseRegionsAsMethodCategories
          ? regions.filter(region => region.Line <= method.Line && region.EndLine >= method.Line)
            .sort((left, right) => right.Depth - left.Depth)[0]
          : null;
        return {
          ...method,
          FilePath: descriptor.Path,
          FileName: descriptor.Path.split('/').pop(),
          Role: descriptor.Role || '',
          Category: containingRegion ? containingRegion.Name : defaultCategory,
          RegionName: containingRegion ? containingRegion.Name : '',
          AccessModifier: method.AccessModifier || (method.IsPublic ? 'public' : 'private'),
        };
      });
      fileMethods.forEach(method => methods.push(method));
      regions.forEach(region => allRegions.push({ ...region, FilePath: descriptor.Path }));
      (parsed.diagnostics || []).forEach(message => diagnostics.push(`${descriptor.Path}: ${message}`));
      files.push({ ...descriptor, Source: source, Namespace: task.Namespace, ClassName: task.ClassName, Regions: regions, Methods: fileMethods });
    });

    const declaredRegions = Array.isArray(manifest.Regions) ? manifest.Regions : [];
    const primaryRegionNames = new Set(allRegions.filter(region => region.FilePath === primarySource && region.Depth === 0).map(region => region.Name));
    declaredRegions.forEach(region => {
      if (region && region.Name && !primaryRegionNames.has(region.Name))
        throw new Error(`清单声明的主 Task 区域“${region.Name}”在 ${primarySource} 中不存在。`);
    });
    const methodCategories = Array.isArray(manifest.MethodCategories) ? manifest.MethodCategories : [];
    const categoryNames = new Set(methodCategories.map(category => category && category.Name).filter(Boolean));
    methods.forEach(method => {
      if (categoryNames.size && !categoryNames.has(method.Category))
        diagnostics.push(`${method.FilePath} 第 ${method.Line} 行的方法“${method.MethodName}”使用未声明分类“${method.Category}”。`);
    });
    const legacyRuntimeAdapters = files.some(item => /RegisterEquipmentFlowMethods\s*\(/.test(item.Source));

    return {
      Format: FORMAT,
      Version: VERSION,
      FileName: file.name || 'TaskTemplate.zip',
      ManifestPath: manifestPaths[0],
      Template: task,
      PrimarySource: primarySource,
      Files: files,
      Regions: allRegions,
      RegionCatalog: declaredRegions,
      TaskData: validateTaskData(manifest.TaskData),
      MethodCategories: methodCategories,
      Methods: methods,
      HardwareContext: manifest.HardwareContext || null,
      ImportNotes: Array.isArray(manifest.ImportNotes) ? manifest.ImportNotes : [],
      Diagnostics: diagnostics,
      ContainsLegacyRuntimeAdapters: legacyRuntimeAdapters,
    };
  }

  const api = { FORMAT, VERSION, parseFile, extractRegions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EquipmentFlowTaskTemplate = api;
})();
