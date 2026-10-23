(() => {
  'use strict';

  const FORMAT = 'BoTech.EquipmentFlowMethodLibrary';
  const VERSION = 2;
  const host = typeof window !== 'undefined' ? window : globalThis;

  function text(value, label, required = false) {
    const result = value == null ? '' : String(value).trim();
    if (required && !result) throw new Error(`${label}不能为空。`);
    return result;
  }

  function integerList(values, label) {
    if (values == null) return [];
    if (!Array.isArray(values)) throw new Error(`${label}必须是整数数组。`);
    return values.map(value => {
      const result = Number(value);
      if (!Number.isInteger(result)) throw new Error(`${label}必须全部是整数。`);
      return result;
    }).filter((value, index, items) => items.indexOf(value) === index).sort((a, b) => a - b);
  }

  function parseManifest(source) {
    const manifest = typeof source === 'string' ? JSON.parse(source) : source;
    if (!manifest || manifest.format !== FORMAT) throw new Error(`方法库格式不匹配，format 必须为 ${FORMAT}。`);
    const manifestVersion = Number(manifest.schemaVersion);
    if (![1, VERSION].includes(manifestVersion)) throw new Error(`不支持的方法库版本：${manifest.schemaVersion}。`);
    if (!Array.isArray(manifest.methods)) throw new Error('方法库缺少 methods 数组。');
    const seen = new Set();
    const methods = manifest.methods.map((sourceMethod, index) => {
      const label = `methods[${index + 1}]`;
      const method = {
        MethodId: text(sourceMethod.MethodId, `${label}.MethodId`, true),
        DisplayName: text(sourceMethod.DisplayName || sourceMethod.MethodId, `${label}.DisplayName`, true),
        Category: text(sourceMethod.Category || 'General', `${label}.Category`, true),
        SchemaVersion: Number(sourceMethod.SchemaVersion),
        MachineName: text(sourceMethod.MachineName, `${label}.MachineName`),
        StationId: text(sourceMethod.StationId, `${label}.StationId`),
        MethodName: text(sourceMethod.MethodName, `${label}.MethodName`),
        ParameterModelVersion: 2,
        ReturnType: text(sourceMethod.ReturnType, `${label}.ReturnType`),
        NodeType: sourceMethod.ReturnType === 'bool' ? 'Condition' : 'Action',
        Outcomes: [],
        FileName: text(sourceMethod.FileName, `${label}.FileName`),
        Namespace: text(sourceMethod.Namespace, `${label}.Namespace`),
        ClassName: text(sourceMethod.ClassName, `${label}.ClassName`),
        CanBind: sourceMethod.CanBind !== false,
        ContractIssue: text(sourceMethod.ContractIssue, `${label}.ContractIssue`),
        Parameters: [],
        ResultStatusCodes: integerList(sourceMethod.ResultStatusCodes, `${label}.ResultStatusCodes`),
        PendingStatusCodes: integerList(sourceMethod.PendingStatusCodes, `${label}.PendingStatusCodes`),
        AlarmStatusCodes: integerList(sourceMethod.AlarmStatusCodes, `${label}.AlarmStatusCodes`),
      };
      method.Outcomes = method.ReturnType === 'bool' ? ['true', 'false'] : method.ResultStatusCodes.map(String);
      if (method.ReturnType === 'bool' && (method.ResultStatusCodes.length || method.PendingStatusCodes.length || method.AlarmStatusCodes.length))
        throw new Error(`${label} bool 方法使用 true/false 分支，不能声明整数状态码。`);
      if (!Number.isInteger(method.SchemaVersion) || method.SchemaVersion < 1)
        throw new Error(`${label}.SchemaVersion 必须是正整数。`);
      if (method.PendingStatusCodes.length > 1) throw new Error(`${label} 最多只能有一个 PendingStatusCode。`);
      if (method.PendingStatusCodes.some(code => !method.ResultStatusCodes.includes(code)))
        throw new Error(`${label}.PendingStatusCodes 必须同时出现在 ResultStatusCodes 中。`);
      if (method.AlarmStatusCodes.some(code => !method.ResultStatusCodes.includes(code)))
        throw new Error(`${label}.AlarmStatusCodes 必须同时出现在 ResultStatusCodes 中。`);
      const key = JSON.stringify([method.MethodId, method.SchemaVersion, method.MachineName, method.StationId]);
      if (seen.has(key)) throw new Error(`${label} 与方法库中的另一条记录重复。`);
      seen.add(key);
      if (!Array.isArray(sourceMethod.Parameters || [])) throw new Error(`${label}.Parameters 必须是数组。`);
      const parameterNames = new Set();
      method.Parameters = (sourceMethod.Parameters || []).map((sourceParameter, parameterIndex) => {
        const parameterLabel = `${label}.Parameters[${parameterIndex + 1}]`;
        const parameter = {
          Name: text(sourceParameter.Name, `${parameterLabel}.Name`, true),
          FlowName: text(sourceParameter.FlowName || sourceParameter.Name, `${parameterLabel}.FlowName`, true),
          TypeName: text(sourceParameter.TypeName, `${parameterLabel}.TypeName`, true),
          Direction: manifestVersion === 1 && sourceParameter.Direction === 'in' ? 'value'
            : ['value', 'in', 'ref', 'out'].includes(sourceParameter.Direction) ? sourceParameter.Direction : 'value',
          DefaultValue: text(sourceParameter.DefaultValue, `${parameterLabel}.DefaultValue`),
          IsParams: sourceParameter.IsParams === true,
          Required: sourceParameter.Direction !== 'out'
            && !text(sourceParameter.DefaultValue, `${parameterLabel}.DefaultValue`) && sourceParameter.IsParams !== true,
          Minimum: text(sourceParameter.Minimum, `${parameterLabel}.Minimum`),
          Maximum: text(sourceParameter.Maximum, `${parameterLabel}.Maximum`),
          AllowedValues: Array.isArray(sourceParameter.AllowedValues)
            ? sourceParameter.AllowedValues.map(value => String(value)) : [],
        };
        if (parameterNames.has(parameter.Name)) throw new Error(`${label} 参数 ${parameter.Name} 重复。`);
        parameterNames.add(parameter.Name);
        return parameter;
      });
      return method;
    });
    return {
      format: FORMAT,
      schemaVersion: VERSION,
      machineName: text(manifest.machineName, 'machineName'),
      packageName: text(manifest.packageName, 'packageName'),
      packageVersion: text(manifest.packageVersion, 'packageVersion'),
      stations: Array.isArray(manifest.stations) ? manifest.stations.map(item => ({
        StationId: text(item.StationId, 'stations.StationId', true),
        DisplayName: text(item.DisplayName || item.StationId, 'stations.DisplayName', true),
      })) : [],
      hardware: Array.isArray(manifest.hardware) ? manifest.hardware.map(item => ({
        ResourceType: text(item.ResourceType, 'hardware.ResourceType', true),
        Name: text(item.Name, 'hardware.Name', true),
        GroupName: text(item.GroupName, 'hardware.GroupName'),
        Index: text(item.Index, 'hardware.Index'),
        SlotId: item.SlotId == null ? null : Number(item.SlotId),
        Enabled: typeof item.Enabled === 'boolean' ? item.Enabled : null,
      })) : [],
      methods,
    };
  }

  function fromWorkspace(workspace) {
    const methods = (workspace.Methods || []).map(sourceMethod => {
      let parsedParameters = [];
      if (sourceMethod.SourceCode && host.EquipmentFlowCSharpCatalog) {
        try {
          const parsed = host.EquipmentFlowCSharpCatalog.parseSource(
            `partial class __MethodLibrarySignature {\n${sourceMethod.SourceCode}\n}`, '__MethodLibrarySignature.cs');
          parsedParameters = (parsed.classes[0]?.methods || [])
            .find(method => method.MethodName === sourceMethod.MethodName)?.Parameters || [];
        } catch (_) { parsedParameters = []; }
      }
      return {
        ...sourceMethod,
        Parameters: (sourceMethod.Parameters || []).map(parameter => {
          const parsed = parsedParameters.find(item => item.Name === parameter.Name);
          return parsed ? { ...parameter, Direction: parsed.Direction, DefaultValue: parsed.DefaultValue || '', IsParams: Boolean(parsed.IsParams) }
            : { ...parameter, Direction: Number(sourceMethod.ParameterModelVersion) >= 2
              ? parameter.Direction || 'value' : parameter.Direction === 'in' ? 'value' : parameter.Direction || 'value' };
        }),
      };
    });
    return parseManifest({
      format: FORMAT,
      schemaVersion: VERSION,
      machineName: workspace.MachineName,
      packageName: workspace.PackageName,
      packageVersion: workspace.PackageVersion,
      stations: workspace.Stations || [],
      hardware: workspace.Hardware || [],
      methods,
    });
  }

  async function parseFiles(files) {
    const selected = Array.from(files || []);
    if (!selected.length) throw new Error('请选择方法库文件。');
    const csharpFiles = selected.filter(file => String(file.name || '').toLowerCase().endsWith('.cs'));
    if (csharpFiles.length) {
      if (csharpFiles.length !== selected.length)
        throw new Error('一次导入请选择同一类型的文件：多个 `.cs` 文件，或单个 JSON/ZIP 方法库。');
      if (!host.EquipmentFlowCSharpCatalog) throw new Error('C# 元数据解析器尚未加载。');
      const filesWithMetadata = [];
      for (const file of csharpFiles) {
        filesWithMetadata.push(host.EquipmentFlowCSharpCatalog.parseSource(await file.text(), file.name));
      }
      const methods = filesWithMetadata.flatMap(file => file.classes.flatMap(type => type.methods))
        .filter(method => method.MethodId)
        .map(method => ({ ...method, Parameters: method.Parameters.map(parameter => ({ ...parameter })) }));
      const keys = new Set();
      methods.forEach((method, index) => {
        const key = JSON.stringify([method.MethodId, method.SchemaVersion, method.MachineName, method.StationId]);
        if (keys.has(key)) throw new Error(`导入文件中的方法 ID “${method.MethodId}” 与作用域重复。`);
        keys.add(key);
        if (!method.CanBind) method.ImportIssue = `methods[${index + 1}]：${method.ContractIssue}`;
      });
      const machineNames = [...new Set(methods.map(method => method.MachineName).filter(Boolean))];
      const stationMap = new Map();
      methods.forEach(method => {
        if (method.StationId && !stationMap.has(method.StationId))
          stationMap.set(method.StationId, { StationId: method.StationId, DisplayName: method.StationId });
      });
      return {
        format: FORMAT,
        schemaVersion: VERSION,
        machineName: machineNames.length === 1 ? machineNames[0] : '',
        packageName: csharpFiles.length === 1 ? csharpFiles[0].name.replace(/\.cs$/i, '') : 'StationMethods',
        packageVersion: '1.0.0',
        stations: Array.from(stationMap.values()),
        hardware: [],
        methods,
        files: filesWithMetadata,
        diagnostics: filesWithMetadata.flatMap(file => file.diagnostics || []),
        sourceKind: 'CSharp',
      };
    }
    if (selected.length !== 1) throw new Error('JSON 或 ZIP 方法库请单独选择一个文件。');
    const library = await parseFile(selected[0]);
    return { ...library, files: [], sourceKind: 'Manifest' };
  }

  function stringify(workspace) {
    return JSON.stringify(fromWorkspace(workspace), null, 2) + '\n';
  }

  function resolveMethodSelection(methods, value) {
    let identity;
    try { identity = JSON.parse(value); } catch (_) { identity = null; }
    if (Array.isArray(identity) && identity.length === 4) {
      return (methods || []).find(method => method.MethodId === identity[0]
        && Number(method.SchemaVersion) === Number(identity[1])
        && String(method.MachineName || '') === String(identity[2] || '')
        && String(method.StationId || '') === String(identity[3] || '')) || null;
    }
    if (Array.isArray(identity) && identity.length === 2) {
      return (methods || []).find(method => method.MethodId === identity[0]
        && Number(method.SchemaVersion) === Number(identity[1])) || null;
    }
    return (methods || []).find(method => method.MethodId === value) || null;
  }

  function methodSelectionValue(method) {
    return JSON.stringify([method.MethodId, Number(method.SchemaVersion) || 0,
      String(method.MachineName || ''), String(method.StationId || '')]);
  }

  function isAlarmMethod(method) {
    return Boolean(method && method.MethodId === 'Station.EnterAlarm');
  }

  async function parseFile(file) {
    if (!file) throw new Error('未选择方法库文件。');
    const name = String(file.name || '').toLowerCase();
    if (name.endsWith('.cs')) return parseFiles([file]);
    if (name.endsWith('.zip')) {
      if (!host.FlowArchive) throw new Error('ZIP 解包模块尚未加载。');
      const files = await host.FlowArchive.readEntries(await file.arrayBuffer());
      const manifestEntry = Array.from(files.entries()).find(([path]) => {
        const leaf = path.split('/').pop().toLowerCase();
        return leaf === 'method-library.json' || leaf === 'manifest.json';
      });
      if (!manifestEntry) throw new Error('方法库 ZIP 中未找到 method-library.json 或 manifest.json。');
      return parseManifest(new TextDecoder('utf-8').decode(manifestEntry[1]));
    }
    if (!name.endsWith('.json')) throw new Error('方法库请使用 .cs、.json 或包含清单文件的 .zip。');
    return parseManifest(await file.text());
  }

  const api = { FORMAT, VERSION, parseManifest, parseFile, parseFiles, fromWorkspace, stringify,
    resolveMethodSelection, methodSelectionValue, isAlarmMethod };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EquipmentFlowMethodLibrary = api;
})();
