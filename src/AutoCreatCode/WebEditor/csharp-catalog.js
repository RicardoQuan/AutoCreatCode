(() => {
  'use strict';

  const host = typeof window !== 'undefined' ? window : globalThis;
  const MODIFIERS = new Set([
    'public', 'private', 'protected', 'internal', 'static', 'virtual', 'override', 'abstract',
    'sealed', 'extern', 'async', 'unsafe', 'new', 'partial', 'readonly', 'volatile', 'required',
    'ref', 'readonly', 'file', 'const', 'event', 'extern', 'fixed',
  ]);
  const METHOD_MODIFIERS = new Set(['new', 'static', 'virtual', 'sealed', 'override', 'abstract', 'extern', 'async', 'unsafe', 'ref', 'partial', 'readonly']);
  const NON_HARDWARE_TYPES = new Set([
    'void', 'bool', 'byte', 'sbyte', 'short', 'ushort', 'int', 'uint', 'long', 'ulong',
    'float', 'double', 'decimal', 'char', 'string', 'object', 'dynamic', 'DateTime',
    'TimeSpan', 'Guid', 'CancellationToken',
  ]);

  function csharpStringValue(raw, verbatim) {
    if (verbatim) return raw.replace(/""/g, '"');
    return raw.replace(/\\(\\|"|'|0|a|b|f|n|r|t|v|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|x[0-9a-fA-F]{1,4})/g,
      (match, code) => {
        const escapes = { '\\': '\\', '"': '"', "'": "'", '0': '\0', a: '\x07', b: '\b',
          f: '\f', n: '\n', r: '\r', t: '\t', v: '\x0b' };
        if (Object.prototype.hasOwnProperty.call(escapes, code)) return escapes[code];
        const hex = code.slice(1);
        return String.fromCodePoint(parseInt(hex, 16));
      });
  }

  function tokenize(source) {
    const tokens = [];
    let index = 0;
    let line = 1;
    const add = (kind, value, start, end, tokenLine) => {
      tokens.push({ kind, value, start, end, line: tokenLine, index: tokens.length });
    };
    while (index < source.length) {
      const char = source[index];
      if (/\s/.test(char)) {
        if (char === '\n') line += 1;
        index += 1;
        continue;
      }
      if (char === '/' && source[index + 1] === '/') {
        const end = source.indexOf('\n', index + 2);
        index = end < 0 ? source.length : end;
        continue;
      }
      if (char === '/' && source[index + 1] === '*') {
        const start = index;
        const end = source.indexOf('*/', index + 2);
        if (end < 0) throw new Error(`第 ${line} 行注释未闭合。`);
        line += (source.slice(start, end + 2).match(/\n/g) || []).length;
        index = end + 2;
        continue;
      }
      if (char === '"' || char === '@' || char === '$') {
        let quoteIndex = index;
        let prefix = '';
        while ((source[quoteIndex] === '@' || source[quoteIndex] === '$') && quoteIndex - index < 2) {
          prefix += source[quoteIndex];
          quoteIndex += 1;
        }
        if (source[quoteIndex] === '"') {
          const tokenLine = line;
          const start = index;
          const rawString = source[quoteIndex + 1] === '"' && source[quoteIndex + 2] === '"';
          let contentStart = quoteIndex + (rawString ? 3 : 1);
          let cursor = contentStart;
          let content = '';
          if (rawString) {
            const close = source.indexOf('"""', contentStart);
            if (close < 0) throw new Error(`第 ${line} 行原始字符串未闭合。`);
            content = source.slice(contentStart, close);
            cursor = close + 3;
          } else {
            const verbatim = prefix.includes('@');
            let closed = false;
            while (cursor < source.length) {
              if (!verbatim && source[cursor] === '\\') {
                cursor += Math.min(2, source.length - cursor);
                continue;
              }
              if (source[cursor] === '"') {
                if (verbatim && source[cursor + 1] === '"') { cursor += 2; continue; }
                content = source.slice(contentStart, cursor);
                cursor += 1;
                closed = true;
                break;
              }
              cursor += 1;
            }
            if (!closed) throw new Error(`第 ${line} 行字符串未闭合。`);
            content = csharpStringValue(content, verbatim);
          }
          line += (source.slice(start, cursor).match(/\n/g) || []).length;
          add('string', content, start, cursor, tokenLine);
          index = cursor;
          continue;
        }
      }
      if (char === "'") {
        const tokenLine = line;
        const start = index++;
        let closed = false;
        while (index < source.length) {
          if (source[index] === '\\') { index += Math.min(2, source.length - index); continue; }
          if (source[index] === "'") { index += 1; closed = true; break; }
          index += 1;
        }
        if (!closed) throw new Error(`第 ${tokenLine} 行字符常量未闭合。`);
        add('char', source.slice(start, index), start, index, tokenLine);
        line += (source.slice(start, index).match(/\n/g) || []).length;
        continue;
      }
      if (/[A-Za-z_]/.test(char) || (char === '@' && /[A-Za-z_]/.test(source[index + 1] || ''))) {
        const tokenLine = line;
        const start = index;
        if (char === '@') index += 1;
        index += 1;
        while (/[A-Za-z0-9_]/.test(source[index] || '')) index += 1;
        add('identifier', source.slice(start, index).replace(/^@/, ''), start, index, tokenLine);
        continue;
      }
      if (/\d/.test(char)) {
        const tokenLine = line;
        const start = index;
        const match = source.slice(index).match(/^(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)[uUlLfFdDmM]*/);
        index += match ? match[0].length : 1;
        add('number', source.slice(start, index), start, index, tokenLine);
        continue;
      }
      const tokenLine = line;
      const start = index;
      const multi = ['=>', '::', '??', '?.', '<=', '>=', '==', '!=', '&&', '||', '++', '--', '+=', '-=', '<<', '>>'];
      const compound = multi.find(value => source.startsWith(value, index));
      index += compound ? compound.length : 1;
      add('punctuation', compound || source[start], start, index, tokenLine);
    }
    return tokens;
  }

  function createPairs(tokens) {
    const pairs = new Map();
    const depths = new Array(tokens.length).fill(0);
    const stack = [];
    const opening = { '{': '}', '[': ']', '(': ')' };
    const closing = { '}': '{', ']': '[', ')': '(' };
    let braceDepth = 0;
    tokens.forEach((token, index) => {
      depths[index] = braceDepth;
      if (Object.prototype.hasOwnProperty.call(opening, token.value)) {
        stack.push({ value: token.value, index: index });
        if (token.value === '{') braceDepth += 1;
      } else if (Object.prototype.hasOwnProperty.call(closing, token.value)) {
        const last = stack.pop();
        if (!last || last.value !== closing[token.value])
          throw new Error(`第 ${token.line} 行符号 ${token.value} 没有匹配的开始符号。`);
        pairs.set(last.index, index);
        pairs.set(index, last.index);
        if (token.value === '}') braceDepth -= 1;
      }
    });
    if (stack.length) {
      const last = stack[stack.length - 1];
      throw new Error(`第 ${tokens[last.index].line} 行符号 ${last.value} 未闭合。`);
    }
    return { pairs, depths };
  }

  function splitTopLevel(tokens, delimiter) {
    const result = [];
    let start = 0;
    let round = 0;
    let square = 0;
    let curly = 0;
    let angle = 0;
    tokens.forEach((token, index) => {
      if (token.value === delimiter && round === 0 && square === 0 && curly === 0 && angle === 0) {
        result.push(tokens.slice(start, index));
        start = index + 1;
        return;
      }
      if (token.value === '(') round += 1;
      else if (token.value === ')') round -= 1;
      else if (token.value === '[') square += 1;
      else if (token.value === ']') square -= 1;
      else if (token.value === '{') curly += 1;
      else if (token.value === '}') curly -= 1;
      else if (token.value === '<') angle += 1;
      else if (token.value === '>' && angle > 0) angle -= 1;
    });
    result.push(tokens.slice(start));
    return result.filter(group => group.length);
  }

  function sourceText(source, tokens) {
    if (!tokens || !tokens.length) return '';
    return source.slice(tokens[0].start, tokens[tokens.length - 1].end).trim();
  }

  function attributeName(tokens) {
    const names = [];
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].kind === 'identifier') names.push(tokens[index].value);
      else if (tokens[index].value !== '.' && tokens[index].value !== '::') break;
    }
    const name = names[names.length - 1] || '';
    return name.replace(/Attribute$/, '');
  }

  function readAttributeList(tokens, startIndex, pairs) {
    if (!tokens[startIndex] || tokens[startIndex].value !== '[') return { attributes: [], nextIndex: startIndex };
    const globalStart = tokens[startIndex].index;
    const globalEnd = pairs.get(globalStart);
    const listEnd = tokens.findIndex(token => token.index === globalEnd);
    if (globalEnd == null || listEnd < 0) throw new Error(`第 ${tokens[startIndex].line} 行特性列表未闭合。`);
    const groups = splitTopLevel(tokens.slice(startIndex + 1, listEnd), ',');
    const attributes = groups.map(group => {
      let openParen = -1;
      for (let index = 0; index < group.length; index += 1) {
        if (group[index].value === '(') { openParen = index; break; }
      }
      const name = attributeName(openParen < 0 ? group : group.slice(0, openParen));
      const argumentsTokens = openParen < 0 ? [] : group.slice(openParen + 1, group.length - 1);
      const args = splitTopLevel(argumentsTokens, ',');
      const values = {};
      const positional = [];
      args.forEach(arg => {
        const equals = arg.findIndex(token => token.value === '=');
        if (equals > 0 && arg[0].kind === 'identifier')
          values[arg[0].value] = arg.slice(equals + 1);
        else positional.push(arg);
      });
      return { name, positional, values, line: group[0] ? group[0].line : tokens[startIndex].line };
    });
    return { attributes: attributes, nextIndex: listEnd + 1 };
  }

  function firstString(attribute) {
    if (!attribute) return '';
    for (let groupIndex = 0; groupIndex < attribute.positional.length; groupIndex += 1) {
      const token = attribute.positional[groupIndex].find(item => item.kind === 'string');
      if (token) return token.value;
    }
    return '';
  }

  function namedValue(attribute, name) {
    return attribute && attribute.values[name] ? attribute.values[name] : [];
  }

  function namedString(attribute, name) {
    return namedValue(attribute, name).find(token => token.kind === 'string')?.value || '';
  }

  function declarationAttributes(tokens, declarationIndex, pairs) {
    const attributes = [];
    let cursor = declarationIndex - 1;
    while (cursor >= 0 && MODIFIERS.has(tokens[cursor].value)) cursor -= 1;
    while (cursor >= 0 && tokens[cursor].value === ']' && pairs.has(cursor)) {
      const start = pairs.get(cursor);
      attributes.unshift(...readAttributeList(tokens, start, pairs).attributes);
      cursor = start - 1;
    }
    return attributes;
  }

  // Only literal array initializers are interpreted. A factory may discover its IDs
  // from loaded machine configuration; importing source must never execute that code.
  function factoryInstanceIds(attribute) {
    const tokens = namedValue(attribute, 'InstanceIds');
    if (!tokens.length) return null;
    const open = tokens.findIndex(token => token.value === '{');
    if (open < 0 || tokens[tokens.length - 1]?.value !== '}') return null;
    const prefix = tokens.slice(0, open).map(token => token.value).join('');
    if (prefix !== 'new[]' && prefix !== 'newint[]' && prefix !== 'newSystem.Int32[]') return null;
    const body = tokens.slice(open + 1, -1);
    const groups = splitTopLevel(body, ',');
    if (!groups.length) throw new Error(`第 ${attribute.line} 行吸嘴工厂 InstanceIds 不能为空。`);
    const ids = [];
    for (const group of groups) {
      let sign = 1;
      let valueToken = group[0];
      if (group[0]?.value === '-' || group[0]?.value === '+') {
        sign = group[0].value === '-' ? -1 : 1;
        valueToken = group[1];
      }
      const literalLength = valueToken === group[0] ? 1 : 2;
      if (group.length !== literalLength || valueToken?.kind !== 'number') return null;
      const raw = valueToken.value.replace(/[uUlL]+$/, '');
      const id = sign * (/^0[xX]/.test(raw) ? parseInt(raw.slice(2), 16)
        : /^0[bB]/.test(raw) ? parseInt(raw.slice(2), 2) : Number(raw));
      if (!Number.isSafeInteger(id) || id <= 0)
        throw new Error(`第 ${attribute.line} 行吸嘴工厂 InstanceIds 必须全部是有限正整数。`);
      if (ids.includes(id)) throw new Error(`第 ${attribute.line} 行吸嘴工厂 InstanceIds 中的编号 ${id} 重复。`);
      ids.push(id);
    }
    return ids;
  }

  function nozzleFactory(attribute, type, method, fileName) {
    const ids = attribute ? factoryInstanceIds(attribute) : null;
    const returnNozzle = method?.ReturnType.match(/\b(?:I?\w*Nozzle\w*)\b/);
    const nozzleType = firstString(attribute) || namedString(attribute, 'NozzleType') || returnNozzle?.[0] || '';
    const owner = method ? `${type.fullName}.${method.MethodName}` : type.fullName;
    return {
      FactoryId: namedString(attribute, 'FactoryId') || owner,
      DisplayName: namedString(attribute, 'DisplayName') || (method ? method.MethodName : type.name),
      NozzleType: nozzleType,
      InstanceIds: ids || [],
      Count: ids ? ids.length : null,
      MachineName: namedString(attribute, 'MachineName'),
      StationId: namedString(attribute, 'StationId'),
      SourceFile: String(fileName || 'Imported.cs'),
      OwnerClass: type.name,
      SourceLine: attribute?.line || method?.Line || type.line,
      IsDynamic: ids === null,
    };
  }

  function numberTokens(tokens) {
    const values = [];
    for (let index = 0; index < tokens.length; index += 1) {
      let sign = 1;
      if (tokens[index].value === '-' && tokens[index + 1] && tokens[index + 1].kind === 'number') {
        sign = -1;
        index += 1;
      }
      if (tokens[index].kind !== 'number') continue;
      const raw = tokens[index].value.replace(/[uUlLfFdDmM]+$/, '');
      const value = /^0[xX]/.test(raw) ? parseInt(raw.slice(2), 16)
        : /^0[bB]/.test(raw) ? parseInt(raw.slice(2), 2) : Number(raw);
      if (Number.isInteger(value)) values.push(sign * value);
    }
    return values;
  }

  function namespaceDeclarations(tokens, pairs) {
    const result = [];
    tokens.forEach((token, index) => {
      if (token.value !== 'namespace') return;
      let end = index + 1;
      while (end < tokens.length && tokens[end].value !== '{' && tokens[end].value !== ';') end += 1;
      const name = tokens.slice(index + 1, end).map(item => item.value).join('');
      if (tokens[end] && tokens[end].value === '{')
        result.push({ name: name, start: index, end: pairs.get(end) || tokens.length });
      else result.push({ name: name, start: index, end: tokens.length });
    });
    return result;
  }

  function namespaceAt(index, declarations) {
    return declarations.filter(item => item.start < index && item.end > index)
      .sort((left, right) => right.start - left.start)[0]?.name || '';
  }

  function findBody(tokens, start, pairs) {
    for (let index = start; index < tokens.length; index += 1) {
      if (tokens[index].value === ';') return null;
      if (tokens[index].value === '{') return { open: index, close: pairs.get(index) };
    }
    return null;
  }

  function collectTypes(tokens, pairs, declarations) {
    const classes = [];
    const enums = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const kind = tokens[index].value;
      if (kind === 'enum') {
        const nameToken = tokens[index + 1];
        const body = findBody(tokens, index + 2, pairs);
        if (!nameToken || !body) continue;
        const members = splitTopLevel(tokens.slice(body.open + 1, body.close), ',').map((group, memberIndex) => {
          const name = group.find(token => token.kind === 'identifier');
          if (!name) return null;
          const equals = group.findIndex(token => token.value === '=');
          let value = '';
          const assigned = equals >= 0 ? group.slice(equals + 1).map(token => token.value).join('') : '';
          return { name: name.value, value: assigned, index: memberIndex, line: name.line };
        }).filter(Boolean);
        let nextNumeric = 0;
        members.forEach(member => {
          if (member.value) {
            const numeric = /^-?(?:0[xX][0-9a-fA-F]+|0[bB][01]+|\d+)[uUlL]*$/.test(member.value);
            if (numeric) {
              const raw = member.value.replace(/[uUlL]+$/, '');
              nextNumeric = /^0[xX]/.test(raw) ? parseInt(raw.slice(2), 16)
                : /^0[bB]/.test(raw) ? parseInt(raw.slice(2), 2) : Number(raw);
            }
          } else {
            member.value = String(nextNumeric);
          }
          nextNumeric += 1;
        });
        enums.push({
          name: nameToken.value,
          fullName: [namespaceAt(index, declarations), nameToken.value].filter(Boolean).join('.'),
          resourceType: nameToken.value,
          members,
          line: tokens[index].line,
          bodyOpen: body.open,
          bodyClose: body.close,
        });
      }
      if (kind !== 'class' && kind !== 'struct' && kind !== 'interface' && kind !== 'record') continue;
      let nameIndex = index + 1;
      if (kind === 'record' && tokens[nameIndex] && (tokens[nameIndex].value === 'class' || tokens[nameIndex].value === 'struct')) nameIndex += 1;
      const nameToken = tokens[nameIndex];
      if (!nameToken || nameToken.kind !== 'identifier') continue;
      const body = findBody(tokens, nameIndex + 1, pairs);
      if (!body) continue;
      let modifierStart = index - 1;
      while (modifierStart >= 0 && ![';', '{', '}', ']', ')'].includes(tokens[modifierStart].value)) modifierStart -= 1;
      const declarationModifiers = new Set(tokens.slice(modifierStart + 1, index).map(token => token.value));
      const accessModifier = ['public', 'protected', 'internal', 'private'].find(value => declarationModifiers.has(value)) || 'internal';
      const namespace = namespaceAt(index, declarations);
      classes.push({
        name: nameToken.value,
        namespace: namespace,
        fullName: [namespace, nameToken.value].filter(Boolean).join('.'),
        kind: kind,
        AccessModifier: accessModifier,
        Modifiers: Array.from(declarationModifiers),
        DeclarationStart: tokens[modifierStart + 1] ? tokens[modifierStart + 1].start : tokens[index].start,
        HeaderEnd: tokens[body.open].start,
        methods: [],
        hardwareSlots: [],
        attributes: declarationAttributes(tokens, index, pairs),
        line: tokens[index].line,
        bodyOpen: body.open,
        bodyClose: body.close,
      });
    }
    return { classes, enums };
  }

  function parseMethodMetadata(attributes) {
    const combined = attributes.find(attribute => attribute.name === 'FlowMethod');
    const idAttribute = attributes.find(attribute => attribute.name === 'FlowMethodId');
    const statusAttribute = attributes.find(attribute => attribute.name === 'FlowStatusCodes');
    const pendingAttribute = attributes.find(attribute => attribute.name === 'FlowPendingStatusCodes');
    const alarmAttribute = attributes.find(attribute => attribute.name === 'FlowAlarmStatusCodes');
    const nameAttribute = attributes.find(attribute => attribute.name === 'FlowMethodName');
    const categoryAttribute = attributes.find(attribute => attribute.name === 'FlowMethodCategory');
    const schemaAttribute = attributes.find(attribute => attribute.name === 'FlowMethodSchemaVersion');
    const id = firstString(combined) || firstString(idAttribute);
    const statusTokens = namedValue(combined, 'StatusCodes').length
      ? namedValue(combined, 'StatusCodes')
      : namedValue(combined, 'ResultStatusCodes').length
        ? namedValue(combined, 'ResultStatusCodes')
        : statusAttribute ? statusAttribute.positional.reduce((all, group) => all.concat(group), []) : [];
    const pendingTokens = namedValue(combined, 'PendingStatusCodes').length
      ? namedValue(combined, 'PendingStatusCodes')
      : pendingAttribute ? pendingAttribute.positional.reduce((all, group) => all.concat(group), []) : [];
    const alarmTokens = namedValue(combined, 'AlarmStatusCodes').length
      ? namedValue(combined, 'AlarmStatusCodes')
      : alarmAttribute ? alarmAttribute.positional.reduce((all, group) => all.concat(group), []) : [];
    const schemaTokens = namedValue(combined, 'SchemaVersion');
    const schemaValue = schemaTokens.find(token => token.kind === 'number');
    const schemaPositional = schemaAttribute && schemaAttribute.positional[0]
      ? schemaAttribute.positional[0].find(token => token.kind === 'number') : null;
    return {
      MethodId: id,
      DisplayName: (namedValue(combined, 'DisplayName').find(token => token.kind === 'string') || {}).value
        || firstString(nameAttribute),
      Category: (namedValue(combined, 'Category').find(token => token.kind === 'string') || {}).value
        || firstString(categoryAttribute) || 'Station',
      MachineName: (namedValue(combined, 'MachineName').find(token => token.kind === 'string') || {}).value || '',
      StationId: (namedValue(combined, 'StationId').find(token => token.kind === 'string') || {}).value || '',
      SchemaVersion: schemaValue ? Number(schemaValue.value) : schemaPositional ? Number(schemaPositional.value) : 1,
      ResultStatusCodes: numberTokens(statusTokens),
      PendingStatusCodes: numberTokens(pendingTokens),
      AlarmStatusCodes: numberTokens(alarmTokens),
    };
  }

  function parseParameter(source, group, pairs, index) {
    const attributes = [];
    let cursor = 0;
    while (group[cursor] && group[cursor].value === '[') {
      const read = readAttributeList(group, cursor, pairs);
      attributes.push(...read.attributes);
      cursor = read.nextIndex;
    }
    const body = group.slice(cursor);
    if (!body.length) return null;
    const defaultIndex = body.findIndex(token => token.value === '=');
    const declaration = defaultIndex < 0 ? body : body.slice(0, defaultIndex);
    const nameToken = declaration.slice().reverse().find(token => token.kind === 'identifier');
    if (!nameToken) return null;
    const modifiers = new Set(['out', 'ref', 'in', 'params', 'this', 'scoped', 'readonly', 'refreadonly']);
    const typeTokens = declaration.filter(token => token !== nameToken && !modifiers.has(token.value));
    const typeName = sourceText(source, typeTokens);
    const flowInput = attributes.find(attribute => attribute.name === 'FlowInput');
    const flowOutput = attributes.find(attribute => attribute.name === 'FlowOutput');
    if (attributes.some(attribute => attribute.name === 'FlowContext')) return { Context: true, index: index };
    const directionToken = declaration.find(token => ['out', 'ref', 'in'].includes(token.value));
    const direction = directionToken ? directionToken.value : 'value';
    const defaultValue = defaultIndex < 0 ? '' : sourceText(source, body.slice(defaultIndex + 1));
    const isParams = declaration.some(token => token.value === 'params');
    return {
      Name: nameToken.value,
      FlowName: firstString(flowInput) || firstString(flowOutput) || nameToken.value,
      TypeName: namedString(flowInput || flowOutput, 'TypeName') || typeName,
      Direction: direction,
      DefaultValue: defaultValue,
      IsParams: isParams,
      Required: direction !== 'out' && !defaultValue && !isParams,
      Index: index,
    };
  }

  function parseParameters(source, tokens, pairs, openIndex, closeIndex) {
    return splitTopLevel(tokens.slice(openIndex + 1, closeIndex), ',')
      .map((group, index) => parseParameter(source, group, pairs, index))
      .filter(parameter => parameter && !parameter.Context);
  }

  function parseMethodFromMember(source, tokens, pairs, memberStart, openParen, attributes) {
    const closeParen = pairs.get(openParen);
    if (closeParen == null) return null;
    const nameToken = tokens[openParen - 1];
    if (!nameToken || nameToken.kind !== 'identifier') return null;
    const prefix = tokens.slice(memberStart, openParen - 1);
    if (prefix.some(token => token.value === '=' || token.value === 'return' || token.value === 'new')) return null;
    const declarationTokens = tokens.slice(memberStart, openParen - 1);
    const modifierValues = new Set(declarationTokens.map(token => token.value));
    const accessModifier = modifierValues.has('private') && modifierValues.has('protected')
      ? 'private protected'
      : modifierValues.has('protected') && modifierValues.has('internal')
        ? 'protected internal'
        : ['public', 'protected', 'internal', 'private'].find(value => modifierValues.has(value)) || 'private';
    const typeTokens = declarationTokens.filter(token => !MODIFIERS.has(token.value));
    const returnType = sourceText(source, typeTokens);
    if (!returnType) return null;
    const metadata = parseMethodMetadata(attributes);
    const method = {
      ...metadata,
      ParameterModelVersion: 2,
      MethodName: nameToken.value,
      DisplayName: metadata.DisplayName || nameToken.value,
      ReturnType: returnType,
      Modifiers: declarationTokens.map(token => token.value).filter(value => METHOD_MODIFIERS.has(value)),
      Parameters: parseParameters(source, tokens, pairs, openParen, closeParen),
      Line: nameToken.line,
      AccessModifier: accessModifier,
      IsPublic: declarationTokens.some(token => token.value === 'public'),
      NodeType: returnType === 'bool' ? 'Condition' : 'Action',
      Outcomes: returnType === 'bool' ? ['true', 'false'] : metadata.ResultStatusCodes.map(String),
      CanBind: Boolean(metadata.MethodId && ((returnType === 'int' && metadata.ResultStatusCodes.length)
        || (returnType === 'bool' && !metadata.ResultStatusCodes.length && !metadata.PendingStatusCodes.length && !metadata.AlarmStatusCodes.length))
        && declarationTokens.some(token => token.value === 'public')),
    };
    method.Signature = `${returnType} ${nameToken.value}(${parseParameterSignature(source, tokens, openParen, closeParen)})`;
    if (!metadata.MethodId) method.ContractIssue = '缺少稳定 FlowMethodId，不能绑定到流程节点。';
    else if (returnType !== 'int' && returnType !== 'bool') method.ContractIssue = '流程方法必须返回 int 状态码或 bool 判断值。';
    else if (returnType === 'int' && !metadata.ResultStatusCodes.length) method.ContractIssue = '缺少 ResultStatusCodes 状态码声明。';
    else if (returnType === 'bool' && (metadata.ResultStatusCodes.length || metadata.PendingStatusCodes.length || metadata.AlarmStatusCodes.length))
      method.ContractIssue = 'bool 方法使用 true/false 分支，不能声明整数状态码。';
    else if (!declarationTokens.some(token => token.value === 'public')) method.ContractIssue = '流程方法必须为 public。';
    method.factoryAttribute = attributes.find(attribute => attribute.name === 'FlowNozzleFactory');
    return { method, closeParen: closeParen };
  }

  function parseParameterSignature(source, tokens, openIndex, closeIndex) {
    return splitTopLevel(tokens.slice(openIndex + 1, closeIndex), ',').map(group => sourceText(source, group)).join(', ');
  }

  function findMethodBodyEnd(tokens, pairs, closeParen) {
    let index = closeParen + 1;
    while (tokens[index] && tokens[index].value !== '{' && tokens[index].value !== '=>' && tokens[index].value !== ';' && tokens[index].value !== '}') index += 1;
    if (!tokens[index]) return closeParen;
    if (tokens[index].value === '{' && pairs.has(index)) return pairs.get(index);
    if (tokens[index].value === '=>') {
      while (tokens[index] && tokens[index].value !== ';') index += 1;
      return index < tokens.length ? index : closeParen;
    }
    return index;
  }

  function documentationSummaryBefore(source, offset) {
    const lines = source.slice(0, offset).split(/\r?\n/);
    const documentation = [];
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const match = /^\s*\/\/\/(.*)$/.exec(lines[index]);
      if (match) documentation.unshift(match[1].trim());
      else if (!lines[index].trim()) continue;
      else break;
    }
    if (!documentation.length) return '';
    const xml = documentation.join('\n');
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary\s*>/i.exec(xml);
    return (summary ? summary[1] : xml)
      .replace(/<see\b[^>]*\bcref\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi, '$1')
      .replace(/<paramref\b[^>]*\bname\s*=\s*["']([^"']+)["'][^>]*\/?\s*>/gi, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
  }

  function parseClassMethods(source, tokens, pairs, depths, type) {
    const methods = [];
    const directDepth = depths[type.bodyOpen] + 1;
    let memberStart = type.bodyOpen + 1;
    let pendingAttributes = [];
    let pendingAttributeStart = null;
    for (let index = type.bodyOpen + 1; index < type.bodyClose; index += 1) {
      if (depths[index] !== directDepth) continue;
      if (tokens[index].value === '[' && pairs.has(index) && index === memberStart) {
        if (pendingAttributeStart == null) pendingAttributeStart = tokens[index].start;
        const read = readAttributeList(tokens, index, pairs);
        pendingAttributes.push(...read.attributes);
        memberStart = read.nextIndex;
        index = read.nextIndex - 1;
        continue;
      }
      if (tokens[index].value === '(' && pairs.has(index)) {
        const parsed = parseMethodFromMember(source, tokens, pairs, memberStart, index, pendingAttributes);
        if (parsed) {
          const documentationStart = pendingAttributeStart == null
            ? (tokens[memberStart] ? tokens[memberStart].start : tokens[index - 1].start)
            : pendingAttributeStart;
          parsed.method.DocumentationSummary = documentationSummaryBefore(source, documentationStart);
          methods.push(parsed.method);
          index = findMethodBodyEnd(tokens, pairs, parsed.closeParen);
          const first = tokens[memberStart];
          const last = tokens[index];
          if (first && last) {
            parsed.method.SourceStart = pendingAttributeStart == null ? first.start : pendingAttributeStart;
            parsed.method.SourceEnd = last.end;
            parsed.method.SourceCode = source.slice(parsed.method.SourceStart, parsed.method.SourceEnd).trim();
            parsed.method.AttributeSource = pendingAttributeStart == null
              ? ''
              : source.slice(pendingAttributeStart, tokens[memberStart] ? tokens[memberStart].start : first.start).trim();
            let bodyOpen = parsed.closeParen + 1;
            while (tokens[bodyOpen] && !['{', '=>', ';', '}'].includes(tokens[bodyOpen].value)) bodyOpen += 1;
            if (tokens[bodyOpen] && tokens[bodyOpen].value === '{' && pairs.has(bodyOpen)) {
              const bodyClose = pairs.get(bodyOpen);
              parsed.method.BodyText = source.slice(tokens[bodyOpen].end, tokens[bodyClose].start).replace(/^\r?\n/, '').replace(/\r?\n\s*$/, '');
              parsed.method.SourceForm = 'block';
            } else if (tokens[bodyOpen] && tokens[bodyOpen].value === '=>') {
              parsed.method.BodyText = source.slice(tokens[bodyOpen].end, last.end).replace(/;\s*$/, '').trim();
              parsed.method.SourceForm = 'expression';
            } else {
              parsed.method.BodyText = '';
              parsed.method.SourceForm = 'declaration';
            }
          }
          memberStart = index + 1;
          pendingAttributes = [];
          pendingAttributeStart = null;
          continue;
        }
      }
      if (tokens[index].value === ';') {
        memberStart = index + 1;
        pendingAttributes = [];
        pendingAttributeStart = null;
      } else if (tokens[index].value === '{' && pairs.has(index)) {
        index = pairs.get(index);
        memberStart = index + 1;
        pendingAttributes = [];
        pendingAttributeStart = null;
      }
    }
    return methods;
  }

  function parseHardwareSlotAttributes(tokens, memberStart, publicIndex, pairs) {
    const attributes = [];
    let index = memberStart;
    while (index < publicIndex && tokens[index].value === '[' && pairs.has(index)) {
      const read = readAttributeList(tokens, index, pairs);
      attributes.push(...read.attributes);
      index = read.nextIndex;
    }
    return attributes;
  }

  function parseHardwareSlots(source, tokens, pairs, depths, type) {
    const slots = [];
    const directDepth = depths[type.bodyOpen] + 1;
    let memberStart = type.bodyOpen + 1;
    for (let index = type.bodyOpen + 1; index < type.bodyClose; index += 1) {
      if (depths[index] !== directDepth) continue;
      if (tokens[index].value === '[' && pairs.has(index)) {
        index = pairs.get(index);
        continue;
      }
      if (tokens[index].value === 'public') {
        let cursor = index + 1;
        while (tokens[cursor] && MODIFIERS.has(tokens[cursor].value)) cursor += 1;
        let memberNameIndex = -1;
        for (let probe = cursor + 1; probe < type.bodyClose && depths[probe] === directDepth; probe += 1) {
          if (tokens[probe].value === '(' || tokens[probe].value === ',') break;
          if (tokens[probe].kind === 'identifier'
              && tokens[probe + 1]
              && ['{', ';', '='].includes(tokens[probe + 1].value)) {
            memberNameIndex = probe;
            break;
          }
          if (tokens[probe].value === ';' || tokens[probe].value === '}') break;
        }
        if (memberNameIndex > cursor) {
          const typeTokens = tokens.slice(cursor, memberNameIndex);
          const typeName = sourceText(source, typeTokens).replace(/\s+/g, '');
          const memberName = tokens[memberNameIndex].value;
          const simpleType = typeName.replace(/[?\[\]]/g, '').split('.').pop();
          if (typeName && !NON_HARDWARE_TYPES.has(simpleType)) {
            const attributes = parseHardwareSlotAttributes(tokens, memberStart, index, pairs);
            const slotAttribute = attributes.find(attribute => attribute.name === 'FlowHardwareSlot');
            const slotId = firstString(slotAttribute) || `${type.name}.${memberName}`;
            const resourceTypeTokens = namedValue(slotAttribute, 'ResourceType');
            const resourceType = resourceTypeTokens.find(token => token.kind === 'string')?.value || simpleType;
            const displayName = namedValue(slotAttribute, 'DisplayName').find(token => token.kind === 'string')?.value || memberName;
            slots.push({
              SlotId: slotId,
              DisplayName: displayName,
              OwnerClass: type.name,
              MemberName: memberName,
              TypeName: typeName,
              ResourceType: resourceType,
              Line: tokens[memberNameIndex].line,
              BoundResourceId: '',
            });
          }
          index = memberNameIndex;
        }
      }
      if (tokens[index].value === ';') memberStart = index + 1;
      else if (tokens[index].value === '{' && pairs.has(index)) {
        index = pairs.get(index);
        memberStart = index + 1;
      }
    }
    return slots;
  }

  function parseSource(source, fileName) {
    if (typeof source !== 'string') throw new Error('C# 源码必须是文本。');
    if (!source.trim()) throw new Error('C# 文件为空。');
    const tokens = tokenize(source);
    const structure = createPairs(tokens);
    const namespaces = namespaceDeclarations(tokens, structure.pairs);
    const types = collectTypes(tokens, structure.pairs, namespaces);
    const factories = [];
    types.classes.forEach(type => {
      type.methods = parseClassMethods(source, tokens, structure.pairs, structure.depths, type);
      type.BodyStart = tokens[type.bodyOpen].end;
      type.BodyEnd = tokens[type.bodyClose].start;
      const classFactory = type.attributes.find(attribute => attribute.name === 'FlowNozzleFactory');
      if (classFactory) factories.push(nozzleFactory(classFactory, type, null, fileName));
      type.methods.forEach(method => {
        method.FileName = String(fileName || 'Imported.cs');
        method.Namespace = type.namespace;
        method.ClassName = type.name;
        if (method.factoryAttribute) factories.push(nozzleFactory(method.factoryAttribute, type, method, fileName));
        else if (!classFactory && type.kind !== 'interface' && /^Create(?:Nozzles?|Assembly)?$/.test(method.MethodName)
          && (/Nozzle\w*Factory$/.test(type.name) || /\bI?\w*Nozzle\w*\b/.test(method.ReturnType)))
          factories.push(nozzleFactory(null, type, method, fileName));
        delete method.factoryAttribute;
      });
      type.hardwareSlots = parseHardwareSlots(source, tokens, structure.pairs, structure.depths, type);
      delete type.bodyOpen;
      delete type.bodyClose;
      delete type.attributes;
    });
    types.enums.forEach(type => { delete type.bodyOpen; delete type.bodyClose; });
    const duplicateIds = new Set();
    const diagnostics = [];
    types.classes.forEach(type => type.methods.forEach(method => {
      if (!method.MethodId) return;
      const identity = JSON.stringify([method.MethodId, method.SchemaVersion, method.MachineName, method.StationId]);
      if (duplicateIds.has(identity)) diagnostics.push(`方法 ID “${method.MethodId}” 与版本/机种/工站作用域在 ${fileName || '源码'} 中重复。`);
      duplicateIds.add(identity);
    }));
    return {
      fileName: String(fileName || 'Imported.cs'),
      namespaces: namespaces.map(item => item.name).filter(Boolean),
      classes: types.classes,
      enums: types.enums,
      factories,
      diagnostics,
    };
  }

  const api = { parseSource, tokenize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EquipmentFlowCSharpCatalog = api;
})();
