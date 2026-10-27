(() => {
  'use strict';

  const FLOW_STATUS_CODES_ATTRIBUTE_NAMESPACE = 'BoTech.EquipmentFlow.Metadata';

  const KEYWORDS = new Set(('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while async await').split(' '));

  // Task identity and template helpers used by all three generated partial classes.
  function validIdentifier(value) {
    return typeof value === 'string' && /^[_\p{L}][\p{L}\p{N}_]*$/u.test(value) && !KEYWORDS.has(value);
  }

  function safeName(value) {
    return String(value || 'Task').replace(/[^\p{L}\p{N}_]/gu, '_').replace(/^([^_\p{L}])/u, '_$1') || 'Task';
  }

  function createBlankTask(name) {
    if (!validIdentifier(name)) throw new Error('Task 名称必须是有效的 C# 类名，且不能使用关键字。');
    return {
      TaskId: `${name}_${Date.now().toString(36)}`,
      Name: name,
      ClassName: name,
      Namespace: 'BoTech',
      BaseType: 'TaskBase_MoverStation',
      AccessModifier: 'public',
      ClassModifier: '',
      PrimarySource: '',
      TemplateFiles: [],
      MethodCategories: [{ Name: 'Common', RegionName: 'Common', Order: 0 }],
      MethodVariables: [],
      CreatedFromTemplate: false,
    };
  }

  function defaultFlow(task) {
    const startId = 'N001';
    const endId = 'N002';
    return {
      FlowId: `${task.ClassName}_AutoRun`,
      StationId: task.TaskId,
      TaskName: task.ClassName,
      EntryNodeId: startId,
      Nodes: [
        { NodeId: startId, NodeType: 'Start', DisplayName: '开始', MethodId: '', MethodSchemaVersion: 0, Parameters: [] },
        { NodeId: endId, NodeType: 'End', DisplayName: '结束', MethodId: '', MethodSchemaVersion: 0, Parameters: [] },
      ],
      Transitions: [{ FromNodeId: startId, Outcome: '*', ToNodeId: endId, Priority: 1 }],
    };
  }

  function indent(source, spaces = 8) {
    const padding = ' '.repeat(spaces);
    return String(source || '').split(/\r?\n/).map(line => line ? padding + line : '').join('\r\n');
  }

  function methodSignature(method) {
    const parameters = (method.Parameters || []).map(parameter => {
      const direction = ['in', 'ref', 'out'].includes(parameter.Direction) ? `${parameter.Direction} ` : '';
      const params = parameter.IsParams ? 'params ' : '';
      const defaultValue = String(parameter.DefaultValue || '').trim();
      return `${params}${direction}${parameter.TypeName || 'object'} ${parameter.Name || 'value'}${defaultValue ? ` = ${defaultValue}` : ''}`;
    });
    const modifier = String(method.MethodModifier || (method.Modifiers || []).filter(value => ['override', 'abstract', 'virtual'].includes(value)).join(' ')).trim();
    return `${method.AccessModifier || 'private'}${modifier ? ` ${modifier}` : ''} ${method.ReturnType || 'void'} ${method.MethodName}(${parameters.join(', ')})`;
  }

  function methodSource(method) {
    if (method.PreserveSource && method.SourceCode) return String(method.SourceCode).trim();
    const signature = methodSignature(method);
    const body = String(method.BodyText || '').trim() || (method.Parameters || [])
      .filter(parameter => parameter.Direction === 'out')
      .map(parameter => `${parameter.Name} = default(${parameter.TypeName || 'object'});`).join('\r\n');
    const attributes = String(method.AttributeSource || '').trim();
    const summary = String(method.DocumentationSummary || '').trim();
    const xmlEscape = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const docs = summary ? [
      '/// <summary>',
      `/// ${xmlEscape(summary)}`,
      '/// </summary>',
      ...(method.Parameters || []).map(parameter => `/// <param name="${parameter.Name}">${xmlEscape(['out', 'ref'].includes(parameter.Direction) ? `输入/输出：${parameter.Name}` : parameter.Direction === 'in' ? `只读输入：${parameter.Name}` : parameter.Name)}</param>`),
      ...(method.ReturnType && method.ReturnType !== 'void' ? ['/// <returns>方法返回结果</returns>'] : []),
    ].join('\r\n') + '\r\n' : '';
    if (String(method.MethodModifier || (method.Modifiers || []).join(' ')).split(/\s+/).includes('abstract'))
      return `${docs}${attributes ? attributes + '\r\n' : ''}${signature};`;
    return `${docs}${attributes ? attributes + '\r\n' : ''}${signature}\r\n{\r\n${body ? indent(body, 4) + '\r\n' : ''}}`;
  }

  function safeRegion(value) {
    const region = String(value || '未分类').replace(/[\r\n]/g, ' ').replace(/#(?:end)?region/gi, '').trim();
    return region || '未分类';
  }

  function taskVariableLiteral(task, variable, type) {
    const value = String(variable.InitialValue == null ? '' : variable.InitialValue).trim();
    const ownerName = task.ClassName || task.Name || 'Task';
    const invalid = () => { throw new Error(`${ownerName} 的变量「${variable.Name}」初始值「${value}」不是有效的 ${type} 值。`); };
    if (type === 'string') return JSON.stringify(String(variable.InitialValue == null ? '' : variable.InitialValue))
      .replace(/\u0085/g, '\\u0085').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    if (type === 'bool') {
      if (!/^(true|false)$/i.test(value)) invalid();
      return value.toLowerCase();
    }
    if (type === 'int' || type === 'long') {
      if (!/^[+-]?\d+$/.test(value)) invalid();
      const number = BigInt(value);
      const min = type === 'int' ? -2147483648n : -9223372036854775808n;
      const max = type === 'int' ? 2147483647n : 9223372036854775807n;
      if (number < min || number > max) invalid();
      if (number === min) return `${type}.MinValue`;
      return `${number}${type === 'long' ? 'L' : ''}`;
    }
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) invalid();
    const number = Number(value);
    if (!Number.isFinite(number) || (number === 0 && /[1-9]/.test(value.replace(/[eE].*$/, '')))) invalid();
    const normalized = value.replace(/\.(?=[eE]|$)/, '.0');
    if (type === 'float') {
      if (Math.abs(number) > 3.402823466e38 || (number !== 0 && Math.abs(number) < 1.401298464e-45)) invalid();
      return `${normalized}f`;
    }
    if (type === 'double') return `${normalized}d`;
    if (/[eE]/.test(value)) invalid();
    const unsigned = value.replace(/^[+-]/, '');
    const [whole, rawFraction = ''] = unsigned.split('.');
    const fraction = rawFraction.replace(/0+$/, '');
    const mantissa = BigInt((whole || '0') + fraction);
    const max = 79228162514264337593543950335n;
    if (fraction.length > 28 || mantissa > max) invalid();
    const sign = value.startsWith('-') && mantissa !== 0n ? '-' : '';
    return `${sign}${BigInt(whole || '0')}${fraction ? '.' + fraction : ''}m`;
  }

  function taskTypeDeclaration(task) {
    const access = task.AccessModifier === 'internal' ? 'internal' : 'public';
    const modifier = task.ClassModifier === 'abstract' || task.ClassModifier === 'sealed' ? task.ClassModifier : '';
    return access + ' ' + (modifier ? modifier + ' ' : '') + 'partial class ' + task.ClassName;
  }

  function findTopLevelComma(value) {
    let angleDepth = 0, parenDepth = 0, bracketDepth = 0;
    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      if (character === '<') angleDepth += 1;
      else if (character === '>') angleDepth = Math.max(0, angleDepth - 1);
      else if (character === '(') parenDepth += 1;
      else if (character === ')') parenDepth = Math.max(0, parenDepth - 1);
      else if (character === '[') bracketDepth += 1;
      else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1);
      else if (character === ',' && angleDepth === 0 && parenDepth === 0 && bracketDepth === 0) return index;
    }
    return -1;
  }

  function replaceTaskBaseType(suffix, baseType, sourceBaseType) {
    const requestedBase = String(baseType || '').trim();
    const whereIndex = suffix.search(/\bwhere\b/);
    const inheritanceEnd = whereIndex >= 0 ? whereIndex : suffix.length;
    const colonIndex = suffix.indexOf(':');
    if (colonIndex >= 0 && colonIndex < inheritanceEnd) {
      const baseList = suffix.slice(colonIndex + 1, inheritanceEnd);
      const commaIndex = findTopLevelComma(baseList);
      const sourceHadBase = Boolean(String(sourceBaseType || '').trim());
      const interfaces = sourceHadBase
        ? (commaIndex >= 0 ? baseList.slice(commaIndex + 1).trim() : '')
        : baseList.trim();
      const prefix = suffix.slice(0, colonIndex).replace(/\s+$/, '');
      const constraints = suffix.slice(inheritanceEnd).trim();
      const constraintSuffix = constraints ? ` ${constraints}` : '';
      if (!sourceHadBase) {
        if (!requestedBase) return suffix;
        return prefix + ` : ${requestedBase}` + (interfaces ? `, ${interfaces}` : '') + constraintSuffix;
      }
      if (!requestedBase) return prefix + (interfaces ? ` : ${interfaces}` : '') + constraintSuffix;
      return prefix + ` : ${requestedBase}` + (interfaces ? `, ${interfaces}` : '') + constraintSuffix;
    }
    if (!requestedBase) return suffix;
    const insertionIndex = whereIndex >= 0 ? whereIndex : suffix.length;
    const beforeConstraints = suffix.slice(0, insertionIndex).replace(/\s+$/, '');
    return beforeConstraints + ' : ' + requestedBase + suffix.slice(insertionIndex);
  }

  function synchronizeTaskTypeDeclaration(source, type, task) {
    if (!type || !Number.isInteger(type.DeclarationStart) || !Number.isInteger(type.HeaderEnd)) return source;
    const header = source.slice(type.DeclarationStart, type.HeaderEnd);
    const declaration = new RegExp('^\\s*(?:(?:public|protected|internal|private|abstract|sealed|static|partial|file|unsafe|new)\\s+)*class\\s+' + type.name + '\\b([\\s\\S]*)$');
    const match = declaration.exec(header);
    if (!match) return source;
    const sourceBaseType = task.SourceBaseType == null ? task.BaseType : task.SourceBaseType;
    const updatedHeader = taskTypeDeclaration(task) + replaceTaskBaseType(match[1], task.BaseType, sourceBaseType);
    return source.slice(0, type.DeclarationStart) + updatedHeader + source.slice(type.HeaderEnd);
  }

  function templateResiduals(task) {
    const files = task.TemplateFiles || [];
    const imports = new Set();
    let primaryResidual = '';
    const additionalResiduals = [];
    files.forEach(file => {
      const source = String(file.Source || '');
      source.split(/\r?\n/).forEach(line => {
        if (/^\s*using\s+(?:static\s+)?[\w.]+(?:\s*=\s*[\w.]+)?\s*;\s*$/.test(line)) imports.add(line.trim());
      });
      const parsed = window.EquipmentFlowCSharpCatalog.parseSource(source, file.Path || `${task.ClassName}.cs`);
      const type = parsed.classes.find(item => item.name === task.ClassName && item.namespace === (task.Namespace || 'BoTech'));
      if (!type) return;
      let residual = source.slice(type.BodyStart, type.BodyEnd);
      type.methods.map(method => ({ start: method.SourceStart, end: method.SourceEnd }))
        .filter(method => Number.isInteger(method.start) && Number.isInteger(method.end))
        .sort((left, right) => right.start - left.start)
        .forEach(method => {
          const start = method.start - type.BodyStart;
          const end = method.end - type.BodyStart;
          residual = residual.slice(0, start) + residual.slice(end);
        });
      residual = removeEnumDeclaration(residual, 'Step');
      if (file.Path === task.TemplatePrimaryPath) primaryResidual = residual;
      else if (residual.trim()) additionalResiduals.push(residual.trim());
    });
    return { imports: Array.from(imports), primaryResidual, additionalResiduals };
  }

  function mergeUsings(source, imports) {
    const existing = new Set(Array.from(source.matchAll(/^\s*using\s+(?:static\s+)?[\w.]+(?:\s*=\s*[\w.]+)?\s*;\s*$/gm), match => match[0].trim()));
    const missing = (imports || []).filter(item => !existing.has(item));
    if (!missing.length) return source;
    const namespaceIndex = source.search(/^\s*namespace\s+/m);
    if (namespaceIndex >= 0) return `${source.slice(0, namespaceIndex)}${missing.join('\r\n')}\r\n${source.slice(namespaceIndex)}`;
    return `${missing.join('\r\n')}\r\n${source}`;
  }

  function taskMemberVariableSource(task, variable) {
    const name = String(variable.Name || '').trim();
    if (!validIdentifier(name)) throw new Error(`${task.ClassName} 的变量名「${name}」不是有效的 C# 标识符。`);
    if (name.toLowerCase() === String(task.ClassName || '').toLowerCase())
      throw new Error(`${task.ClassName} 的变量「${name}」与类名相同，请修改名称。`);
    const type = String(variable.Type || '').toLowerCase();
    if (!['bool', 'int', 'string', 'long', 'float', 'double', 'decimal'].includes(type))
      throw new Error(`${task.ClassName} 的变量「${name}」类型「${variable.Type}」不受支持。`);
    const kind = String(variable.MemberKind || 'field').toLowerCase();
    if (kind !== 'field' && kind !== 'property')
      throw new Error(`${task.ClassName} 的变量「${name}」成员类型「${variable.MemberKind}」无效。`);
    const access = ['public', 'protected internal', 'protected', 'internal', 'private protected', 'private'].includes(variable.AccessModifier)
      ? variable.AccessModifier : 'public';
    const modifiers = (Array.isArray(variable.Modifiers) ? variable.Modifiers : [])
      .filter(modifier => ['static', 'readonly', 'volatile', 'const', 'new', 'required'].includes(modifier));
    const modifierText = modifiers.length ? modifiers.join(' ') + ' ' : '';
    const initializer = variable.HasInitialValue
      ? ` = ${String(variable.InitializerSource || '').trim() || taskVariableLiteral(task, variable, type)}` : '';
    const accessors = String(variable.AccessorSource || '').trim();
    return kind === 'field'
      ? `${access} ${modifierText}${type} ${name}${initializer};`
      : `${access} ${modifierText}${type} ${name} { ${accessors || 'get; set;'} }${initializer}${initializer ? ';' : ''}`;
  }

  // Methods partial: preserve source and group generated members by their Task category.
  function methodsSource(task, methods) {
    const items = (methods || []).filter(method => method.MethodName !== 'AutoRun' && (!method.TaskId || method.TaskId === task.TaskId));
    const categories = [];
    const grouped = new Map();
    const methodCategories = (task.MethodCategories || []).slice().sort((left, right) => {
      const leftName = typeof left === 'string' ? left : left && (left.Name || left.RegionName) || '';
      const rightName = typeof right === 'string' ? right : right && (right.Name || right.RegionName) || '';
      return (Number(left && left.Order) || 0) - (Number(right && right.Order) || 0);
    });
    methodCategories.forEach(item => {
      const categoryName = typeof item === 'string' ? item : item && (item.Name || item.RegionName);
      const category = categoryName && safeRegion(categoryName);
      if (category && !categories.some(name => name.toLowerCase() === category.toLowerCase())) { grouped.set(category, []); categories.push(category); }
    });
    const memberNames = new Set(['autorun', String(task.ClassName || '').toLowerCase(), ...items.map(method => String(method.MethodName || '').toLowerCase())]);
    (Array.isArray(task.MethodVariables) ? task.MethodVariables : []).forEach(variable => {
      const name = String(variable.Name || '').trim();
      const key = name.toLowerCase();
      if (memberNames.has(key)) throw new Error(`${task.ClassName} 的自定义变量「${name}」与 Task 成员或方法重名。`);
      memberNames.add(key);
      const requestedRegion = safeRegion(variable.RegionName || variable.Region || categories[0] || 'Common');
      const registered = categories.find(name => name.toLowerCase() === requestedRegion.toLowerCase()) || requestedRegion;
      if (!grouped.has(registered)) { grouped.set(registered, []); categories.push(registered); }
      grouped.get(registered).push(taskMemberVariableSource(task, variable));
    });
    items.forEach(method => {
      const category = safeRegion(method.Category);
      const registered = categories.find(name => name.toLowerCase() === category.toLowerCase()) || category;
      if (!grouped.has(registered)) { grouped.set(registered, []); categories.push(registered); }
      grouped.get(registered).push(methodSource(method));
    });
    const declarations = categories.map(category =>
      `    #region ${category}\r\n${grouped.get(category).map(member => indent(member, 8)).join('\r\n\r\n')}\r\n    #endregion`);
    return `using System;\r\n\r\nnamespace ${task.Namespace || 'BoTech'}\r\n{\r\n    ${taskTypeDeclaration(task)}\r\n    {\r\n${declarations.length ? declarations.join('\r\n\r\n') + '\r\n' : ''}    }\r\n}\r\n`;
  }

  // AutoRun partial: turn the validated node graph into a resumable switch-based state machine.
  function fieldName(nodeId, parameterName) {
    return `__WebUiFlow_${safeName(nodeId)}_${safeName(parameterName)}`;
  }

  function outputParameterName(method, sourceName) {
    const output = (method && method.Parameters || []).find(parameter =>
      ['out', 'ref'].includes(parameter.Direction)
      && (parameter.Name === sourceName || parameter.FlowName === sourceName));
    return output ? output.Name : sourceName;
  }

  function csharpLiteral(value, type, defaultValue = '') {
    const text = String(value == null ? '' : value).trim();
    if (text) return text;
    const fallback = String(defaultValue == null ? '' : defaultValue).trim();
    if (fallback) return fallback;
    return `default(${type || 'object'})`;
  }

  function removeEnumDeclaration(source, enumName) {
    let result = String(source || '');
    const declaration = new RegExp(`^[\\t ]*(?:(?:public|protected|private|internal|new)\\s+)*enum\\s+${enumName}\\b`, 'gm');
    let match;
    while ((match = declaration.exec(result))) {
      const open = result.indexOf('{', match.index + match[0].length);
      if (open < 0) continue;
      let depth = 0;
      let close = -1;
      let quote = '';
      let verbatimString = false;
      let rawQuoteLength = 0;
      let lineComment = false;
      let blockComment = false;
      for (let index = open; index < result.length; index += 1) {
        const character = result[index];
        const next = result[index + 1];
        if (lineComment) {
          if (character === '\n') lineComment = false;
          continue;
        }
        if (blockComment) {
          if (character === '*' && next === '/') { blockComment = false; index += 1; }
          continue;
        }
        if (rawQuoteLength) {
          if (character === '"') {
            let count = 1;
            while (result[index + count] === '"') count += 1;
            if (count >= rawQuoteLength) { index += rawQuoteLength - 1; rawQuoteLength = 0; quote = ''; }
          }
          continue;
        }
        if (quote) {
          if (character === '\\') { index += 1; continue; }
          if (character === quote) {
            if (verbatimString && quote === '"' && result[index + 1] === '"') { index += 1; continue; }
            quote = '';
            verbatimString = false;
          }
          continue;
        }
        if (character === '/' && next === '/') { lineComment = true; index += 1; continue; }
        if (character === '/' && next === '*') { blockComment = true; index += 1; continue; }
        if (character === '"') {
          let count = 1;
          while (result[index + count] === '"') count += 1;
          if (count >= 3) { quote = '"'; rawQuoteLength = count; index += count - 1; }
          else { quote = '"'; verbatimString = result[index - 1] === '@'; }
          continue;
        }
        if (character === "'") { quote = "'"; continue; }
        if (character === '{') depth += 1;
        else if (character === '}' && --depth === 0) { close = index; break; }
      }
      if (close < 0) continue;
      const start = match.index;
      let end = close + 1;
      if (result[end] === ';') end += 1;
      while (result[end] === ' ' || result[end] === '\t') end += 1;
      if (result[end] === '\r') end += 1;
      if (result[end] === '\n') end += 1;
      result = result.slice(0, start) + result.slice(end);
      declaration.lastIndex = Math.max(0, start - 1);
    }
    return result;
  }

  function flowStepNames(nodes, transitions, entryNodeId) {
    const byId = new Map((nodes || []).map(node => [node.NodeId, node]));
    const outgoing = new Map((nodes || []).map(node => [node.NodeId, []]));
    (transitions || []).forEach(edge => {
      if (outgoing.has(edge.FromNodeId) && byId.has(edge.ToNodeId)) outgoing.get(edge.FromNodeId).push(edge);
    });
    outgoing.forEach(edges => edges.sort((left, right) => Number(left.Priority || 0) - Number(right.Priority || 0)));
    const ordered = [];
    const visited = new Set();
    const visit = nodeId => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = byId.get(nodeId);
      if (!node) return;
      if (!['Start', 'End'].includes(node.NodeType)) ordered.push(node);
      (outgoing.get(nodeId) || []).forEach(edge => visit(edge.ToNodeId));
    };
    visit(entryNodeId);
    (nodes || []).forEach(node => visit(node.NodeId));
    const usedNames = new Set();
    const stepsById = new Map();
    let nextActionValue = 10;
    ordered.forEach((node, index) => {
      const displayName = String(node.DisplayName || node.NodeId || `Step${index + 1}`).replace(/[\r\n]+/g, ' ').trim();
      const base = safeName(displayName) || `Step${index + 1}`;
      let name = KEYWORDS.has(base) ? `_${base}` : base;
      let suffix = 2;
      while (usedNames.has(name)) name = `${base}_${suffix++}`;
      usedNames.add(name);
      const value = node.NodeType === 'Alarm' ? 9999 : nextActionValue;
      if (node.NodeType !== 'Alarm') nextActionValue += 10;
      stepsById.set(node.NodeId, { Name: name, Value: value, DisplayName: displayName });
    });
    return { ordered, byId: stepsById };
  }

  function generateFlowMembers(flow, methods, task) {
    const nodes = flow && flow.Nodes || [];
    const transitions = flow && flow.Transitions || [];
    const nodeById = new Map(nodes.map(node => [node.NodeId, node]));
    const entryNodeId = nodes.some(node => node.NodeId === (flow && flow.EntryNodeId))
      ? flow.EntryNodeId : (nodes[0] && nodes[0].NodeId);
    const steps = flowStepNames(nodes, transitions, entryNodeId);
    const transitionLines = (targetNodeId, indentation) => {
      const target = nodeById.get(targetNodeId);
      if (!target) return [];
      if (target.NodeType === 'End') return [`${indentation}SetStep(ref StaInfo, 0, true);`];
      const targetStep = steps.byId.get(targetNodeId);
      return targetStep ? [`${indentation}SetStep(ref StaInfo, Step.${targetStep.Name}, true);`] : [];
    };
    const methodById = new Map((methods || []).filter(method => method.MethodName !== 'AutoRun').map(method => [method.MethodId, method]));
    const outputFields = [];
    nodes.forEach(node => {
      const method = methodById.get(node.MethodId);
      (method && method.Parameters || []).filter(parameter => parameter.Direction === 'out' || parameter.Direction === 'ref').forEach(parameter => {
        outputFields.push(`        private ${parameter.TypeName || 'object'} ${fieldName(node.NodeId, parameter.Name)};`);
      });
    });
    const uniqueFields = Array.from(new Set(outputFields));
    const lines = [
      `        protected ${/\bTaskBase_MoverStation\s*$/.test(String(task.BaseType || '')) ? 'new ' : ''}enum Step`,
      '        {',
      ...steps.ordered.map(node => {
        const step = steps.byId.get(node.NodeId);
        return `            ${step.Name} = ${step.Value}, // ${step.DisplayName}`;
      }),
      '        }',
      '',
      ...uniqueFields,
      '',
      '        // Generated from the flow canvas.',
      `        public ${String(task.BaseType || '').trim() ? 'override ' : ''}void AutoRun()`,
      '        {',
      '            switch (StaInfo.StepIdx)',
      '            {',
    ];

    const emittedStateValues = new Set();
    steps.ordered.forEach(node => {
      const outgoing = transitions.filter(edge => edge.FromNodeId === node.NodeId).sort((a, b) => Number(a.Priority || 0) - Number(b.Priority || 0));
      const method = methodById.get(node.MethodId);
      const currentStep = steps.byId.get(node.NodeId);
      if (emittedStateValues.has(currentStep.Value)) {
        return;
      }
      emittedStateValues.add(currentStep.Value);
      lines.push(`                case (int)Step.${currentStep.Name}: // ${node.NodeId}: ${currentStep.DisplayName}`);
      if (!method) {
        const next = outgoing.find(edge => edge.Outcome === '*') || outgoing[0];
        if (next) lines.push(...transitionLines(next.ToNodeId, '                    '));
        lines.push('                    break;');
      } else {
        const args = (method.Parameters || []).map((parameter, parameterIndex) => {
          if (parameter.Direction === 'out') return `out ${fieldName(node.NodeId, parameter.Name)}`;
          const binding = (node.Parameters || []).find(item => item.Name === parameter.Name);
          if (parameter.IsParams && !(binding && binding.SourceNodeId) && !String(binding && binding.Value || '').trim()) return '';
          const sourceNode = binding && nodeById.get(binding.SourceNodeId);
          const sourceMethod = sourceNode && methodById.get(sourceNode.MethodId);
          const sourceName = binding && outputParameterName(sourceMethod, binding.SourceParameterName || parameter.Name);
          const value = binding && binding.SourceNodeId
            ? fieldName(binding.SourceNodeId, sourceName)
            : csharpLiteral(binding && binding.Value, parameter.TypeName, parameter.DefaultValue);
          if (parameter.Direction === 'ref') {
            const field = fieldName(node.NodeId, parameter.Name);
            lines.push(`                    ${field} = ${value};`);
            return `ref ${field}`;
          }
          if (parameter.Direction === 'in') {
            const local = `__WebUiFlowIn_${safeName(node.NodeId)}_${parameterIndex}_${safeName(parameter.Name)}`;
            lines.push(`                    ${parameter.TypeName || 'object'} ${local} = ${value};`);
            return `in ${local}`;
          }
          return value;
        }).filter(Boolean).join(', ');
        const call = `this.${method.MethodName}(${args})`;
        if (method.ReturnType === 'void') {
          lines.push(`                    ${call};`);
          const next = outgoing.find(edge => edge.Outcome === '*') || outgoing[0];
          if (next) lines.push(...transitionLines(next.ToNodeId, '                    '));
          lines.push('                    break;');
        } else if (method.ReturnType === 'bool') {
          lines.push(`                    switch (${call})`, '                    {');
          ['true', 'false'].forEach(outcome => {
            const edge = outgoing.find(item => String(item.Outcome).toLowerCase() === outcome);
            if (edge) lines.push(`                        case ${outcome}: ${transitionLines(edge.ToNodeId, '').join(' ').trim()} break;`);
          });
          const fallback = outgoing.find(edge => edge.Outcome === '*');
          if (fallback) lines.push(`                        default: ${transitionLines(fallback.ToNodeId, '').join(' ').trim()} break;`, '                    }', '                    break;');
          else lines.push('                        default: break;', '                    }', '                    break;');
        } else if (method.ReturnType === 'int') {
          lines.push(`                    switch (${call})`, '                    {');
          const usedStatuses = new Set();
          (method.PendingStatusCodes || []).map(String).forEach(code => {
            if (!/^-?\d+$/.test(code)) return;
            const status = Number(code);
            if (usedStatuses.has(status)) return;
            usedStatuses.add(status);
            lines.push(`                        case ${status}: break;`);
          });
          outgoing.forEach(edge => {
            const outcome = String(edge.Outcome).trim();
            if (!/^-?\d+$/.test(outcome) || !nodeById.has(edge.ToNodeId)) return;
            const status = Number(outcome);
            if (usedStatuses.has(status)) return;
            usedStatuses.add(status);
            lines.push(`                        case ${status}: ${transitionLines(edge.ToNodeId, '').join(' ').trim()} break;`);
          });
          const fallback = outgoing.find(edge => edge.Outcome === '*');
          if (fallback) lines.push(`                        default: ${transitionLines(fallback.ToNodeId, '').join(' ').trim()} break;`);
          else lines.push('                        default: break;');
          lines.push('                    }', '                    break;');
        } else {
          lines.push(`                    ${call};`);
          const next = outgoing.find(edge => edge.Outcome === '*') || outgoing[0];
          if (next) lines.push(...transitionLines(next.ToNodeId, '                    '));
          lines.push('                    break;');
        }
      }
    });
    lines.push('                default:', '                    break;', '            }', '        }');
    return lines.join('\r\n');
  }

  function generatedPrimarySource(task, flow, methods) {
    const hasExecutableFlow = Boolean(flow && (flow.Nodes || []).some(node => node && !['Start', 'End'].includes(node.NodeType)));
    const members = hasExecutableFlow ? generateFlowMembers(flow, methods, task) : '';
    const template = templateResiduals(task);
    const marker = '    #region WebUI Auto Flow';
    const dataBlock = template.additionalResiduals.length
      ? `    #region Task Template Members\r\n${indent(template.additionalResiduals.join('\r\n\r\n'), 8)}\r\n    #endregion\r\n\r\n`
      : '';
    const flowBlock = members ? `${marker}\r\n${indent(members, 4)}\r\n    #endregion` : '';
    const block = [dataBlock.trimEnd(), flowBlock].filter(Boolean).join('\r\n\r\n');
    const methodUsings = Array.from(new Set((methods || []).filter(method => !method.TaskId || method.TaskId === task.TaskId)
      .flatMap(method => method.ImportedUsings || [])));
    let source = String(task.PrimarySource || '').trim();
    if (!source) {
      const baseType = String(task.BaseType || '').trim();
      source = `using System;\r\n\r\nnamespace ${task.Namespace || 'BoTech'}\r\n{\r\n    ${taskTypeDeclaration(task)}${baseType ? ` : ${baseType}` : ''}\r\n    {\r\n    }\r\n}\r\n`;
    } else {
      const primary = (task.TemplateFiles || []).find(file => file.Path === task.TemplatePrimaryPath);
      if (primary) {
        const parsedPrimary = window.EquipmentFlowCSharpCatalog.parseSource(source, primary.Path);
        const primaryType = parsedPrimary.classes.find(item => item.name === task.ClassName && item.namespace === (task.Namespace || 'BoTech'));
        if (primaryType) {
          source = synchronizeTaskTypeDeclaration(source, primaryType, task);
          const synchronizedPrimary = window.EquipmentFlowCSharpCatalog.parseSource(source, primary.Path);
          const synchronizedType = synchronizedPrimary.classes.find(item => item.name === task.ClassName && item.namespace === (task.Namespace || 'BoTech'));
          if (!synchronizedType) throw new Error(`Task 主源码中的 ${task.Namespace || 'BoTech'}.${task.ClassName} 声明无法同步。`);
          primaryType.BodyStart = synchronizedType.BodyStart;
          primaryType.BodyEnd = synchronizedType.BodyEnd;
          primaryType.methods = synchronizedType.methods;
          let body = source.slice(primaryType.BodyStart, primaryType.BodyEnd);
          primaryType.methods.map(method => ({ start: method.SourceStart, end: method.SourceEnd }))
            .filter(method => Number.isInteger(method.start) && Number.isInteger(method.end))
            .sort((left, right) => right.start - left.start)
            .forEach(method => {
              const start = method.start - primaryType.BodyStart;
              const end = method.end - primaryType.BodyStart;
              body = body.slice(0, start) + body.slice(end);
            });
          body = removeEnumDeclaration(body, 'Step');
          source = source.slice(0, primaryType.BodyStart) + body + source.slice(primaryType.BodyEnd);
        }
      }
    }
    source = mergeUsings(source, [...template.imports, ...methodUsings]);
    const priorStart = source.indexOf(marker);
    if (priorStart >= 0) {
      const priorEnd = source.indexOf('    #endregion', priorStart);
      if (priorEnd >= 0) source = source.slice(0, priorStart) + source.slice(priorEnd + '    #endregion'.length);
    }
    const parsed = window.EquipmentFlowCSharpCatalog.parseSource(source, `${task.ClassName}.cs`);
    const type = parsed.classes.find(item => item.name === task.ClassName && item.namespace === (task.Namespace || 'BoTech'));
    if (!type) throw new Error(`Task 主源码中未找到 ${task.Namespace || 'BoTech'}.${task.ClassName}。`);
    if (!block) return source;
    return source.slice(0, type.BodyEnd) + '\r\n\r\n' + block + '\r\n' + source.slice(type.BodyEnd);
  }

  const HARDWARE_REGION_ORDER = [
    ['Nozzle', '吸嘴'], ['Axis', '轴'], ['Sensor', '传感器'], ['Cylinder', '气缸'],
    ['Temperature', '温度'], ['Pressure', '压力'], ['Vacuum', '真空吸'],
  ];

  // Hardware partial: emit Task-scoped classes and bind their slots to enum members.
  function hardwareSource(task, definitions, enumNamespace = 'ParName', enumResources = null) {
    const items = (definitions || []).filter(item => item.TaskId === task.TaskId);
    const namespace = String(enumNamespace || 'ParName').trim() || 'ParName';
    if (!namespace.split('.').every(validIdentifier)) throw new Error(`EnumName 命名空间「${namespace}」无效。`);
    const names = new Set();
    items.forEach(item => {
      if (!validIdentifier(item.Name)) throw new Error(`硬件类名「${item.Name}」不是有效的 C# 标识符。`);
      if (names.has(item.Name.toLowerCase())) throw new Error(`当前 Task 中硬件类名 ${item.Name} 重复。`);
      if (item.Name === task.ClassName) throw new Error(`硬件类名 ${item.Name} 与 Task 类名冲突。`);
      names.add(item.Name.toLowerCase());
    });
    const defaultEnumType = { axis: 'mAxis', input: 'InNo', output: 'OutNo' };
    const slotsFor = owner => {
      if (Array.isArray(owner.Slots) && owner.Slots.length) return owner.Slots;
      return (owner.Parts || []).flatMap(part => part.Slots || []);
    };
    const resolveSlot = (item, slot, ownerName) => {
      let binding = slot.Binding || {};
      if ((binding.ResourceKey || binding.MemberName) && Array.isArray(enumResources)) {
        const matches = binding.ResourceKey
          ? enumResources.filter(resource => resource.ResourceKey === binding.ResourceKey)
          : enumResources.filter(resource => resource.Category === slot.Category
            && resource.MemberName === binding.MemberName
            && (!binding.EnumTypeName || resource.EnumTypeName === binding.EnumTypeName));
        if (matches.length !== 1) {
          const detail = matches.length ? '绑定资源不唯一' : '绑定资源已从工程枚举表中移除';
          throw new Error(`${task.ClassName}.${ownerName}.${slot.DisplayName || slot.PropertyName}：${detail}，请重新绑定。`);
        }
        const resource = matches[0];
        if (resource.Category !== slot.Category) throw new Error(`${task.ClassName}.${ownerName}.${slot.DisplayName || slot.PropertyName}：枚举类别与硬件槽位不匹配，请重新绑定。`);
        binding = { ...binding, EnumTypeName: resource.EnumTypeName, MemberName: resource.MemberName };
      }
      if (!validIdentifier(slot.PropertyName)) throw new Error(`硬件属性名「${slot.PropertyName}」不是有效的 C# 标识符。`);
      const member = binding.MemberName || '';
      // Unbound optional slots must still compile even if this project renamed
      // its enum sheets. Bound slots keep the exact enum type and member.
      const enumType = member ? (binding.EnumTypeName || slot.EnumTypeName || defaultEnumType[slot.Category] || 'InNo') : 'object';
      if (!validIdentifier(enumType)) throw new Error(`硬件属性 ${slot.PropertyName} 的枚举类型「${enumType}」无效。`);
      if (member && !validIdentifier(member)) throw new Error(`硬件绑定值「${member}」不是有效的 C# 标识符。`);
      return { name: slot.PropertyName, enumType, member };
    };
    const resolveSlots = (item, owner, ownerName) => {
      const propertyNames = new Set();
      return slotsFor(owner).map(slot => {
        const resolved = resolveSlot(item, slot, ownerName);
        const key = resolved.name.toLowerCase();
        if (key === item.Name.toLowerCase()) throw new Error(item.Name + ' 中的硬件属性 ' + resolved.name + ' 与类名相同，请修改名称。');
        if (propertyNames.has(key)) throw new Error(`${ownerName} 中存在重复的硬件属性名「${resolved.name}」。`);
        propertyNames.add(key);
        return resolved;
      });
    };
    const variableLiteral = (item, variable, type) => {
      const value = String(variable.InitialValue == null ? '' : variable.InitialValue).trim();
      const invalid = () => { throw new Error(`${item.Name} 的变量「${variable.Name}」初始值「${value}」不是有效的 ${type} 值。`); };
      if (type === 'string') return JSON.stringify(String(variable.InitialValue == null ? '' : variable.InitialValue))
        .replace(/\u0085/g, '\\u0085').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
      if (type === 'bool') {
        if (!/^(true|false)$/i.test(value)) invalid();
        return value.toLowerCase();
      }
      if (type === 'int' || type === 'long') {
        if (!/^[+-]?\d+$/.test(value)) invalid();
        const number = BigInt(value);
        const min = type === 'int' ? -2147483648n : -9223372036854775808n;
        const max = type === 'int' ? 2147483647n : 9223372036854775807n;
        if (number < min || number > max) invalid();
        if (number === min) return `${type}.MinValue`;
        return `${number}${type === 'long' ? 'L' : ''}`;
      }
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) invalid();
      const number = Number(value);
      if (!Number.isFinite(number) || (number === 0 && /[1-9]/.test(value.replace(/[eE].*$/, '')))) invalid();
      const normalized = value.replace(/\.(?=[eE]|$)/, '.0');
      if (type === 'float') {
        if (Math.abs(number) > 3.402823466e38 || (number !== 0 && Math.abs(number) < 1.401298464e-45)) invalid();
        return `${normalized}f`;
      }
      if (type === 'double') return `${normalized}d`;
      if (/[eE]/.test(value)) invalid();
      const unsigned = value.replace(/^[+-]/, '');
      const [whole, rawFraction = ''] = unsigned.split('.');
      const fraction = rawFraction.replace(/0+$/, '');
      const mantissa = BigInt((whole || '0') + fraction);
      const max = 79228162514264337593543950335n;
      if (fraction.length > 28 || mantissa > max) invalid();
      const sign = value.startsWith('-') && mantissa !== 0n ? '-' : '';
      return `${sign}${BigInt(whole || '0')}${fraction ? '.' + fraction : ''}m`;
    };
    const makeVariables = (item, propertyNames) => {
      return (item.Variables || []).map(variable => {
        const name = variable.Name;
        if (!validIdentifier(name)) throw new Error(`${item.Name} 的变量名「${name}」不是有效的 C# 标识符。`);
        const key = name.toLowerCase();
        if (key === item.Name.toLowerCase()) throw new Error(`${item.Name} 的变量「${name}」与类名相同，请修改名称。`);
        if (propertyNames.has(key)) throw new Error(`${item.Name} 中存在重复的硬件成员名「${name}」。`);
        propertyNames.add(key);
        const type = String(variable.Type || '').toLowerCase();
        if (!['bool', 'int', 'string', 'long', 'float', 'double', 'decimal'].includes(type))
          throw new Error(`${item.Name} 的变量「${name}」类型「${variable.Type}」不受支持。`);
        const kind = String(variable.MemberKind || 'property').toLowerCase();
        if (kind !== 'field' && kind !== 'property') throw new Error(`${item.Name} 的变量「${name}」成员类型「${variable.MemberKind}」无效。`);
        const initializer = variable.HasInitialValue ? ` = ${variableLiteral(item, variable, type)}` : '';
        return kind === 'field'
          ? `            public ${type} ${name}${initializer};`
          : `            public ${type} ${name} { get; set; }${initializer}${initializer ? ';' : ''}`;
      });
    };
    const regionSources = HARDWARE_REGION_ORDER.map(([type, region]) => {
      const group = items.filter(item => item.Type === type);
      const declarations = group.map(item => {
        const hasNozzles = type === 'Nozzle' && Array.isArray(item.Nozzles) && item.Nozzles.length > 0;
        const owners = hasNozzles ? item.Nozzles : [item];
        const instances = owners.map((owner, index) => resolveSlots(item, owner, hasNozzles ? `${item.Name}.${owner.Name || `吸嘴${index + 1}`}` : item.Name));
        const propertyNames = new Set();
        const properties = [];
        const propertyByName = new Map();
        instances.flat().forEach(slot => {
          const key = slot.name.toLowerCase();
          if (!propertyByName.has(key)) {
            propertyByName.set(key, { name: slot.name, enumTypes: new Set() });
            propertyNames.add(key);
          }
          if (slot.member) propertyByName.get(key).enumTypes.add(slot.enumType);
        });
        propertyByName.forEach(property => {
          const enumType = property.enumTypes.size === 1 ? [...property.enumTypes][0] : 'object';
          const legacySlot = !hasNozzles && instances[0].find(slot => slot.name.toLowerCase() === property.name.toLowerCase());
          const initializer = legacySlot && legacySlot.member ? ` = ${legacySlot.enumType}.${legacySlot.member};` : '';
          properties.push(`            public ${enumType}${enumType === 'object' ? '' : '?'} ${property.name} { get; set; }${initializer}`);
        });
        const variables = makeVariables(item, propertyNames);
        const instanceSource = slots => {
          const assignments = slots.filter(slot => slot.member).map(slot =>
            `${propertyByName.get(slot.name.toLowerCase()).name} = ${slot.enumType}.${slot.member}`);
          return assignments.length ? `new ${item.Name} { ${assignments.join(', ')} }` : `new ${item.Name}()`;
        };
        const hardwareMember = hasNozzles && instances.length > 1
          ? [
            `        public System.Collections.Generic.List<${item.Name}> ${item.Name}Hardware { get; private set; } = new System.Collections.Generic.List<${item.Name}>`,
            '        {',
            ...instances.map(slots => `            ${instanceSource(slots)},`),
            '        };',
          ]
          : [`        public ${item.Name} ${item.Name}Hardware { get; private set; } = ${hasNozzles ? instanceSource(instances[0]) : `new ${item.Name}()`};`];
        const classBody = [
          `        #region ${safeRegion(item.Name)}`,
          `        public sealed class ${item.Name}`,
          '        {',
          ...properties,
          ...variables,
          '        }',
          ...hardwareMember,
          '        #endregion',
        ].join('\r\n');
        return classBody;
      }).join('\r\n\r\n');
      return `        #region ${region}\r\n${declarations ? declarations + '\r\n' : ''}        #endregion`;
    }).join('\r\n\r\n');
    return `using static ${namespace}.EnumName;\r\n\r\nnamespace ${task.Namespace || 'BoTech'}\r\n{\r\n    ${taskTypeDeclaration(task)}\r\n    {\r\n${regionSources}\r\n    }\r\n}\r\n`;
  }

  function generatedMethodsSource(task, methods) {
    const template = templateResiduals(task);
    let generated = methodsSource(task, methods);
    const taskMethods = (methods || []).filter(method => method.MethodName !== 'AutoRun' && (!method.TaskId || method.TaskId === task.TaskId));
    const importedUsings = Array.from(new Set(taskMethods
      .flatMap(method => method.ImportedUsings || [])));
    if (hasFlowStatusCodesAttribute(taskMethods)) importedUsings.push(`using ${FLOW_STATUS_CODES_ATTRIBUTE_NAMESPACE};`);
    return mergeUsings(generated, Array.from(new Set([...template.imports, ...importedUsings])));
  }

  function hasFlowStatusCodesAttribute(methods) {
    return (methods || []).some(method => /\bFlowStatusCodes(?:Attribute)?\s*\(/.test([
      method.AttributeSource || '', method.SourceCode || '',
    ].join('\n')));
  }

  function flowStatusCodesSupportFiles(methods) {
    if (!hasFlowStatusCodesAttribute(methods)) return [];
    return [{
      fileName: 'FlowStatusCodesAttribute.cs',
      source: [
        'using System;',
        '',
        `namespace ${FLOW_STATUS_CODES_ATTRIBUTE_NAMESPACE}`,
        '{',
        '    [AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = false)]',
        '    public sealed class FlowStatusCodesAttribute : Attribute',
        '    {',
        '        public FlowStatusCodesAttribute(params int[] statusCodes)',
        '        {',
        '            StatusCodes = statusCodes ?? new int[0];',
        '        }',
        '',
        '        public int[] StatusCodes { get; private set; }',
        '    }',
        '}',
        '',
      ].join('\r\n'),
    }];
  }

  // A panel export builds only its own partial; an unfinished sibling does not block it.
  function generateSingleSource(kind, task, flow, methods, hardwareDefinitions = [], enumNamespace = 'ParName', enumResources = null) {
    if (kind === 'flow') return { fileName: task.ClassName + '.cs', source: generatedPrimarySource(task, flow, methods) };
    if (kind === 'methods') {
      const taskMethods = (methods || []).filter(method => method.MethodName !== 'AutoRun' && (!method.TaskId || method.TaskId === task.TaskId));
      return {
        fileName: task.ClassName + '_Methods.cs',
        source: generatedMethodsSource(task, taskMethods),
        supportFiles: flowStatusCodesSupportFiles(taskMethods),
      };
    }
    if (kind === 'hardware') return {
      fileName: task.ClassName + '_Hardware.cs',
      source: hardwareSource(task, hardwareDefinitions, enumNamespace, enumResources),
    };
    throw new Error('不支持的 Task 源码类型：' + kind);
  }

  // Public API: compose Task, method, and hardware partial sources as one package.
  function generateSources(task, flow, methods, hardwareDefinitions = [], enumNamespace = 'ParName', enumResources = null) {
    const generatedTaskSource = generateSingleSource('flow', task, flow, methods);
    const generatedMethodsSource = generateSingleSource('methods', task, flow, methods);
    const generatedHardwareSource = generateSingleSource('hardware', task, flow, methods, hardwareDefinitions, enumNamespace, enumResources);
    return {
      taskFileName: generatedTaskSource.fileName,
      taskSource: generatedTaskSource.source,
      methodsFileName: generatedMethodsSource.fileName,
      methodsSource: generatedMethodsSource.source,
      supportFiles: generatedMethodsSource.supportFiles || [],
      hardwareFileName: generatedHardwareSource.fileName,
      hardwareSource: generatedHardwareSource.source,
    };
  }
  function methodId(className, methodName) { return `${className}.${methodName}`; }

  const api = { validIdentifier, safeName, createBlankTask, defaultFlow, generateSources, generateSingleSource, methodSource, methodId };
  if (typeof window !== 'undefined') window.EquipmentFlowTaskCodegen = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
