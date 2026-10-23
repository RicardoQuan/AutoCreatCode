(() => {
  'use strict';

  const CSHARP_KEYWORDS = (
    'abstract as async await base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while'
  ).split(' ');
  const CSHARP_TYPE_KEYWORDS = (
    'bool byte char decimal double float int long object sbyte short string uint ulong ushort void var'
  ).split(' ');

  // A local formatter keeps the standalone WebUI offline and follows CSharpier's
  // four-space indentation and brace layout without changing C# tokens or strings.
  function tokenizeCSharp(source) {
    const text = String(source || '').replace(/\r\n?/gu, '\n');
    const tokens = [];
    const operators = ['>>=', '<<=', '??=', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '::', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->', '..'];
    let index = 0, pendingBreaks = 0, onlyWhitespaceOnLine = true;
    const isWordStart = value => /[\p{L}_]/u.test(value || '');
    const isWordPart = value => /[\p{L}\p{N}_]/u.test(value || '');
    const push = (kind, value, start, end) => {
      tokens.push({ kind, value, start, end, lineBreaks: pendingBreaks });
      pendingBreaks = 0;
      onlyWhitespaceOnLine = false;
    };

    while (index < text.length) {
      const start = index, char = text[index];
      if (/\s/u.test(char)) {
        while (index < text.length && /\s/u.test(text[index])) {
          if (text[index] === '\n') { pendingBreaks++; onlyWhitespaceOnLine = true; }
          index++;
        }
        continue;
      }
      if (char === '#' && onlyWhitespaceOnLine) {
        while (index < text.length && text[index] !== '\n') index++;
        push('directive', text.slice(start, index).trim(), start, index);
        continue;
      }
      if (text.startsWith('//', index)) {
        while (index < text.length && text[index] !== '\n') index++;
        push('lineComment', text.slice(start, index), start, index);
        continue;
      }
      if (text.startsWith('/*', index)) {
        index += 2;
        while (index < text.length && !text.startsWith('*/', index)) index++;
        index = Math.min(text.length, index + 2);
        push('blockComment', text.slice(start, index), start, index);
        continue;
      }

      // Keep normal, verbatim, interpolated, raw, and character literals opaque.
      let quoteIndex = index;
      while (quoteIndex < text.length && (text[quoteIndex] === '$' || text[quoteIndex] === '@')) quoteIndex++;
      const quote = text[quoteIndex];
      if (quote === '"' || quote === "'") {
        const prefix = text.slice(index, quoteIndex);
        const isCharacter = quote === "'", isVerbatim = prefix.includes('@');
        let quoteCount = 1;
        if (quote === '"') { while (text[quoteIndex + quoteCount] === '"') quoteCount++; }
        const isRaw = quote === '"' && quoteCount >= 3;
        index = quoteIndex + quoteCount;
        while (index < text.length) {
          if (isRaw) {
            let closeCount = 0;
            while (text[index + closeCount] === '"') closeCount++;
            if (closeCount >= quoteCount) { index += quoteCount; break; }
            index++;
          } else if (isVerbatim) {
            if (text[index] === '"' && text[index + 1] === '"') index += 2;
            else if (text[index] === '"') { index++; break; }
            else index++;
          } else if (text[index] === '\\') index = Math.min(text.length, index + 2);
          else if (text[index] === quote) { index++; break; }
          else index++;
        }
        push(isCharacter ? 'literal' : 'literal', text.slice(start, index), start, index);
        continue;
      }

      if (isWordStart(char) || (char === '@' && isWordStart(text[index + 1]))) {
        index += char === '@' ? 2 : 1;
        while (index < text.length && isWordPart(text[index])) index++;
        push('word', text.slice(start, index), start, index);
        continue;
      }
      if (/\d/u.test(char)) {
        index++;
        while (index < text.length && /[\p{L}\p{N}_.]/u.test(text[index])) index++;
        push('literal', text.slice(start, index), start, index);
        continue;
      }
      const operator = operators.find(candidate => text.startsWith(candidate, index));
      if (operator) { index += operator.length; push('operator', operator, start, index); continue; }
      index++;
      push('punctuation', char, start, index);
    }
    return tokens;
  }

  function csharpGenericAngles(tokens) {
    const pairs = new Set();
    const wordLike = token => token && ['word', 'literal'].includes(token.kind) || token && [']', '>'].includes(token.value);
    for (let start = 0; start < tokens.length; start++) {
      if (tokens[start].value !== '<' || !wordLike(tokens[start - 1])) continue;
      // C# comparisons conventionally have surrounding spaces; generic brackets do not.
      if (tokens[start].start !== tokens[start - 1].end) continue;
      let depth = 1, close = -1, valid = true;
      for (let end = start + 1; end < tokens.length; end++) {
        const token = tokens[end];
        if (token.value === '<') depth++;
        else if (token.value === '>' && --depth === 0) { close = end; break; }
        else if (!(['word', 'literal'].includes(token.kind) || [',', '.', '?', '[', ']', '<', '>'].includes(token.value))) { valid = false; break; }
        if (token.lineBreaks > 0 && token.value === ';') { valid = false; break; }
      }
      if (valid && close > start) {
        pairs.add(start); pairs.add(close); start = close;
      }
    }
    return pairs;
  }

  function formatCSharpierStyle(source) {
    const tokens = tokenizeCSharp(source);
    if (!tokens.length) return '';
    const genericAngles = csharpGenericAngles(tokens);
    tokens.forEach((token, index) => { token.isGenericAngle = genericAngles.has(index); });
    const output = [];
    let line = '', indent = 0, parenDepth = 0, bracketDepth = 0, previous = null;
    const hasCode = () => Boolean(line.trim());
    const flushLine = () => {
      if (hasCode()) output.push(line.replace(/[ \t]+$/u, ''));
      line = '';
    };
    const newline = () => { flushLine(); };
    const blankLine = () => { newline(); if (output.length && output[output.length - 1] !== '') output.push(''); };
    const write = value => {
      const parts = String(value).split('\n');
      if (!line && parts[0]) line = '    '.repeat(Math.max(0, indent));
      line += parts[0];
      for (let part = 1; part < parts.length; part++) { output.push(line); line = parts[part]; }
    };
    const space = () => { if (line && !/[ \t]$/u.test(line)) line += ' '; };
    const wordLike = token => token && (['word', 'literal', 'lineComment', 'blockComment'].includes(token.kind) || token.isGenericAngle && token.value === '>');
    const unary = (token, before) => !before || ['(', '[', '{', ',', ':', ';', '=', '=>', 'return', 'throw', 'case', '?', '+', '-', '*', '/', '%', '&', '|', '^', '!', '~', '&&', '||'].includes(before.value);

    tokens.forEach((token, index) => {
      const next = tokens[index + 1];
      const value = token.value;
      if (token.lineBreaks >= 2 && hasCode() && !['{', '}', ';'].includes(previous?.value)) blankLine();

      if (token.kind === 'directive') {
        if (hasCode()) newline();
        indent = 0; line = value; newline(); previous = token; return;
      }
      if (token.kind === 'lineComment' || token.kind === 'blockComment') {
        if (hasCode()) space();
        write(value);
        if (token.kind === 'lineComment' || value.includes('\n')) newline();
        previous = token; return;
      }

      if (value === '{') {
        if (hasCode()) newline();
        write('{'); newline(); indent++;
      } else if (value === '}') {
        if (hasCode()) newline();
        indent = Math.max(0, indent - 1); write('}');
        if (!next || ![';', ',', ')', ']', '.', '?.'].includes(next.value)) newline();
      } else if (value === ';') {
        write(';');
        if (parenDepth > 0) space(); else newline();
      } else if (value === ',') {
        write(','); space();
      } else if (value === '(') {
        if (previous && ['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'when'].includes(previous.value)) space();
        write('('); parenDepth++;
      } else if (value === ')') {
        write(')'); parenDepth = Math.max(0, parenDepth - 1);
      } else if (value === '[') {
        if (previous && ['return', 'yield'].includes(previous.value)) space();
        write('['); bracketDepth++;
      } else if (value === ']') {
        write(']'); bracketDepth = Math.max(0, bracketDepth - 1);
      } else if (value === '.') {
        write('.');
      } else if (value === '?.' || value === '::') {
        write(value);
      } else if (value === ':') {
        write(':');
        if (line.trimStart().startsWith('case ') || line.trimStart().startsWith('default:')) newline(); else space();
      } else if (['++', '--'].includes(value)) {
        if (unary(token, previous)) write(value); else { write(value); }
      } else if (value === '!' && previous && (wordLike(previous) || [')', ']', '}'].includes(previous.value))) {
        write('!');
      } else if (['!', '~'].includes(value) && unary(token, previous)) {
        write(value);
      } else if (['+', '-', '*', '&', '|', '^', '!', '~'].includes(value) && unary(token, previous)) {
        write(value);
      } else if (['=', '==', '!=', '<=', '>=', '&&', '||', '??', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->', '=>', '%', '^', '|', '&', '*', '/', '<', '>', '+', '-'].includes(value) && !genericAngles.has(index)) {
        space(); write(value); space();
      } else if (value === '?') {
        let hasTernaryColon = false;
        for (let lookahead = index + 1; lookahead < tokens.length; lookahead++) {
          if (tokens[lookahead].value === ':') { hasTernaryColon = true; break; }
          if ([';', ',', ')', '}'].includes(tokens[lookahead].value)) break;
        }
        const nullable = !hasTernaryColon && wordLike(previous) && !['return', 'case'].includes(previous.value);
        if (!nullable) space();
        write('?');
        if (!nullable || wordLike(next)) space();
      } else {
        if (wordLike(token) && wordLike(previous)) space();
        else if (previous && previous.value === ')' && wordLike(token)) space();
        else if (previous && previous.value === '}' && ![';', ',', '.', '?.', ')', ']'].includes(value)) space();
        else if (previous && previous.value === ']' && wordLike(token)) space();
        write(value);
      }
      previous = token;
    });
    flushLine();
    while (output.length && output[output.length - 1] === '') output.pop();
    return output.join('\n');
  }

  let languageConfigured = false;
  let themesConfigured = false;

  if (new URLSearchParams(window.location.search).has('equipmentFlowLocal')) {
    const keepLocalServerAlive = () => fetch('/__keepalive', { cache: 'no-store' }).catch(() => {});
    keepLocalServerAlive();
    window.setInterval(keepLocalServerAlive, 60_000);
  }

  const monacoReady = window.EquipmentFlowMonacoReady || Promise.reject(new Error('Monaco ESM bootstrap is missing.'));

  function configureCSharp(monaco) {
    if (languageConfigured) return;
    languageConfigured = true;

    if (!monaco.languages.getLanguages().some(language => language.id === 'csharp')) {
      monaco.languages.register({ id: 'csharp', extensions: ['.cs'], aliases: ['C#', 'csharp'] });
    }

    monaco.languages.setMonarchTokensProvider('csharp', {
      defaultToken: '',
      tokenPostfix: '.cs',
      keywords: CSHARP_KEYWORDS,
      typeKeywords: CSHARP_TYPE_KEYWORDS,
      operators: [
        '=', '>', '<', '!', '~', '?', ':', '==', '<=', '>=', '!=', '&&', '||', '++', '--', '+', '-', '*', '/', '&', '|', '^', '%', '<<', '>>', '>>>', '+=', '-=', '*=', '/=', '&=', '|=', '^=', '%=', '<<=', '>>=', '??', '??=', '=>', '?.', '::', '..', '->',
      ],
      symbols: /[=><!~?:&|+\-*\/%^]+/u,
      escapes: /\\(?:[abfnrtv\\"'0]|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/u,
      tokenizer: {
        root: [
          { include: '@whitespace' },
          [/^\s*#\w+/, 'keyword.directive'],
          [/[{}()[\]]/u, '@brackets'],
          [/[<>](?!@symbols)/u, '@brackets'],
          [/\b0[xX][\da-fA-F_]+[uUlL]*\b/u, 'number.hex'],
          [/\b\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?[fFdDmMuUlL]*\b/u, 'number'],
          [/\$@"/u, { token: 'string.quote', next: '@verbatimString' }],
          [/@\$?"/u, { token: 'string.quote', next: '@verbatimString' }],
          [/\$"/u, { token: 'string.quote', next: '@string' }],
          [/"/u, { token: 'string.quote', next: '@string' }],
          [/'(?:\\.|[^'\\])'/u, 'string'],
          [/\b(class)(\s+)([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)/, ['keyword', 'white', 'type.class']],
          [/\b(interface)(\s+)([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)/, ['keyword', 'white', 'type.interface']],
          [/\b(enum)(\s+)([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)/, ['keyword', 'white', 'type.enum']],
          [/\b(struct)(\s+)([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)/, ['keyword', 'white', 'type.struct']],
          [/\b(record)(\s+)(class|struct)(\s+)([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)/, ['keyword', 'white', 'keyword', 'white', 'type.record']],
          [/\b(record)(\s+)([A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*)/, ['keyword', 'white', 'type.record']],
          [/[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*(?=\s*\()/, {
            cases: {
              '@keywords': 'keyword',
              '@typeKeywords': 'type',
              '@default': 'function',
            },
          }],
          [/[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\u0080-\uFFFF]*/, {
            cases: {
              '@typeKeywords': 'type',
              '@keywords': 'keyword',
              '@default': 'identifier',
            },
          }],
          [/@symbols/u, { cases: { '@operators': 'operator', '@default': '' } }],
          [/[;,.]/u, 'delimiter'],
        ],
        whitespace: [
          [/[ \t\r\n]+/u, 'white'],
          [/\/\*\*(?!\/)/u, 'comment.doc', '@docComment'],
          [/\/\*/u, 'comment', '@comment'],
          [/\/\/.*$/u, 'comment'],
        ],
        comment: [
          [/[^/*]+/u, 'comment'],
          [/\*\//u, 'comment', '@pop'],
          [/[/*]/u, 'comment'],
        ],
        docComment: [
          [/[^/*]+/u, 'comment.doc'],
          [/\*\//u, 'comment.doc', '@pop'],
          [/[/*]/u, 'comment.doc'],
        ],
        string: [
          [/[^\\"]+/u, 'string'],
          [/@escapes/u, 'string.escape'],
          [/\\./u, 'string.escape.invalid'],
          [/"/u, { token: 'string.quote', next: '@pop' }],
        ],
        verbatimString: [
          [/[^"]+/u, 'string'],
          [/""/u, 'string.escape'],
          [/"/u, { token: 'string.quote', next: '@pop' }],
        ],
      },
    });

    monaco.languages.setLanguageConfiguration('csharp', {
      comments: { lineComment: '//', blockComment: ['/*', '*/'] },
      brackets: [['{', '}'], ['[', ']'], ['(', ')']],
      autoClosingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"', notIn: ['string', 'comment'] },
        { open: "'", close: "'", notIn: ['string', 'comment'] },
      ],
      surroundingPairs: [
        { open: '{', close: '}' },
        { open: '[', close: ']' },
        { open: '(', close: ')' },
        { open: '"', close: '"' },
        { open: "'", close: "'" },
      ],
      indentationRules: {
        increaseIndentPattern: /^((?!\/\/).)*\{[^}]*$/u,
        decreaseIndentPattern: /^\s*\}/u,
      },
      folding: {
        markers: {
          start: /^\s*#region\b.*$/u,
          end: /^\s*#endregion\b.*$/u,
        },
      },
    });
  }

  function configureThemes(monaco) {
    if (themesConfigured) return;
    themesConfigured = true;

    monaco.editor.defineTheme('equipment-flow-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: '80B8FF' },
        { token: 'type', foreground: '8DD5BC' },
        { token: 'type.identifier', foreground: '8DD5BC' },
        { token: 'type.class', foreground: '73D5F2', fontStyle: 'bold' },
        { token: 'type.interface', foreground: '8DE2B2', fontStyle: 'bold' },
        { token: 'type.enum', foreground: 'E6C878', fontStyle: 'bold' },
        { token: 'type.struct', foreground: 'C2A0F4', fontStyle: 'bold' },
        { token: 'type.record', foreground: 'F1A58B', fontStyle: 'bold' },
        { token: 'function', foreground: 'D7B7FF' },
        { token: 'string', foreground: 'D8C48D' },
        { token: 'number', foreground: 'D2A4F2' },
        { token: 'comment', foreground: '81949D', fontStyle: 'italic' },
        { token: 'comment.doc', foreground: '8FA7B0', fontStyle: 'italic' },
      ],
      colors: {
        'editor.background': '#111a22',
        'editor.foreground': '#d6e2ea',
        'editorLineNumber.foreground': '#72818d',
        'editorLineNumber.activeForeground': '#dbe7ef',
        'editorCursor.foreground': '#f0c674',
        'editor.lineHighlightBackground': '#18232e',
        'editor.selectionBackground': '#365a78aa',
        'editorSuggestWidget.background': '#16232e',
        'editorSuggestWidget.foreground': '#d6e2ea',
        'editorSuggestWidget.selectedBackground': '#284459',
        'editorSuggestWidget.border': '#4d6474',
        'editorWidget.border': '#4d6474',
      },
    });

    monaco.editor.defineTheme('equipment-flow-light', {
      base: 'vs',
      inherit: true,
      rules: [
        { token: 'keyword', foreground: '0756A8' },
        { token: 'type', foreground: '08785D' },
        { token: 'type.identifier', foreground: '08785D' },
        { token: 'type.class', foreground: '006F91', fontStyle: 'bold' },
        { token: 'type.interface', foreground: '167846', fontStyle: 'bold' },
        { token: 'type.enum', foreground: '8A5B00', fontStyle: 'bold' },
        { token: 'type.struct', foreground: '7041A0', fontStyle: 'bold' },
        { token: 'type.record', foreground: 'A44725', fontStyle: 'bold' },
        { token: 'function', foreground: '7041A0' },
        { token: 'string', foreground: '8A4B00' },
        { token: 'number', foreground: '7A38A8' },
        { token: 'comment', foreground: '73818B', fontStyle: 'italic' },
        { token: 'comment.doc', foreground: '647A87', fontStyle: 'italic' },
      ],
      colors: {
        'editor.background': '#fbfcfd',
        'editor.foreground': '#26323a',
        'editorLineNumber.foreground': '#87949d',
        'editorLineNumber.activeForeground': '#3f4b54',
        'editorCursor.foreground': '#1466a8',
        'editor.lineHighlightBackground': '#eef3f7',
        'editor.selectionBackground': '#9dc5e777',
        'editorSuggestWidget.background': '#ffffff',
        'editorSuggestWidget.foreground': '#26323a',
        'editorSuggestWidget.selectedBackground': '#e2edf6',
        'editorSuggestWidget.border': '#c7d2dc',
        'editorWidget.border': '#c7d2dc',
      },
    });
  }

  function getFontOptions() {
    const style = window.getComputedStyle(document.documentElement);
    const fontFamily = style.getPropertyValue('--method-code-font-family').trim()
      || 'Consolas, "Cascadia Code", monospace';
    const fontSize = Number.parseFloat(style.getPropertyValue('--method-code-font-size')) || 15;
    return { fontFamily, fontSize, lineHeight: Math.round(fontSize * 1.62) };
  }

  function currentThemeName() {
    return document.documentElement.dataset.theme === 'dark'
      ? 'equipment-flow-dark'
      : 'equipment-flow-light';
  }

  // Find multi-line C# brace and #region blocks while ignoring strings and comments.
  function findCSharpFoldRanges(source) {
    const lines = String(source || '').split(/\r\n|\n|\r/);
    const ranges = [];
    const braceStack = [];
    const regionStack = [];
    let mode = 'code';
    let rawQuoteCount = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];
      const region = line.match(/^\s*#\s*(region|endregion)\b/i);
      if (region && region[1].toLowerCase() === 'region') regionStack.push(lineIndex + 1);
      else if (region && regionStack.length) {
        const startLine = regionStack.pop();
        if (lineIndex + 1 > startLine + 1) ranges.push({ kind: 'region', startLine, endLine: lineIndex + 1 });
      }

      for (let column = 0; column < line.length;) {
        const current = line[column];
        const next = line[column + 1];

        if (mode === 'block-comment') {
          if (current === '*' && next === '/') { mode = 'code'; column += 2; }
          else column++;
          continue;
        }
        if (mode === 'string') {
          if (current === '\\') column += 2;
          else if (current === '"') { mode = 'code'; column++; }
          else column++;
          continue;
        }
        if (mode === 'verbatim-string') {
          if (current === '"' && next === '"') column += 2;
          else if (current === '"') { mode = 'code'; column++; }
          else column++;
          continue;
        }
        if (mode === 'raw-string') {
          if (current === '"') {
            let quoteCount = 1;
            while (line[column + quoteCount] === '"') quoteCount++;
            if (quoteCount >= rawQuoteCount) { mode = 'code'; column += rawQuoteCount; }
            else column += quoteCount;
          } else column++;
          continue;
        }
        if (mode === 'character') {
          if (current === '\\') column += 2;
          else if (current === "'") { mode = 'code'; column++; }
          else column++;
          continue;
        }

        if (current === '/' && next === '/') break;
        if (current === '/' && next === '*') { mode = 'block-comment'; column += 2; continue; }
        if (current === '"') {
          let quoteCount = 1;
          while (line[column + quoteCount] === '"') quoteCount++;
          if (quoteCount >= 3) { mode = 'raw-string'; rawQuoteCount = quoteCount; column += quoteCount; continue; }
          const prefix = line.slice(Math.max(0, column - 2), column);
          mode = /(?:@\$|\$@|@)$/.test(prefix) ? 'verbatim-string' : 'string';
          column++;
          continue;
        }
        if (current === "'") { mode = 'character'; column++; continue; }
        if (current === '{') braceStack.push({ lineIndex, column });
        else if (current === '}' && braceStack.length) {
          const opening = braceStack.pop();
          if (lineIndex <= opening.lineIndex) { column++; continue; }
          let startLine = opening.lineIndex + 1;
          if (!lines[opening.lineIndex].slice(0, opening.column).trim()) {
            for (let previous = opening.lineIndex - 1; previous >= 0; previous--) {
              if (lines[previous].trim()) { startLine = previous + 1; break; }
            }
          }
          if (lineIndex + 1 > startLine + 1) ranges.push({ kind: 'brace', startLine, endLine: lineIndex + 1 });
        }
        column++;
      }

      if (mode === 'string' || mode === 'character') mode = 'code';
    }

    const unique = new Map();
    ranges.forEach(range => {
      if (range.endLine <= range.startLine + 1) return;
      range.key = `${range.kind}:${range.startLine}:${range.endLine}`;
      unique.set(range.key, range);
    });
    return Array.from(unique.values()).sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
  }

  function mount(options) {
    const textarea = options.textarea;
    const host = options.container;
    let editor = null;
    let resizeObserver = null;
    let isSynchronizing = false;
    let monacoApi = null;
    let foldRanges = [];
    let lastHiddenAreas = '';
    const collapsedFoldKeys = new Set();
    const foldOverlay = document.createElement('div');
    foldOverlay.className = 'method-code-fold-controls';
    foldOverlay.setAttribute('aria-label', '代码块折叠控件');
    host.parentElement?.appendChild(foldOverlay);

    function renderFoldControls() {
      if (!editor || !monacoApi || typeof editor.setHiddenAreas !== 'function') return;
      const model = editor.getModel();
      if (!model) return;
      foldRanges = findCSharpFoldRanges(editor.getValue());
      const validKeys = new Set(foldRanges.map(range => range.key));
      collapsedFoldKeys.forEach(key => { if (!validKeys.has(key)) collapsedFoldKeys.delete(key); });

      const sortedCollapsed = foldRanges.filter(range => collapsedFoldKeys.has(range.key));
      const visibleCollapsed = [];
      sortedCollapsed.forEach(range => {
        if (visibleCollapsed.some(parent => range.startLine > parent.startLine && range.endLine <= parent.endLine)) return;
        visibleCollapsed.push(range);
      });
      const hiddenSignature = visibleCollapsed.map(range => range.key).join('|');
      if (hiddenSignature !== lastHiddenAreas) {
        const hiddenAreas = visibleCollapsed.map(range => {
          const startLine = range.startLine + 1;
          const endLine = Math.min(range.endLine, model.getLineCount());
          return new monacoApi.Range(startLine, 1, endLine, model.getLineMaxColumn(endLine));
        });
        editor.setHiddenAreas(hiddenAreas);
        lastHiddenAreas = hiddenSignature;
      }

      foldOverlay.replaceChildren();
      const layout = editor.getLayoutInfo();
      const lineHeight = editor.getOption(monacoApi.editor.EditorOption.lineHeight);
      const scrollTop = editor.getScrollTop();
      const viewportHeight = host.clientHeight;
      const left = layout.glyphMarginWidth > 0
        ? layout.glyphMarginLeft + Math.max(0, (layout.glyphMarginWidth - 15) / 2)
        : layout.lineNumbersLeft + layout.lineNumbersWidth + 2;

      foldRanges.forEach(range => {
        // Fold controls inside a collapsed parent are themselves hidden in
        // the editor; omitting them prevents overlapping buttons in the gutter.
        if (visibleCollapsed.some(parent => range.startLine > parent.startLine && range.startLine <= parent.endLine)) return;
        const top = editor.getTopForLineNumber(range.startLine) - scrollTop + 1;
        if (top + lineHeight < 0 || top > viewportHeight) return;
        const collapsed = collapsedFoldKeys.has(range.key);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `method-code-fold-control${collapsed ? ' is-collapsed' : ''}`;
        button.style.left = `${left}px`;
        button.style.top = `${top + Math.max(0, (lineHeight - 15) / 2)}px`;
        button.textContent = collapsed ? '▸' : '▾';
        button.title = `${collapsed ? '展开' : '折叠'}${range.kind === 'region' ? ' Region' : '代码块'}（第 ${range.startLine}–${range.endLine} 行）`;
        button.setAttribute('aria-label', button.title);
        button.setAttribute('aria-expanded', String(!collapsed));
        button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
        button.addEventListener('click', event => {
          event.preventDefault(); event.stopPropagation();
          if (collapsedFoldKeys.has(range.key)) collapsedFoldKeys.delete(range.key);
          else collapsedFoldKeys.add(range.key);
          renderFoldControls();
          editor.focus();
        });
        foldOverlay.appendChild(button);
      });
    }

    const editorReady = monacoReady.then(monaco => {
      monacoApi = monaco;
      configureCSharp(monaco);
      configureThemes(monaco);
      monaco.editor.setTheme(currentThemeName());

      editor = monaco.editor.create(host, {
        value: textarea.value,
        language: 'csharp',
        theme: currentThemeName(),
        automaticLayout: true,
        minimap: { enabled: false },
        // Monaco renders its fold controls in the glyph margin. Keep that
        // lane enabled so brace and #region folding are directly discoverable.
        glyphMargin: true,
        lineNumbers: 'on',
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        wordWrap: 'off',
        smoothScrolling: true,
        mouseWheelScrollSensitivity: 1,
        tabSize: 4,
        insertSpaces: true,
        detectIndentation: false,
        autoIndent: 'full',
        autoClosingBrackets: 'always',
        autoClosingQuotes: 'languageDefined',
        bracketPairColorization: { enabled: true },
        folding: true,
        // Use Monaco's indentation folding fallback; this standalone bundle
        // does not include a C# syntax folding provider.
        foldingStrategy: 'indentation',
        showFoldingControls: 'always',
        unfoldOnClickAfterEndOfLine: true,
        guides: { indentation: true, highlightActiveIndentation: true },
        quickSuggestions: { other: 'on', comments: 'off', strings: 'off' },
        quickSuggestionsDelay: 100,
        suggestOnTriggerCharacters: true,
        acceptSuggestionOnEnter: 'on',
        tabCompletion: 'on',
        wordBasedSuggestions: 'currentDocument',
        fixedOverflowWidgets: true,
        contextmenu: true,
        renderLineHighlight: 'line',
        renderWhitespace: 'selection',
        padding: { top: 12, bottom: 12 },
        scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12 },
        ...getFontOptions(),
      });

      editor.onDidChangeModelContent(() => {
        if (isSynchronizing) return;
        textarea.value = editor.getValue();
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        collapsedFoldKeys.clear();
        renderFoldControls();
      });
      editor.onDidScrollChange(renderFoldControls);
      editor.onDidLayoutChange(renderFoldControls);
      renderFoldControls();
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => { if (editor) editor.layout(); });
        resizeObserver.observe(host);
      }

      monaco.languages.registerCompletionItemProvider('csharp', {
        triggerCharacters: ['.'],
        provideCompletionItems(model, position, context) {
          const word = model.getWordUntilPosition(position);
          const lineBeforeCursor = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
          const forced = context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke;
          if (!word.word && !lineBeforeCursor.trimEnd().endsWith('.') && !forced) return { suggestions: [] };

          let available = [];
          try {
            available = typeof options.getCompletions === 'function' ? options.getCompletions() : [];
          } catch (error) {
            console.warn('C# completion source is unavailable.', error);
          }

          const query = word.word.toLowerCase();
          const range = {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn,
          };
          const kindMap = {
            method: monaco.languages.CompletionItemKind.Method,
            hardware: monaco.languages.CompletionItemKind.Field,
            parameter: monaco.languages.CompletionItemKind.Variable,
            keyword: monaco.languages.CompletionItemKind.Keyword,
            type: monaco.languages.CompletionItemKind.Class,
          };

          const suggestions = available
            .filter(item => {
              const label = String(typeof item === 'string' ? item : item.label || '');
              const candidate = label.toLowerCase();
              return label && (!query || candidate.startsWith(query) || candidate.includes(query));
            })
            .slice(0, 40)
            .map((item, index) => {
              const entry = typeof item === 'string' ? { label: item, kind: 'keyword' } : item;
              const label = String(entry.label || '');
              return {
                label,
                kind: kindMap[entry.kind] || monaco.languages.CompletionItemKind.Text,
                insertText: entry.insertText || label,
                detail: entry.detail || '',
                filterText: label,
                sortText: `${String(index).padStart(2, '0')}_${label}`,
                range,
              };
            });

          return { suggestions };
        },
      });

      const themeObserver = new MutationObserver(() => {
        monaco.editor.setTheme(currentThemeName());
      });
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      return editor;
    }).catch(error => {
      host.classList.add('monaco-load-failed');
      host.parentElement?.classList.add('monaco-load-failed');
      host.hidden = true;
      textarea.hidden = false;
      textarea.removeAttribute('aria-hidden');
      textarea.tabIndex = 0;
      const notice = document.createElement('div');
      notice.className = 'method-code-fallback-notice';
      notice.textContent = window.location.protocol === 'file:'
        ? '当前页面以本地文件方式打开，浏览器会阻止 Monaco 模块启动。基础编辑已启用；使用目录中的 OpenInBrowser.cmd 可启用完整提示。'
        : `Monaco 启动失败，已切换到基础代码编辑框：${error?.message || '未知错误'}`;
      host.parentElement.insertBefore(notice, textarea);
      host.title = String(error && error.message || error);
      console.error('Unable to initialize Monaco Editor.', error);
      return null;
    });

    function paint() {
      if (!editor) return;
      if (editor.getValue() !== textarea.value) {
        isSynchronizing = true;
        editor.setValue(textarea.value || '');
        isSynchronizing = false;
      }
      editor.updateOptions(getFontOptions());
      editor.layout();
    }

    function layout() {
      if (editor) editor.layout();
      else editorReady.then(current => current && current.layout());
    }

    function focus() {
      if (editor) editor.focus();
      else editorReady.then(current => current ? current.focus() : textarea.focus());
    }

    function getSelectedText() {
      if (editor) {
        const selection = editor.getSelection();
        return selection && !selection.isEmpty() ? editor.getModel().getValueInRange(selection) : '';
      }
      const start = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : 0;
      const end = Number.isInteger(textarea.selectionEnd) ? textarea.selectionEnd : 0;
      return start === end ? textarea.value : textarea.value.slice(start, end);
    }

    function hasSelection() {
      if (editor) {
        const selection = editor.getSelection();
        return Boolean(selection && !selection.isEmpty());
      }
      return Number.isInteger(textarea.selectionStart) && textarea.selectionStart !== textarea.selectionEnd;
    }

    function runAction(action) {
      if (action === 'delete') {
        if (editor) {
          const selection = editor.getSelection();
          if (!selection || selection.isEmpty()) return false;
          editor.executeEdits('method-code-delete', [{ range: selection, text: '' }]);
          editor.focus();
          return true;
        }
        if (!hasSelection()) return false;
        const start = Math.min(textarea.selectionStart, textarea.selectionEnd);
        textarea.setRangeText('', start, Math.max(textarea.selectionStart, textarea.selectionEnd), 'start');
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
        return true;
      }

      const commandIds = {
        cut: 'editor.action.clipboardCutAction',
        copy: 'editor.action.clipboardCopyAction',
        paste: 'editor.action.clipboardPasteAction',
      };
      if (!commandIds[action]) return false;
      if (editor) {
        editor.focus();
        editor.trigger('method-code-toolbar', commandIds[action], null);
        return true;
      }
      textarea.focus();
      try { return document.execCommand(action); } catch (_) { return false; }
    }

    function formatDocument() {
      const before = editor ? editor.getValue() : textarea.value;
      const formatted = formatCSharpierStyle(before);
      if (formatted === before) return false;
      if (editor) {
        const model = editor.getModel();
        const position = editor.getPosition();
        const offset = position ? model.getOffsetAt(position) : 0;
        editor.executeEdits('csharpier-format', [{ range: model.getFullModelRange(), text: formatted }]);
        editor.setPosition(model.getPositionAt(Math.min(offset, formatted.length)));
        editor.focus();
      } else {
        const offset = Number.isInteger(textarea.selectionStart) ? textarea.selectionStart : 0;
        textarea.value = formatted;
        textarea.setSelectionRange(Math.min(offset, formatted.length), Math.min(offset, formatted.length));
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.focus();
      }
      return true;
    }

    return { paint, layout, focus, getValue: () => textarea.value, getSelectedText, hasSelection, runAction, formatDocument };
  }

  window.EquipmentFlowCodeEditor = { mount };
})();
