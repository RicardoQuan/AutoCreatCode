(() => {
  'use strict';

  const TYPE_LABELS = { Input: '输入 IO', Output: '输出 IO', Axis: '轴', ParName: '参数枚举', GenericEnum: '通用枚举' };
  const DEFAULTS = { Input: ['InNo', 'I/O Enum'], Output: ['OutNo', 'I/O Enum'], Axis: ['mAxis', 'Axis-Enum'], ParName: ['UserPar', 'Par-Enum'], GenericEnum: ['NewEnum', 'Custom Enum'] };
  const TYPE_OPTIONS = Object.keys(TYPE_LABELS);
  const HANDLE_DATABASE = 'botech-equipment-flow-handles';
  const HANDLE_STORE = 'handles';
  let host = null;
  let activeWorkbookId = '';
  let activeSheetId = '';
  let workbookFileHandles = new Map();
  let excelDirectoryHandles = new Map();
  let csharpDirectoryHandles = new Map();
  let importFileInput = null;
  let pendingImport = null;
  let pendingNewSheetImport = null;
  let editingSheetId = '';
  let normalizedWorkspace = null;

  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const id = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const safeFileName = value => String(value || 'EnumName').replace(/[\\/:*?"<>|]/g, '_').trim() || 'EnumName';
  const isBackupSheetName = name => /备份|backup/i.test(String(name || ''));
  const normalizeExcelFileName = (value, fallback = 'NewEnum') => {
    const raw = String(value == null ? '' : value).trim() || String(fallback || 'NewEnum').trim() || 'NewEnum';
    return `${safeFileName(raw.replace(/\.(?:xlsx|xls|csv|tsv)$/iu, ''))}.xlsx`;
  };
  const sheetExcelFileName = sheet => normalizeExcelFileName(sheet?.FileName || sheet?.Name || 'NewEnum');
  function suggestedSheetFileName(sourceName, sheetName, index, total) {
    const sourceBase = String(sourceName || '').replace(/\.[^.]+$/u, '').trim() || 'Sheet';
    const suffix = index > 0 && total > 1 ? `_${safeFileName(sheetName || `Sheet${index + 1}`)}` : '';
    return normalizeExcelFileName(`${sourceBase}${suffix}`);
  }
  function uniqueExcelFileName(value, usedNames) {
    const normalized = normalizeExcelFileName(value);
    const extension = '.xlsx', base = normalized.slice(0, -extension.length);
    let candidate = normalized, suffix = 2;
    while (usedNames.has(candidate.toLowerCase())) candidate = `${base}_${suffix++}${extension}`;
    usedNames.add(candidate.toLowerCase());
    return candidate;
  }
  const getWorkspace = () => host && host.getWorkspace();
  const allWorkbooks = () => {
    const workspace = getWorkspace();
    if (!workspace) return [];
    if (!Array.isArray(workspace.EnumWorkbooks)) workspace.EnumWorkbooks = [];
    if (normalizedWorkspace !== workspace) {
      const books = workspace.EnumWorkbooks;
      if (books.length > 1) {
        const primary = books[0];
        primary.Sheets = Array.isArray(primary.Sheets) ? primary.Sheets : [];
        const sheetNames = new Set(primary.Sheets.map(sheet => String(sheet.Name || '').toLowerCase()));
        books.slice(1).forEach(book => (book.Sheets || []).forEach(sheet => {
          const baseName = String(sheet.Name || sheet.EnumName || 'Sheet');
          let name = baseName, suffix = 2;
          while (sheetNames.has(name.toLowerCase())) name = `${baseName}_${suffix++}`;
          sheet.Name = name; sheetNames.add(name.toLowerCase()); primary.Sheets.push(sheet);
        }));
        primary.Sources = [...(primary.Sources || []), ...books.slice(1).flatMap(book => book.Sources || [{ FileName: book.FileName || `${book.Name || 'Enum'}.xlsx`, Type: 'GenericEnum' }])];
        primary.EnumRegions = Array.from(new Set([...(primary.EnumRegions || []), ...books.slice(1).flatMap(book => book.EnumRegions || [])]));
        primary.ExcelDirectoryName ||= primary.OutputDirectoryName || books.slice(1).find(book => book.ExcelDirectoryName || book.OutputDirectoryName)?.ExcelDirectoryName || books.slice(1).find(book => book.OutputDirectoryName)?.OutputDirectoryName || '';
        primary.CSharpOutputDirectoryName ||= books.slice(1).find(book => book.CSharpOutputDirectoryName)?.CSharpOutputDirectoryName || '';
        primary.CSharpOutputDirectoryPath ||= books.slice(1).find(book => book.CSharpOutputDirectoryPath)?.CSharpOutputDirectoryPath || '';
        workspace.EnumWorkbooks = [primary];
      }
      normalizedWorkspace = workspace;
    }
    if (workspace.EnumWorkbooks[0]) {
      const book = workspace.EnumWorkbooks[0];
      if (!Array.isArray(book.Sheets)) book.Sheets = [];
      if (!Array.isArray(book.Sources)) book.Sources = [];
      if (!Array.isArray(book.EnumRegions)) book.EnumRegions = [];
      book.Sheets.forEach(sheet => {
        sheet.EnumName = sheet.Name || sheet.EnumName || 'NewEnum';
        sheet.RegionName = sheet.Name || sheet.RegionName || 'NewEnum';
        sheet.FileName = sheetExcelFileName(sheet);
      });
      book.ExcelDirectoryName ||= book.OutputDirectoryName || '';
      book.CSharpOutputDirectoryName ||= '';
      book.CSharpOutputDirectoryPath ||= '';
      if (activeWorkbookId !== book.WorkbookId) activeWorkbookId = book.WorkbookId;
    }
    return workspace.EnumWorkbooks;
  };
  const activeWorkbook = () => allWorkbooks().find(book => book.WorkbookId === activeWorkbookId) || null;
  const activeSheet = () => {
    const workbook = activeWorkbook();
    return workbook && (workbook.Sheets || []).find(sheet => sheet.SheetId === activeSheetId) || null;
  };
  const persist = () => { if (host) host.persist(); };
  const status = (message, kind = 'normal') => {
    const text = String(message || '');
    const detectedKind = kind === 'warning' || kind === 'error' ? kind
      : /失败|错误|无效|无法|不能|未找到|不支持|校验发现|缺少|重复|已存在|必须|超出/.test(text) ? 'error'
        : /成功|已.+(?:生成|保存|导入|导出|更新|删除|新增|创建|恢复|读取|写入|设置|重命名|复制|另存)|校验通过/.test(text) ? 'success'
          : kind;
    const statusElement = $('#enumWorkbenchStatus');
    statusElement.textContent = message;
    statusElement.dataset.state = detectedKind;
    if (host) host.status(message, detectedKind);
  };

  // Browser file handles: persist directory permissions between editing sessions when supported.
  function openHandleDatabase() {
    if (!window.indexedDB) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(HANDLE_DATABASE, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(HANDLE_STORE)) request.result.createObjectStore(HANDLE_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('无法打开本地文件关联存储。'));
    });
  }

  async function storeHandle(key, handle) {
    const database = await openHandleDatabase(); if (!database) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, 'readwrite');
      transaction.objectStore(HANDLE_STORE).put(handle, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('无法保存文件路径关联。'));
    });
    database.close();
  }

  async function loadHandle(key) {
    const database = await openHandleDatabase(); if (!database) return null;
    const handle = await new Promise((resolve, reject) => {
      const request = database.transaction(HANDLE_STORE, 'readonly').objectStore(HANDLE_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('无法读取文件路径关联。'));
    });
    database.close();
    return handle;
  }

  async function removeHandle(key) {
    const database = await openHandleDatabase(); if (!database) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, 'readwrite');
      transaction.objectStore(HANDLE_STORE).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('无法移除文件路径关联。'));
    });
    database.close();
  }

  async function restoreWorkbookHandles() {
    for (const workbook of allWorkbooks()) {
      try {
        const fileHandle = await loadHandle(`enum-xlsx:${workbook.WorkbookId}`);
        const excelHandle = await loadHandle(`enum-excel-output:${workbook.WorkbookId}`) || await loadHandle(`enum-output:${workbook.WorkbookId}`);
        const csharpHandle = await loadHandle(`enum-csharp-output:${workbook.WorkbookId}`);
        if (fileHandle && !workbookFileHandles.has(workbook.WorkbookId)) workbookFileHandles.set(workbook.WorkbookId, fileHandle);
        if (excelHandle && !excelDirectoryHandles.has(workbook.WorkbookId)) excelDirectoryHandles.set(workbook.WorkbookId, excelHandle);
        if (csharpHandle && !csharpDirectoryHandles.has(workbook.WorkbookId)) csharpDirectoryHandles.set(workbook.WorkbookId, csharpHandle);
      } catch (_) { /* Workbook data remains available if handle storage was cleared. */ }
    }
    render();
  }

  // Workbook and sheet management: create projects, edit sheet metadata, and render tabs.
  function makeSheet(name, type) {
    const defaults = DEFAULTS[type] || DEFAULTS.GenericEnum;
    const sheetName = name || defaults[0];
    const sheet = { SheetId: id('enum_sheet'), Name: sheetName, FileName: normalizeExcelFileName(sheetName), Type: type, ParListKind: type === 'ParName' ? 'UserPar' : '', EnumName: sheetName, RegionName: sheetName, Columns: ['Name', 'Value', 'Comment'], DataRows: [], EnumMapping: { Name: 0, Value: 1, Comment: 2 }, Rows: [] };
    return sheet;
  }

  function makeBlankParListSheet(name, kind, fileName) {
    const sheet = makeSheet(name, 'ParName');
    sheet.FileName = fileName;
    sheet.ParListKind = kind;
    sheet.Columns = ['参数名称Cn', '参数名称En', '分类', '上限', '下限', '参数单位', '序号', '功能名称Cn', '功能名称En', '功能分类'];
    sheet.EnumMapping = kind === 'UserPar'
      ? { Name: 1, Value: 6, Comment: 0 }
      : { Name: 8, Value: 6, Comment: 7 };
    refreshSheetProjection(sheet);
    return sheet;
  }

  function sheetTypeKey(sheet) {
    return sheet.Type === 'ParName' ? `ParName:${sheet.ParListKind || 'UserPar'}` : sheet.Type;
  }

  function openWorkbook() {
    render();
    if (host && host.setView) host.setView('enum');
  }

  function openNewWorkbook() {
    if (host && host.setView) host.setView('enum');
    if (activeWorkbook()) { status('当前工程已经有唯一的枚举集；可继续导入 Excel 或新增 Sheet。'); return; }
    $('#newEnumWorkbookForm').reset();
    $('#newEnumWorkbookNameInput').value = '';
    $('#newEnumWorkbookSheetNameInput').value = 'InNo';
    $('#newEnumWorkbookTypeInput').value = 'Input';
    $('#newEnumWorkbookImportFile').value = '';
    showDialog('newEnumWorkbookDialog');
    setTimeout(() => $('#newEnumWorkbookNameInput').focus(), 0);
  }

  function closeDialog(dialogId) {
    const dialog = document.getElementById(dialogId);
    if (dialog && dialog.open) dialog.close();
  }

  function showDialog(dialogId) {
    const dialog = document.getElementById(dialogId);
    if (dialog && !dialog.open) dialog.showModal();
  }

  function createWorkbook(event) {
    event.preventDefault();
    if (activeWorkbook()) { closeDialog('newEnumWorkbookDialog'); status('当前工程已经有唯一的枚举集。'); return; }
    const name = $('#newEnumWorkbookNameInput').value.trim();
    const type = $('#newEnumWorkbookTypeInput').value;
    const enumName = $('#newEnumWorkbookSheetNameInput').value.trim();
    if (!name || !enumName) return;
    if (!validSheetName(enumName)) { status('第一个 Sheet 名同时作为 C# 枚举名，请输入有效的 C# 标识符。'); return; }
    if (type === 'ParName' && enumName.toLowerCase() === 'funchk') { status('UserPar 与 FuncChk 的枚举名不能相同。'); return; }
    const importFile = $('#newEnumWorkbookImportFile').files?.[0];
    if (importFile) {
      closeDialog('newEnumWorkbookDialog');
      importWorkbook(importFile, { workbookName: name, initialType: type }).catch(error => {
        status(`Excel 导入失败：${error.message || error}`);
      });
      return;
    }
    const outputFileName = `${safeFileName(name)}.xlsx`;
    const firstSheet = type === 'ParName' ? makeBlankParListSheet(enumName, 'UserPar', outputFileName) : makeSheet(enumName, type);
    firstSheet.FileName = outputFileName;
    const sheets = type === 'ParName' ? [firstSheet, makeBlankParListSheet('FuncChk', 'FuncChk', outputFileName)] : [firstSheet];
    const workbook = {
      WorkbookId: id('enum_book'), Name: name, FileName: `${safeFileName(name)}.xlsx`,
      Namespace: 'ParName', ExcelDirectoryName: '', CSharpOutputDirectoryName: '', Sources: [], Sheets: sheets,
    };
    allWorkbooks().push(workbook);
    activeWorkbookId = workbook.WorkbookId;
    activeSheetId = sheets[0].SheetId;
    closeDialog('newEnumWorkbookDialog');
    render(); persist(); openWorkbook();
    status(`已创建工作簿 ${name}。`);
  }

  function validSheetName(value) {
    const name = String(value || '').trim();
    return /^[_\p{L}][\p{L}\p{N}_]*$/u.test(name)
      && !/^(class|enum|struct|namespace|public|private|void|int|return|out|ref|new|static|bool|string|object)$/iu.test(name);
  }

  function openSheetDialog(sheet = null) {
    editingSheetId = sheet?.SheetId || '';
    pendingNewSheetImport = null;
    $('#newEnumSheetForm').reset();
    $('#newEnumSheetNameInput').value = sheet?.Name || DEFAULTS.GenericEnum[0];
    $('#newEnumSheetFileNameInput').value = sheetExcelFileName(sheet || { Name: $('#newEnumSheetNameInput').value });
    $('#newEnumSheetFileNameInput').dataset.autoName = sheet ? 'false' : 'true';
    const typeInput = $('#newEnumSheetTypeInput');
    const workbook = activeWorkbook();
    Array.from(typeInput.options).forEach(option => {
      option.disabled = option.value === 'ParName'
        ? !sheet || sheet.Type !== 'ParName'
        : (workbook?.Sheets || []).some(item => item !== sheet && item.Type === option.value);
    });
    const preferredType = sheet?.Type || Array.from(typeInput.options).find(option => !option.disabled)?.value || 'GenericEnum';
    typeInput.value = preferredType;
    $('#newEnumSheetImportFile').value = '';
    $('#newEnumSheetImportChoiceField').classList.add('hidden');
    $('#newEnumSheetImportChoice').replaceChildren();
    $('#newEnumSheetTitle').textContent = sheet ? '编辑枚举 Sheet' : '新建枚举 Sheet';
    $('#confirmNewEnumSheetButton').textContent = sheet ? '保存修改' : '新建 Sheet';
    $('#newEnumSheetImportFile').disabled = Boolean(sheet);
    showDialog('newEnumSheetDialog');
  }

  function createSheet(event) {
    event.preventDefault();
    const workbook = activeWorkbook();
    if (!workbook) { status('请先新建或导入枚举工作簿。'); return; }
    const name = $('#newEnumSheetNameInput').value.trim();
    const fileName = normalizeExcelFileName($('#newEnumSheetFileNameInput').value, name);
    const type = $('#newEnumSheetTypeInput').value;
    if (!name) return;
    if (!validSheetName(name)) { status('Sheet 名称同时作为 C# 枚举名，请输入有效的 C# 标识符。'); return; }
    const editing = workbook.Sheets.find(sheet => sheet.SheetId === editingSheetId);
    if (type === 'ParName' && (!editing || editing.Type !== 'ParName')) {
      status('ParList 会同时建立 UserPar 与 FuncChk，请通过 ParList Excel 导入或新建 ParList 工作簿。'); return;
    }
    if ((workbook.Sheets || []).some(sheet => sheet !== editing && sheet.Name.toLowerCase() === name.toLowerCase())) {
      status(`Sheet ${name} 已存在。`); return;
    }
    const nextTypeKey = type === 'ParName' ? `ParName:${editing.ParListKind || 'UserPar'}` : type;
    if ((workbook.Sheets || []).some(sheet => sheet !== editing && sheetTypeKey(sheet) === nextTypeKey)) {
      status(`${TYPE_LABELS[type]} 已有对应 Sheet；每种枚举类型只允许一个 Sheet。`); return;
    }
    const duplicateFileSheet = (workbook.Sheets || []).find(sheet => sheet !== editing && sheetExcelFileName(sheet).toLowerCase() === fileName.toLowerCase());
    const isParListPair = type === 'ParName' && editing?.Type === 'ParName' && duplicateFileSheet?.Type === 'ParName' && duplicateFileSheet.ParListKind !== editing.ParListKind;
    if (duplicateFileSheet && !isParListPair) {
      status(`Excel 文件名 ${fileName} 已被其他 Sheet 使用。`); return;
    }
    if (editing) {
      if (editing.Type === 'ParName' && type === 'ParName') {
        const companion = workbook.Sheets.find(sheet => sheet !== editing && sheet.Type === 'ParName' && sheet.ParListKind !== editing.ParListKind);
        if (companion) companion.FileName = fileName;
      }
      editing.Name = name; editing.FileName = fileName; editing.EnumName = name; editing.RegionName = name;
      editing.Type = type; editing.EnumMapping = mapColumns(editing.Columns || [], type); refreshSheetProjection(editing);
      activeSheetId = editing.SheetId;
      closeDialog('newEnumSheetDialog'); render(); persist();
      status(`已更新 ${TYPE_LABELS[type]} Sheet：${name}`);
      return;
    }
    const importedIndex = Number($('#newEnumSheetImportChoice').value || 0);
    const imported = pendingNewSheetImport?.sheets?.[importedIndex];
    let sheet;
    if (imported) {
      const source = pendingNewSheetImport.file;
      sheet = convertSheet(imported, type, importedIndex, source.name, {
        name, fileName, enumName: name, type, path: source.path || source.webkitRelativePath || source.name,
      });
      sheet.Name = name; sheet.FileName = fileName; sheet.EnumName = name; sheet.RegionName = name;
    } else { sheet = makeSheet(name, type); sheet.FileName = fileName; }
    workbook.Sheets.push(sheet); activeSheetId = sheet.SheetId;
    const sourceName = pendingNewSheetImport?.file?.name || '';
    if (sourceName) workbook.Sources.push({ FileName: sourceName, Path: sheet.SourcePath, Type: type });
    pendingNewSheetImport = null;
    closeDialog('newEnumSheetDialog'); render(); persist();
    status(sourceName ? `已从 ${sourceName} 新建 Sheet：${name}` : `已新增 ${TYPE_LABELS[type]} Sheet：${name}`);
  }

  function render() {
    const workbooks = allWorkbooks();
    if (!workbooks.some(book => book.WorkbookId === activeWorkbookId)) activeWorkbookId = workbooks[0]?.WorkbookId || '';
    const workbook = activeWorkbook();
    const excelDirectoryName = workbook?.ExcelDirectoryName || workbook?.OutputDirectoryName || (workbook && excelDirectoryHandles.get(workbook.WorkbookId)?.name) || '尚未选择目录';
    const csharpDirectoryName = workbook?.CSharpOutputDirectoryName || (workbook && csharpDirectoryHandles.get(workbook.WorkbookId)?.name) || '尚未选择目录';
    if (!workbook) {
      $('#enumWorkbookName').textContent = '尚未创建工程枚举集';
      $('#enumSourceSummary').textContent = '尚未导入 Excel';
      $('#enumDirectoryDisplay').textContent = excelDirectoryName;
      $('#enumCSharpDirectoryDisplay').textContent = csharpDirectoryName;
      $('#newEnumWorkbookButton').disabled = false;
      $('#enumNewSheetButton').disabled = true;
      $('#chooseEnumExcelDirectoryButton').disabled = true;
      $('#chooseEnumCSharpDirectoryButton').disabled = true;
      $('#enumSheetTabs').replaceChildren(); $('#enumGridHost').innerHTML = '<div class="enum-empty-state">新建工程枚举集或导入 Excel 以开始编辑。</div>';
      $('#enumActiveSheetTitle').textContent = '枚举表';
      $('#enumActiveSheetType').textContent = '';
      $('#enumNamespaceInput').value = 'ParName';
      $('#enumDeleteWorkbookButton').disabled = true;
      $('#enumSaveWorkbookButton').disabled = true; $('#enumExportWorkbookButton').disabled = true; $('#enumGenerateCSharpButton').disabled = true;
      return;
    }
    $('#newEnumWorkbookButton').disabled = true;
    $('#enumNewSheetButton').disabled = false;
    $('#chooseEnumExcelDirectoryButton').disabled = false;
    $('#chooseEnumCSharpDirectoryButton').disabled = false;
    $('#enumWorkbookName').textContent = workbook.Name;
    $('#enumSourceSummary').textContent = `${workbook.Sheets.length} 张表 · ${(workbook.Sources || []).length} 个导入文件`;
    $('#enumDirectoryDisplay').textContent = excelDirectoryName;
    $('#enumCSharpDirectoryDisplay').textContent = csharpDirectoryName;
    $('#enumNamespaceInput').value = workbook.Namespace || 'ParName';
    $('#enumDeleteWorkbookButton').disabled = false;
    $('#enumSaveWorkbookButton').disabled = false; $('#enumExportWorkbookButton').disabled = false; $('#enumGenerateCSharpButton').disabled = false;
    workbook.Sheets.forEach(sheet => { sheet.EnumName = sheet.Name; sheet.RegionName = sheet.Name; });
    const tabs = $('#enumSheetTabs');
    tabs.innerHTML = (workbook.Sheets || []).map(sheet => `<button class="enum-sheet-tab${sheet.SheetId === activeSheetId ? ' active' : ''}" type="button" role="tab" aria-selected="${sheet.SheetId === activeSheetId}" data-sheet-id="${esc(sheet.SheetId)}"><span>${esc(sheet.Name)}</span><small>${esc(TYPE_LABELS[sheet.Type] || '通用枚举')}</small></button>`).join('');
    tabs.querySelectorAll('[data-sheet-id]').forEach(button => {
      button.addEventListener('click', () => { activeSheetId = button.dataset.sheetId; render(); });
      button.addEventListener('contextmenu', event => {
        event.preventDefault(); event.stopPropagation();
        showEnumContextMenu(event.clientX, event.clientY, [
          { label: '复制 Sheet 名', action: () => copyEnumText(button.querySelector('span')?.textContent || '') },
          { separator: true },
          { label: '编辑 Sheet', action: () => openSheetDialog(workbook.Sheets.find(sheet => sheet.SheetId === button.dataset.sheetId)) },
          { label: '删除 Sheet', danger: true, action: () => deleteSheet(button.dataset.sheetId) },
        ]);
      });
    });
    if (!(workbook.Sheets || []).some(sheet => sheet.SheetId === activeSheetId)) activeSheetId = workbook.Sheets[0]?.SheetId || '';
    const sheet = activeSheet();
    if (!sheet) {
      $('#enumActiveSheetTitle').textContent = '尚无 Sheet';
      $('#enumActiveSheetType').textContent = '';
      $('#enumGridHost').innerHTML = '<div class="enum-empty-state">点击“＋ Sheet”新建枚举表，或右键 Sheet 编辑与删除。</div>';
      $('#enumRowCount').textContent = '0 个枚举成员';
      $('#enumGridMappingHint').textContent = 'Sheet 名同时用于 C# 枚举名和 #region 名。';
      return;
    }
    $('#enumActiveSheetTitle').textContent = sheet.Name;
    $('#enumActiveSheetType').textContent = TYPE_LABELS[sheet.Type] || '通用枚举';
    renderGrid(sheet);
  }

  // Spreadsheet editing: cell selection, row/column operations, context menu, and clipboard.
  function renderGrid(sheet) {
    const hostElement = $('#enumGridHost');
    normalizeSheetData(sheet);
    const rows = sheet.DataRows;
    const columns = sheet.Columns;
    const mapping = sheet.EnumMapping || {};
    const shownRows = Math.max(20, rows.length);
    const memberCount = sheet.Rows.length;
    const columnHeader = columns.map((column, index) => `<th class="enum-grid-column-header" data-column-index="${index}" title="${esc(column)}${index === mapping.Name ? ' · 枚举名称' : ''}${index === mapping.Comment ? ' · 注释' : ''}${index === mapping.Value ? ' · 枚举值' : ''}">${esc(column || `Column${index + 1}`)}</th>`).join('');
    hostElement.innerHTML = `<table class="enum-grid"><thead><tr><th class="enum-row-number">#</th>${columnHeader}</tr></thead><tbody>${Array.from({ length: shownRows }, (_, rowIndex) => {
      const row = rows[rowIndex] || [];
      const cells = columns.map((_column, columnIndex) => `<td><input class="enum-cell${columnIndex === mapping.Value ? ' enum-value-cell' : ''}${columnIndex === mapping.Name ? ' enum-name-cell' : ''}" data-col-index="${columnIndex}" data-row="${rowIndex}" value="${esc(row[columnIndex] || '')}" aria-label="第 ${rowIndex + 1} 行 ${esc(columns[columnIndex] || `Column${columnIndex + 1}`)}"></td>`).join('');
      return `<tr data-row-index="${rowIndex}"><th class="enum-row-number" data-row-number="${rowIndex}">${rowIndex + 1}</th>${cells}</tr>`;
    }).join('')}</tbody></table>`;
    $('#enumRowCount').textContent = `${memberCount} 个枚举成员 · ${rows.length} 行源数据`;
    $('#enumGridMappingHint').textContent = mappingHint(sheet);
    hostElement.querySelectorAll('.enum-cell').forEach(input => input.addEventListener('input', () => {
      const rowIndex = Number(input.dataset.row), columnIndex = Number(input.dataset.colIndex);
      while (rows.length <= rowIndex) rows.push(Array(columns.length).fill(''));
      while (rows[rowIndex].length < columns.length) rows[rowIndex].push('');
      rows[rowIndex][columnIndex] = input.value;
      refreshSheetProjection(sheet);
      $('#enumRowCount').textContent = `${sheet.Rows.length} 个枚举成员 · ${rows.length} 行源数据`;
      persist();
    }));
    hostElement.querySelectorAll('.enum-cell').forEach(input => input.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      const rowIndex = Number(input.dataset.row), columnIndex = Number(input.dataset.colIndex);
      const next = hostElement.querySelector(`[data-row="${rowIndex + 1}"][data-col-index="${columnIndex}"]`);
      if (next) next.focus(); else { addRows(1); hostElement.querySelector(`[data-row="${rowIndex + 1}"][data-col-index="${columnIndex}"]`)?.focus(); }
    }));
    hostElement.oncontextmenu = event => {
      const cell = event.target.closest('.enum-cell');
      const rowHeader = event.target.closest('[data-row-number]');
      const columnHeader = event.target.closest('[data-column-index]');
      const items = [];
      if (cell || rowHeader) {
        const rowIndex = Number(cell?.dataset.row ?? rowHeader.dataset.rowNumber);
        const row = sheet.DataRows[rowIndex] || [];
        items.push({ label: cell ? '复制单元格' : '复制整行', action: () => copyEnumText(cell ? cell.value : row.join('\t')) });
        items.push({ separator: true });
        items.push(
          { label: '在上方插入行', action: () => insertRow(rowIndex) },
          { label: '在下方插入行', action: () => insertRow(rowIndex + 1) },
          { label: '删除此行', danger: true, action: () => deleteRow(rowIndex) },
        );
      }
      if (columnHeader) {
        const columnIndex = Number(columnHeader.dataset.columnIndex);
        if (items.length) items.push({ separator: true });
        items.push({ label: '复制列名', action: () => copyEnumText(sheet.Columns[columnIndex] || '') });
        items.push({ separator: true });
        items.push(
          { label: '在左侧插入列', action: () => insertColumn(columnIndex) },
          { label: '在右侧插入列', action: () => insertColumn(columnIndex + 1) },
          { label: '删除此列', danger: true, action: () => deleteColumn(columnIndex) },
        );
      }
      if (!items.length) items.push({ label: '新增行', action: () => addRows(1) }, { label: '新增列', action: () => insertColumn(sheet.Columns.length) });
      event.preventDefault(); event.stopPropagation();
      showEnumContextMenu(event.clientX, event.clientY, items);
    };
  }

  function normalizeSheetData(sheet) {
    if (!Array.isArray(sheet.Columns) || !sheet.Columns.length) sheet.Columns = ['Name', 'Value', 'Comment'];
    if (!Array.isArray(sheet.DataRows)) {
      sheet.DataRows = (sheet.Rows || []).map(row => [row.Name || '', row.Value || '', row.Comment || '']);
    }
    sheet.DataRows = sheet.DataRows.map(row => {
      const values = Array.isArray(row) ? row.slice(0, sheet.Columns.length) : [];
      while (values.length < sheet.Columns.length) values.push('');
      return values.map(value => String(value == null ? '' : value));
    });
    if (!sheet.EnumMapping) sheet.EnumMapping = mapColumns(sheet.Columns, sheet.Type || 'GenericEnum');
    refreshSheetProjection(sheet);
  }

  function refreshSheetProjection(sheet) {
    const mapping = sheet.EnumMapping || mapColumns(sheet.Columns || [], sheet.Type || 'GenericEnum');
    if (sheet.Type === 'ParName') {
      const sequenceColumn = findLastHeaderIndex(sheet.Columns || [], ['参数编号', '参数序号', '序号', '编号', 'Value']);
      if (sequenceColumn >= 0) mapping.Value = sequenceColumn;
    }
    sheet.EnumMapping = mapping;
    const get = (row, field) => mapping[field] == null ? '' : String(row[mapping[field]] == null ? '' : row[mapping[field]]).trim();
    sheet.Rows = (sheet.DataRows || []).map(row => ({ Name: get(row, 'Name'), Value: get(row, 'Value'), Comment: get(row, 'Comment') })).filter(row => row.Name || row.Value || row.Comment);
  }

  function mappingHint(sheet) {
    const mapping = sheet.EnumMapping || {};
    const label = field => mapping[field] == null ? '未映射' : (sheet.Columns[mapping[field]] || `第${mapping[field] + 1}列`);
    if (sheet.Type === 'ParName') {
      if (sheet.ParListKind === 'FuncChk')
        return `FuncChk：${label('Name')} → 成员，${label('Comment')} → 注释，${label('Value')} → 序号。参数名称En 有值的行归入 UserPar。`;
      const functionNameColumn = findHeaderIndex(sheet.Columns || [], ['功能名称En', '功能名En', 'FunctionNameEn']);
      const functionHint = functionNameColumn < 0 ? '' : '；参数名称En 为空且功能名称En 有值的行生成 FuncChk，注释取功能名称Cn，值取同一序号';
      return `UserPar：${label('Name')} → 成员，${label('Comment')} → 注释，${label('Value')} → 枚举值${functionHint}。`;
    }
    return `完整表格数据保留；生成枚举：${label('Name')} → 成员，${label('Value')} → 数值，${label('Comment')} → 注释。`;
  }

  function addRows(count = 1) {
    const sheet = activeSheet(); if (!sheet) return;
    normalizeSheetData(sheet);
    for (let index = 0; index < count; index++) sheet.DataRows.push(Array(sheet.Columns.length).fill(''));
    refreshSheetProjection(sheet); renderGrid(sheet); persist();
    $('#enumGridHost').querySelector(`[data-row="${sheet.DataRows.length - 1}"][data-col-index="${sheet.EnumMapping.Name ?? 0}"]`)?.focus();
  }

  function insertRow(index) {
    const sheet = activeSheet(); if (!sheet) return;
    normalizeSheetData(sheet);
    sheet.DataRows.splice(Math.max(0, Math.min(index, sheet.DataRows.length)), 0, Array(sheet.Columns.length).fill(''));
    refreshSheetProjection(sheet); renderGrid(sheet); persist();
  }

  function deleteRow(index) {
    const sheet = activeSheet(); if (!sheet) return;
    normalizeSheetData(sheet);
    if (index < sheet.DataRows.length) sheet.DataRows.splice(index, 1);
    refreshSheetProjection(sheet); renderGrid(sheet); persist(); status('已删除选中行。');
  }

  function insertColumn(index) {
    const sheet = activeSheet(); if (!sheet) return;
    normalizeSheetData(sheet);
    const position = Math.max(0, Math.min(index, sheet.Columns.length));
    sheet.Columns.splice(position, 0, `Column${sheet.Columns.length + 1}`);
    sheet.DataRows.forEach(row => row.splice(position, 0, ''));
    Object.keys(sheet.EnumMapping || {}).forEach(field => {
      if (Number.isInteger(sheet.EnumMapping[field]) && sheet.EnumMapping[field] >= position) sheet.EnumMapping[field]++;
    });
    refreshSheetProjection(sheet); renderGrid(sheet); persist();
  }

  function deleteColumn(index) {
    const sheet = activeSheet(); if (!sheet) return;
    normalizeSheetData(sheet);
    if (sheet.Columns.length <= 1) { status('至少保留一列。'); return; }
    sheet.Columns.splice(index, 1); sheet.DataRows.forEach(row => row.splice(index, 1));
    Object.keys(sheet.EnumMapping || {}).forEach(field => {
      const mapped = sheet.EnumMapping[field];
      if (mapped === index) sheet.EnumMapping[field] = null;
      else if (Number.isInteger(mapped) && mapped > index) sheet.EnumMapping[field]--;
    });
    refreshSheetProjection(sheet); renderGrid(sheet); persist();
  }

  function showEnumContextMenu(x, y, items) {
    const menu = $('#enumContextMenu');
    menu.innerHTML = items.map(item => item.separator
      ? '<div class="enum-context-separator" role="separator"></div>'
      : `<button class="enum-context-item${item.danger ? ' danger' : ''}" type="button" role="menuitem">${esc(item.label)}</button>`).join('');
    let index = 0;
    menu.querySelectorAll('button').forEach(button => {
      const item = items.filter(entry => !entry.separator)[index++];
      button.addEventListener('click', () => { hideEnumContextMenu(); item.action(); });
    });
    menu.classList.remove('hidden');
    menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 6))}px`;
    menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 6))}px`;
  }

  async function copyEnumText(value) {
    const text = String(value == null ? '' : value);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
    } catch (_) {
      const helper = document.createElement('textarea');
      helper.value = text; helper.style.position = 'fixed'; helper.style.opacity = '0';
      document.body.appendChild(helper); helper.focus(); helper.select();
      try { document.execCommand('copy'); } catch (_) { /* Browser may block clipboard access. */ }
      helper.remove();
    }
    status('已复制到剪贴板。');
  }

  function hideEnumContextMenu() { $('#enumContextMenu').classList.add('hidden'); }

  function deleteSheet(sheetId) {
    const workbook = activeWorkbook(); if (!workbook) return;
    const sheet = workbook.Sheets.find(item => item.SheetId === sheetId); if (!sheet) return;
    if (workbook.Sheets.length === 1) {
      if (!window.confirm(`「${sheet.Name}」是 Excel「${workbook.Name}」的最后一个 Sheet。删除后会同时删除整个 Excel 表格，确定继续吗？`)) return;
      removeWorkbook(workbook);
      render(); persist(); status(`已删除最后一个 Sheet，并移除了 Excel：${workbook.Name}`);
      return;
    }
    if (!window.confirm(`确定删除 Sheet「${sheet.Name}」吗？`)) return;
    workbook.Sheets = workbook.Sheets.filter(item => item !== sheet);
    activeSheetId = workbook.Sheets[0]?.SheetId || '';
    render(); persist(); status(`已删除 Sheet：${sheet.Name}`);
  }

  function removeWorkbook(workbook) {
    const workbooks = allWorkbooks();
    const index = workbooks.indexOf(workbook);
    if (index < 0) return;
    workbooks.splice(index, 1);
    workbookFileHandles.delete(workbook.WorkbookId); excelDirectoryHandles.delete(workbook.WorkbookId); csharpDirectoryHandles.delete(workbook.WorkbookId);
    removeHandle(`enum-xlsx:${workbook.WorkbookId}`).catch(() => {});
    removeHandle(`enum-output:${workbook.WorkbookId}`).catch(() => {});
    removeHandle(`enum-excel-output:${workbook.WorkbookId}`).catch(() => {});
    removeHandle(`enum-csharp-output:${workbook.WorkbookId}`).catch(() => {});
    activeWorkbookId = workbooks[Math.max(0, index - 1)]?.WorkbookId || workbooks[0]?.WorkbookId || '';
    activeSheetId = activeWorkbook()?.Sheets[0]?.SheetId || '';
  }

  function deleteCurrentWorkbook() {
    const workbook = activeWorkbook(); if (!workbook) return;
    if (!window.confirm(`确定删除 Excel「${workbook.Name}」及其中所有 Sheet 吗？`)) return;
    removeWorkbook(workbook);
    render(); persist();
  }


  // Import pipeline: read CSV/XLSX, detect columns, map enum types, and normalize source rows.
  function parseCsv(text, delimiter) {
    const rows = []; let row = [], value = '', quoted = false;
    for (let index = 0; index < text.length; index++) {
      const char = text[index];
      if (quoted) {
        if (char === '"' && text[index + 1] === '"') { value += '"'; index++; }
        else if (char === '"') quoted = false;
        else value += char;
      } else if (char === '"') quoted = true;
      else if (char === delimiter) { row.push(value); value = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[index + 1] === '\n') index++;
        row.push(value); rows.push(row); row = []; value = '';
      } else value += char;
    }
    if (value.length || row.length) { row.push(value); rows.push(row); }
    return rows;
  }

  function columnIndex(reference) {
    const letters = String(reference).match(/^[A-Z]+/i)?.[0] || 'A';
    let value = 0;
    for (const char of letters.toUpperCase()) value = value * 26 + char.charCodeAt(0) - 64;
    return value - 1;
  }

  function xmlChildren(node, name) { return Array.from(node.getElementsByTagNameNS('*', name)); }

  async function readZipEntries(buffer) {
    const bytes = new Uint8Array(buffer), view = new DataView(buffer);
    let eocd = -1;
    for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) { eocd = offset; break; }
    }
    if (eocd < 0) throw new Error('Excel 文件 ZIP 目录缺失。');
    const count = view.getUint16(eocd + 10, true), directoryOffset = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder('utf-8');
    const entries = new Map(); let cursor = directoryOffset;
    for (let index = 0; index < count; index++) {
      if (view.getUint32(cursor, true) !== 0x02014b50) throw new Error('Excel 文件目录损坏。');
      const flags = view.getUint16(cursor + 8, true), method = view.getUint16(cursor + 10, true);
      const compressedSize = view.getUint32(cursor + 20, true), nameLength = view.getUint16(cursor + 28, true);
      const extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
      const localOffset = view.getUint32(cursor + 42, true);
      if (flags & 1) throw new Error('不支持加密的 Excel 工作簿。');
      const name = decoder.decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
      const localNameLength = view.getUint16(localOffset + 26, true), localExtraLength = view.getUint16(localOffset + 28, true);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = bytes.slice(start, start + compressedSize);
      let content;
      if (method === 0) content = compressed;
      else if (method === 8 && typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        content = new Uint8Array(await new Response(stream).arrayBuffer());
      } else throw new Error('此浏览器无法解压该 Excel 文件，请使用 Edge/Chrome 或另存为 CSV。');
      entries.set(name, content);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function parseXlsx(file) {
    const entries = await readZipEntries(await file.arrayBuffer());
    const decoder = new TextDecoder('utf-8');
    const parseXml = path => {
      const data = entries.get(path); if (!data) throw new Error(`Excel 缺少 ${path}`);
      const document = new DOMParser().parseFromString(decoder.decode(data), 'application/xml');
      if (document.querySelector('parsererror')) throw new Error(`Excel XML 无效：${path}`);
      return document;
    };
    const workbookXml = parseXml('xl/workbook.xml');
    const relationshipsXml = parseXml('xl/_rels/workbook.xml.rels');
    const relationships = new Map(xmlChildren(relationshipsXml, 'Relationship').map(item => [item.getAttribute('Id'), item.getAttribute('Target')]));
    const shared = entries.has('xl/sharedStrings.xml') ? xmlChildren(parseXml('xl/sharedStrings.xml'), 'si').map(item => xmlChildren(item, 't').map(textNode => textNode.textContent).join('')) : [];
    const sheets = [];
    for (const sheetNode of xmlChildren(workbookXml, 'sheet')) {
      const name = sheetNode.getAttribute('name') || 'Sheet';
      if (isBackupSheetName(name)) continue;
      const relationId = sheetNode.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id') || sheetNode.getAttribute('r:id');
      const target = relationships.get(relationId);
      if (!target) continue;
      const path = target.startsWith('/') ? target.slice(1) : target.startsWith('xl/') ? target : `xl/${target}`;
      const sheetXml = parseXml(path);
      const rows = xmlChildren(sheetXml, 'row').map(rowNode => {
        const row = [];
        for (const cell of xmlChildren(rowNode, 'c')) {
          const index = columnIndex(cell.getAttribute('r'));
          const type = cell.getAttribute('t');
          let value = '';
          if (type === 'inlineStr') value = xmlChildren(cell, 't').map(item => item.textContent).join('');
          else {
            const v = xmlChildren(cell, 'v')[0]; value = v ? v.textContent : '';
            if (type === 's') value = shared[Number(value)] || '';
            else if (type === 'b') value = value === '1' ? 'TRUE' : 'FALSE';
          }
          row[index] = value;
        }
        return row.map(value => value == null ? '' : String(value));
      });
      sheets.push({ name, rows });
    }
    return { sheets };
  }

  function detectHeader(row) {
    const tokens = (row || []).map(value => String(value || '').trim().toLowerCase());
    const aliases = {
      Name: ['name', 'enumname', '成员名称', '名称', '变量名', '信号名称', '轴名称', 'io名称', '点位名称'],
      Value: ['value', 'id', 'address', '编号', '值', '数值', '地址', '序号'],
      Comment: ['comment', 'description', 'remark', '注释', '描述', '说明', '功能描述'],
    };
    const map = {};
    Object.entries(aliases).forEach(([field, names]) => {
      const index = tokens.findIndex(token => names.includes(token));
      if (index >= 0) map[field] = index;
    });
    return Object.keys(map).length ? map : null;
  }

  function normalizeHeader(value) { return String(value || '').trim().toLowerCase().replace(/[\s_\-（）()：:]/g, ''); }

  function findHeaderIndex(columns, aliases) {
    const normalized = columns.map(normalizeHeader);
    const wanted = aliases.map(normalizeHeader);
    return normalized.findIndex(value => wanted.includes(value));
  }

  function findLastHeaderIndex(columns, aliases) {
    const normalized = columns.map(normalizeHeader);
    const wanted = aliases.map(normalizeHeader);
    for (let index = normalized.length - 1; index >= 0; index--) {
      if (wanted.includes(normalized[index])) return index;
    }
    return -1;
  }

  function mapColumns(columns, type) {
    const find = aliases => findHeaderIndex(columns, aliases);
    let mapping;
    if (type === 'Input' || type === 'Output') {
      mapping = {
        Name: find(['名称En', 'NameEn', '名称English']),
        Value: find(['编号', '序号', 'Value', 'Id']),
        Comment: find(['名称Cn', 'NameCn', '中文名称']),
      };
    } else if (type === 'ParName') {
      mapping = {
        Name: find(['参数名称En', '参数名En', 'ParameterNameEn']),
        Value: findLastHeaderIndex(columns, ['参数编号', '参数序号', '序号', '编号', 'Value']),
        Comment: find(['参数名称Cn', '参数名Cn', 'ParameterNameCn']),
      };
    } else if (type === 'Axis') {
      mapping = { Name: find(['名称', '轴名称', 'Name']), Value: find(['编号', '序号', 'Value', 'Id']), Comment: find(['名称Cn', '注释', '说明', 'Comment']) };
    } else {
      mapping = detectHeader(columns) || { Name: columns.length ? 0 : null, Value: columns.length > 1 ? 1 : null, Comment: columns.length > 2 ? 2 : null };
    }
    if (mapping.Name == null || mapping.Name < 0) mapping.Name = find(['名称En', '参数名称En', '名称', 'Name']);
    if (mapping.Name == null || mapping.Name < 0) mapping.Name = columns.length ? 0 : null;
    ['Name', 'Value', 'Comment'].forEach(field => { if (mapping[field] == null || mapping[field] < 0) mapping[field] = null; });
    return mapping;
  }

  function guessType(fileName) {
    const base = String(fileName || '').replace(/\.[^.]+$/, '').toLowerCase();
    if (base === 'input') return 'Input';
    if (base === 'output') return 'Output';
    if (base === 'parlist' || base === 'parname') return 'ParName';
    if (base === 'axispar' || base.includes('axis')) return 'Axis';
    return 'GenericEnum';
  }

  function enumNameFor(type, fileName, sheetName, index, total) {
    const defaults = DEFAULTS[type] || DEFAULTS.GenericEnum;
    const baseFile = String(fileName || '').replace(/\.[^.]+$/, '');
    let name = type === 'GenericEnum' ? baseFile.replace(/[^_\p{L}\p{N}]/gu, '_') : defaults[0];
    if (name && !/^[_\p{L}]/u.test(name)) name = '_' + name;
    if (!name) name = `Sheet${index + 1}`;
    if (total > 1 && index > 0) {
      const suffix = String(sheetName || `Sheet${index + 1}`).replace(/[^_\p{L}\p{N}]/gu, '_').replace(/^([^_\p{L}])/u, '_$1');
      name += `_${suffix || index + 1}`;
    }
    return name;
  }

  function convertSheet(imported, type, index, fileName, config = {}) {
    const matrix = (imported.rows || []).map(row => Array.isArray(row) ? Array.from(row, value => String(value == null ? '' : value)) : []);
    let name = config.name || imported.name || `Sheet${index + 1}`;
    let enumName = config.name || config.enumName || enumNameFor(type, fileName, imported.name, index, 1);
    let regionName = (DEFAULTS[type] || DEFAULTS.GenericEnum)[1];
    let columns = [], dataRows = [], mapping = null, persistedFileName = '', persistedParListKind = '';
    if (matrix[0] && matrix[0][0] === '#EnumSheet') {
      type = TYPE_OPTIONS.includes(matrix[0][2]) ? matrix[0][2] : type;
      name = config.name || matrix[0][1] || name;
      enumName = config.name || config.enumName || matrix[0][3] || enumName;
      regionName = matrix[0][4] || regionName;
      persistedFileName = matrix[0][7] || '';
      persistedParListKind = matrix[0][8] || '';
      if (matrix[1]?.[0] === '#EnumData') {
        try { mapping = JSON.parse(matrix[1][1] || '{}'); } catch (_) { mapping = null; }
        columns = matrix[2] || [];
        dataRows = matrix.slice(3);
      } else {
        columns = matrix[1] || ['Name', 'Value', 'Comment'];
        dataRows = matrix.slice(2);
      }
    } else {
      columns = matrix[0] || [];
      if (columns.length && columns.some(value => String(value || '').trim())) dataRows = matrix.slice(1);
      else { columns = Array.from({ length: Math.max(3, ...matrix.map(row => row.length)) }, (_v, column) => `Column${column + 1}`); dataRows = matrix; }
    }
    const width = Math.max(columns.length, ...dataRows.map(row => row.length), 1);
    columns = Array.from({ length: width }, (_value, column) => String(columns[column] || `Column${column + 1}`));
    dataRows = dataRows.map(row => Array.from({ length: width }, (_value, column) => String(row[column] == null ? '' : row[column])));
    mapping = mapping || mapColumns(columns, type);
    const effectiveName = String(config.name || name || enumName).slice(0, 31);
    const sheet = {
      SheetId: id('enum_sheet'), Name: effectiveName, FileName: normalizeExcelFileName(config.fileName || persistedFileName || effectiveName), Type: config.type || type, ParListKind: config.parListKind || persistedParListKind || '', EnumName: effectiveName,
      RegionName: effectiveName, SourceFileName: fileName || '', SourcePath: config.path || '', SourceSheetName: imported.name || '',
      Columns: columns, DataRows: dataRows, EnumMapping: mapping, Rows: [],
    };
    refreshSheetProjection(sheet);
    return sheet;
  }

  function createParListSheets(imported, fileName, path, outputFileName, userParName, funcChkName) {
    const columns = importColumns(imported);
    const parameterName = findHeaderIndex(columns, ['参数名称En', '参数名En', 'ParameterNameEn']);
    const parameterComment = findHeaderIndex(columns, ['参数名称Cn', '参数名Cn', 'ParameterNameCn']);
    const functionName = findHeaderIndex(columns, ['功能名称En', '功能名En', 'FunctionNameEn']);
    const functionComment = findHeaderIndex(columns, ['功能名称Cn', '功能名Cn', 'FunctionNameCn']);
    const sequence = findLastHeaderIndex(columns, ['参数编号', '参数序号', '序号', '编号', 'Value']);
    if (parameterName < 0) throw new Error('ParList 中未找到“参数名称En”列，无法生成 UserPar。');
    if (functionName < 0) throw new Error('ParList 中未找到“功能名称En”列，无法生成 FuncChk。');
    if (sequence < 0) throw new Error('ParList 中未找到“序号”列，无法保持枚举值与序号一致。');

    const base = convertSheet(imported, 'ParName', 0, fileName, { name: userParName, fileName: outputFileName, type: 'ParName', path });
    const sourceRows = base.DataRows || [];
    const userRows = sourceRows.filter(row => String(row[parameterName] || '').trim());
    const functionRows = sourceRows.filter(row => !String(row[parameterName] || '').trim() && String(row[functionName] || '').trim());
    const build = (kind, name, rows) => {
      const sheet = {
        ...base,
        SheetId: id('enum_sheet'), Name: name, EnumName: name, RegionName: name,
        FileName: outputFileName, ParListKind: kind,
        Columns: base.Columns.slice(), DataRows: rows.map(row => row.slice()),
        EnumMapping: {
          Name: kind === 'UserPar' ? parameterName : functionName,
          Value: sequence,
          Comment: kind === 'UserPar' ? parameterComment : functionComment,
        },
      };
      refreshSheetProjection(sheet);
      return sheet;
    };
    return [build('UserPar', userParName, userRows), build('FuncChk', funcChkName, functionRows)];
  }

  async function readWorkbookFile(file) {
    let imported;
    const ext = file.name.toLowerCase().split('.').pop();
    if (ext === 'xlsx') imported = await parseXlsx(file);
    else {
      const delimiter = ext === 'tsv' ? '\t' : ',';
      imported = { sheets: [{ name: file.name.replace(/\.[^.]+$/, '') || 'Sheet1', rows: parseCsv(await file.text(), delimiter) }] };
    }
    if (!imported.sheets.length) throw new Error('工作簿中没有可导入的工作表（备份 Sheet 已自动忽略）。');
    return imported;
  }

  async function importWorkbook(file, options = {}) {
    const imported = await readWorkbookFile(file);
    if (!imported.sheets.length) throw new Error('工作簿中没有可导入的 Sheet。');
    const path = file.path || file.webkitRelativePath || file.name;
    const embeddedInfo = imported.sheets.map(embeddedEnumSheetInfo);
    const embeddedType = embeddedInfo[0]?.type;
    const isEmbeddedWorkbook = embeddedInfo.every(Boolean) && embeddedInfo.every(info => info.type === embeddedType);
    const sheets = isEmbeddedWorkbook ? imported.sheets : imported.sheets.slice(0, 1);
    pendingImport = { fileName: file.name, path, sheets, isEmbeddedWorkbook, workbookName: options.workbookName || '' };
    $('#enumImportPathInput').value = path;
    $('#enumImportError').textContent = '';
    $('#enumImportError').classList.add('hidden');
    $('#enumImportTypeInput').value = isEmbeddedWorkbook ? embeddedType : (options.initialType || guessType(file.name));
    $('#enumImportTypeInput').disabled = isEmbeddedWorkbook;
    renderImportSheetRows();
    showDialog('importEnumDialog');
  }

  function renderImportSheetRows() {
    if (!pendingImport) return;
    const type = $('#enumImportTypeInput').value;
    const previous = new Map(Array.from($('#enumImportSheets').querySelectorAll('[data-import-sheet]')).map(row => [Number(row.dataset.importSheet), {
      name: row.querySelector('[data-import-name]')?.value,
      fileName: row.querySelector('[data-import-file-name]')?.value,
      userParName: row.querySelector('[data-import-userpar-name]')?.value,
      funcChkName: row.querySelector('[data-import-funchk-name]')?.value,
    }]));
    $('#enumImportSheets').innerHTML = pendingImport.sheets.map((sheet, index) => {
      const prior = previous.get(index) || {};
      const embedded = pendingImport.isEmbeddedWorkbook ? embeddedEnumSheetInfo(sheet) : null;
      const suggestedName = embedded?.name || enumNameFor(type, pendingImport.fileName, sheet.name, index, 1);
      const name = prior.name || suggestedName;
      const fileName = prior.fileName || normalizeExcelFileName(embedded?.fileName || pendingImport.fileName, suggestedSheetFileName(pendingImport.fileName, sheet.name, index, 1));
      const columns = importColumns(sheet);
      let mapping = mapColumns(columns, type);
      if (embedded && sheet.rows?.[1]?.[0] === '#EnumData') {
        try { mapping = JSON.parse(sheet.rows[1][1] || '{}') || mapping; } catch (_) { /* Keep inferred column mapping. */ }
      }
      const fileNameInput = `<input data-import-file-name value="${esc(fileName)}" maxlength="120" required${pendingImport.isEmbeddedWorkbook && index > 0 ? ' readonly' : ''}>`;
      if (type === 'ParName' && !embedded) {
        const functionNameColumn = findHeaderIndex(columns, ['功能名称En', '功能名En', 'FunctionNameEn']);
        const functionCommentColumn = findHeaderIndex(columns, ['功能名称Cn', '功能名Cn', 'FunctionNameCn']);
        const mappingText = `UserPar：${columns[mapping.Name] || '未识别'} · 注释：${columns[mapping.Comment] || '无'} · 序号：${columns[mapping.Value] || '未识别'}；FuncChk：${functionNameColumn < 0 ? '未识别功能名称En' : columns[functionNameColumn]} · 注释：${functionCommentColumn < 0 ? '未识别功能名称Cn' : columns[functionCommentColumn]} · 使用相同序号`;
        const userParName = prior.userParName || 'UserPar';
        const funcChkName = prior.funcChkName || 'FuncChk';
        return `<div class="enum-import-sheet-row enum-import-parlist-row" data-import-sheet="${index}"><div class="enum-import-sheet-title"><strong title="源 Sheet：${esc(sheet.name)}">${esc(sheet.name)}</strong></div><label>Excel 文件名（两个 Sheet 共用）<input data-import-file-name value="${esc(fileName)}" maxlength="120" required></label><label>UserPar 枚举名<input data-import-userpar-name value="${esc(userParName)}" maxlength="31" required></label><label>FuncChk 枚举名<input data-import-funchk-name value="${esc(funcChkName)}" maxlength="31" required></label><small class="enum-import-mapping">${esc(mappingText)}</small></div>`;
      }
      const mappingText = `成员：${columns[mapping.Name] || '未识别'} · 注释：${columns[mapping.Comment] || '无'} · 数值：${columns[mapping.Value] || '无'}`;
      const enumLabel = embedded?.parListKind ? `${embedded.parListKind} 枚举名` : 'Sheet / 枚举名';
      return `<div class="enum-import-sheet-row" data-import-sheet="${index}"><div class="enum-import-sheet-title"><strong title="源 Sheet：${esc(sheet.name)}">${esc(sheet.name)}</strong></div><label>Excel 文件名${fileNameInput}</label><label>${enumLabel}<input data-import-name value="${esc(name)}" maxlength="31" required></label><small class="enum-import-mapping">${esc(mappingText)}</small></div>`;
    }).join('');
  }

  function importColumns(imported) {
    const rows = imported.rows || [];
    if (rows[0]?.[0] === '#EnumSheet') return rows[1]?.[0] === '#EnumData' ? rows[2] || [] : rows[1] || [];
    return rows[0] || [];
  }

  function embeddedEnumSheetInfo(imported) {
    const metadata = imported?.rows?.[0];
    if (metadata?.[0] !== '#EnumSheet') return null;
    const type = TYPE_OPTIONS.includes(metadata[2]) ? metadata[2] : '';
    if (!type) return null;
    return { name: String(metadata[1] || imported.name || ''), type, fileName: String(metadata[7] || ''), parListKind: String(metadata[8] || '') };
  }

  function completeImport(event) {
    event.preventDefault();
    if (!pendingImport) return;
    const importState = pendingImport;
    const type = $('#enumImportTypeInput').value;
    const errorBox = $('#enumImportError');
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
    try {
      let workbook = activeWorkbook();
      const isNewWorkbook = !workbook;
      if (isNewWorkbook) {
        const workbookName = importState.workbookName || importState.fileName.replace(/\.[^.]+$/, '') || '工程枚举';
        workbook = { WorkbookId: id('enum_book'), Name: workbookName, FileName: `${safeFileName(workbookName)}.xlsx`, Namespace: 'ParName', ExcelDirectoryName: '', CSharpOutputDirectoryName: '', EnumRegions: ['Common'], Sources: [], Sheets: [] };
      }
      const existingNames = new Set((workbook.Sheets || []).map(sheet => String(sheet.Name || '').toLowerCase()));
      const existingTypeKeys = new Set((workbook.Sheets || []).map(sheetTypeKey));
      const existingFileNames = new Set((workbook.Sheets || []).map(sheetExcelFileName).map(value => value.toLowerCase()));
      let importedSheets;
      let outputFileName = '';
      const importedTypeKeys = importState.isEmbeddedWorkbook
        ? importState.sheets.map(sheet => {
          const info = embeddedEnumSheetInfo(sheet);
          return sheetTypeKey({ Type: info.type, ParListKind: info.parListKind });
        })
        : type === 'ParName' ? ['ParName:UserPar', 'ParName:FuncChk'] : [type];
      if (importedTypeKeys.some(key => existingTypeKeys.has(key)))
        throw new Error(`${TYPE_LABELS[type]} 已存在；每种枚举类型只允许一个 Sheet（ParList 仅允许 UserPar 与 FuncChk 各一个）。`);
      if (new Set(importedTypeKeys).size !== importedTypeKeys.length)
        throw new Error('导入文件包含重复的枚举类型 Sheet。');
      if (importState.isEmbeddedWorkbook) {
        const embeddedRows = importState.sheets.map((_sheet, index) => $(`[data-import-sheet="${index}"]`, $('#enumImportSheets')));
        if (embeddedRows.some(row => !row)) throw new Error('导入设置没有生成，请关闭窗口后重新选择 Excel 文件。');
        const firstInfo = embeddedEnumSheetInfo(importState.sheets[0]);
        const sharedFileName = uniqueExcelFileName(
          normalizeExcelFileName(embeddedRows[0].querySelector('[data-import-file-name]').value, firstInfo.fileName || importState.fileName),
          existingFileNames,
        );
        outputFileName = sharedFileName;
        const pendingNames = new Set();
        importedSheets = importState.sheets.map((sourceSheet, index) => {
          const info = embeddedEnumSheetInfo(sourceSheet);
          const name = embeddedRows[index].querySelector('[data-import-name]').value.trim() || info.name;
          const key = name.toLowerCase();
          if (!validSheetName(name)) throw new Error(`「${name}」不是有效的 C# Sheet / 枚举名。`);
          if (existingNames.has(key) || pendingNames.has(key)) throw new Error(`Sheet「${name}」已存在，请修改名称。`);
          pendingNames.add(key);
          const sheet = convertSheet(sourceSheet, info.type, index, importState.fileName, {
            name, fileName: sharedFileName, type: info.type, path: importState.path, parListKind: info.parListKind,
          });
          sheet.Name = name; sheet.EnumName = name; sheet.RegionName = name;
          return sheet;
        });
      } else {
        const imported = importState.sheets[0];
        const row = $('[data-import-sheet="0"]', $('#enumImportSheets'));
        if (!imported || !row) throw new Error('没有可导入的有效 Sheet，请重新选择 Excel 文件。');
        const baseName = importState.fileName.replace(/\.[^.]+$/, '').trim() || imported.name || 'Sheet1';
        outputFileName = uniqueExcelFileName(
          normalizeExcelFileName(row.querySelector('[data-import-file-name]').value, baseName),
          existingFileNames,
        );
      }
      if (!importState.isEmbeddedWorkbook && type === 'ParName') {
        const imported = importState.sheets[0];
        const row = $('[data-import-sheet="0"]', $('#enumImportSheets'));
        const userParName = row.querySelector('[data-import-userpar-name]').value.trim() || 'UserPar';
        const funcChkName = row.querySelector('[data-import-funchk-name]').value.trim() || 'FuncChk';
        if (!validSheetName(userParName)) throw new Error(`「${userParName}」不是有效的 C# UserPar 枚举名。`);
        if (!validSheetName(funcChkName)) throw new Error(`「${funcChkName}」不是有效的 C# FuncChk 枚举名。`);
        if (userParName.toLowerCase() === funcChkName.toLowerCase()) throw new Error('UserPar 与 FuncChk 的枚举名不能相同。');
        if (existingNames.has(userParName.toLowerCase()) || existingNames.has(funcChkName.toLowerCase()))
          throw new Error('UserPar 或 FuncChk 枚举名已存在，请修改名称或先删除已有 Sheet。');
        importedSheets = createParListSheets(imported, importState.fileName, importState.path, outputFileName, userParName, funcChkName);
      } else if (!importState.isEmbeddedWorkbook) {
        const imported = importState.sheets[0];
        const row = $('[data-import-sheet="0"]', $('#enumImportSheets'));
        const baseName = importState.fileName.replace(/\.[^.]+$/, '').trim() || imported.name || 'Sheet1';
        const name = row.querySelector('[data-import-name]').value.trim() || baseName;
        if (!validSheetName(name)) throw new Error(`「${name}」不是有效的 C# Sheet / 枚举名。`);
        if (existingNames.has(name.toLowerCase())) throw new Error(`Sheet「${name}」已存在，请修改名称。`);
        const sheet = convertSheet(imported, type, 0, importState.fileName, { name, fileName: outputFileName, type, path: importState.path });
        sheet.Name = name; sheet.EnumName = name; sheet.RegionName = name;
        importedSheets = [sheet];
      }
      if (!importedSheets.length) throw new Error('工作簿中没有可导入的 Sheet。');

      if (isNewWorkbook) {
        allWorkbooks().push(workbook);
        activeWorkbookId = workbook.WorkbookId;
      }
      if (!Array.isArray(workbook.Sources)) workbook.Sources = [];
      workbook.Sheets.push(...importedSheets);
      workbook.Sources.push({ FileName: importState.fileName, Path: importState.path, Type: type });
      activeSheetId = importedSheets[0].SheetId;
      const fileName = importState.fileName;
      pendingImport = null;
      closeDialog('importEnumDialog');
      render(); persist(); openWorkbook();
      status(type === 'ParName' && importedSheets.length === 2
        ? `已将 ${fileName} 导入为 ${importedSheets[0].Name} 与 ${importedSheets[1].Name}，共用 Excel 文件 ${outputFileName}。`
        : `已将 ${fileName} 导入当前工程枚举集，共 ${importedSheets.length} 张 Sheet。`);
    } catch (error) {
      const reason = error && error.message ? error.message : String(error || '未知错误');
      errorBox.textContent = `导入失败：${reason}`;
      errorBox.classList.remove('hidden');
      status(`Excel 导入失败：${reason}`);
      console.error('Excel import failed.', error);
    }
  }

  // XLSX output: build the minimal workbook package used to save the editable Excel deliverable.
  function xmlEscape(value) { return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
  function columnLetters(index) { let value = index + 1, result = ''; while (value > 0) { const remainder = (value - 1) % 26; result = String.fromCharCode(65 + remainder) + result; value = Math.floor((value - 1) / 26); } return result; }

  function workbookXml(workbook) {
    const sheets = workbook.Sheets.map((sheet, index) => `<sheet name="${xmlEscape(String(sheet.Name || `Sheet${index + 1}`).slice(0, 31))}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets}</sheets></workbook>`;
  }

  function sheetXml(sheet) {
    normalizeSheetData(sheet);
    const data = [
      ['#EnumSheet', sheet.Name || '', sheet.Type || 'GenericEnum', sheet.EnumName || sheet.Name || '', sheet.RegionName || '', sheet.SourceFileName || '', sheet.SourceSheetName || '', sheetExcelFileName(sheet), sheet.ParListKind || ''],
      ['#EnumData', JSON.stringify(sheet.EnumMapping || {})],
      sheet.Columns,
      ...sheet.DataRows,
    ];
    const rows = data.map((row, rowIndex) => {
      const cells = row.map((value, columnIndex) => {
        const text = String(value == null ? '' : value);
        if (!text) return '';
        const reference = `${columnLetters(columnIndex)}${rowIndex + 1}`;
        return `<c r="${reference}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(text)}</t></is></c>`;
      }).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  }

  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
    return table;
  })();
  function crc32(bytes) { let crc = 0xFFFFFFFF; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8); return (crc ^ 0xFFFFFFFF) >>> 0; }

  function zipStore(files) {
    const encoder = new TextEncoder(), localChunks = [], centralChunks = [];
    let offset = 0;
    files.forEach(([path, content]) => {
      const name = encoder.encode(path), data = encoder.encode(content), checksum = crc32(data);
      const local = new Uint8Array(30 + name.length + data.length), localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true); localView.setUint16(4, 20, true); localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true); localView.setUint32(14, checksum, true); localView.setUint32(18, data.length, true); localView.setUint32(22, data.length, true);
      localView.setUint16(26, name.length, true); local.set(name, 30); local.set(data, 30 + name.length);
      localChunks.push(local);
      const central = new Uint8Array(46 + name.length), centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true); centralView.setUint16(4, 20, true); centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true); centralView.setUint16(10, 0, true); centralView.setUint32(16, checksum, true);
      centralView.setUint32(20, data.length, true); centralView.setUint32(24, data.length, true); centralView.setUint16(28, name.length, true);
      centralView.setUint32(42, offset, true); central.set(name, 46); centralChunks.push(central);
      offset += local.length;
    });
    const centralSize = centralChunks.reduce((total, chunk) => total + chunk.length, 0), end = new Uint8Array(22), view = new DataView(end.buffer);
    view.setUint32(0, 0x06054b50, true); view.setUint16(8, files.length, true); view.setUint16(10, files.length, true);
    view.setUint32(12, centralSize, true); view.setUint32(16, offset, true);
    return new Blob([...localChunks, ...centralChunks, end], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function createXlsxBlob(workbook) {
    const files = [
      ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${workbook.Sheets.map((_sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
      ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
      ['xl/workbook.xml', workbookXml(workbook)],
      ['xl/_rels/workbook.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${workbook.Sheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}</Relationships>`],
      ...workbook.Sheets.map((sheet, index) => [`xl/worksheets/sheet${index + 1}.xml`, sheetXml(sheet)]),
    ];
    return zipStore(files);
  }

  function createCsv(workbook) {
    const sheet = activeSheet() || workbook.Sheets[0];
    normalizeSheetData(sheet);
    const rows = [sheet.Columns, ...sheet.DataRows];
    return `\uFEFF${rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n')}`;
  }

  function downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob), anchor = document.createElement('a');
    anchor.href = url; anchor.download = fileName; anchor.style.display = 'none'; document.body.appendChild(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  async function writeFileHandle(handle, blob) {
    const writable = await handle.createWritable(); await writable.write(blob); await writable.close();
  }

  function showExcelSaveResult(actionLabel, result) {
    if (!result) return;
    $('#enumSaveResultTitle').textContent = `Excel ${actionLabel}成功`;
    $('#enumSaveResultSummary').textContent = `${result.sheetCount} 个 Excel 文件（${result.worksheetCount} 个工作表）已保存到：${result.directoryName}`;
    $('#enumSaveResultFiles').innerHTML = result.fileNames.map(fileName => `<li title="${esc(fileName)}">${esc(fileName)}</li>`).join('');
    showDialog('enumSaveResultDialog');
  }

  async function saveWorkbookAs() {
    const workbook = activeWorkbook();
    if (!workbook) return;
    if (!window.showDirectoryPicker) { status('当前浏览器不支持选择保存目录，请通过 Chrome / Edge 的本机网页地址使用另存功能。'); return; }
    let directory;
    try {
      directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      if (!directory) return;
      let permission = await directory.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') permission = await directory.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') throw new Error('没有获得所选目录的写入权限。');
      excelDirectoryHandles.set(workbook.WorkbookId, directory);
      workbook.ExcelDirectoryName = directory.name;
      workbook.OutputDirectoryName = directory.name;
      await storeHandle(`enum-excel-output:${workbook.WorkbookId}`, directory).catch(() => {});
      render(); persist();
      const result = await saveSheetExcels('另存', '', { directory });
      showExcelSaveResult('另存', result);
    } catch (error) {
      if (error.name !== 'AbortError') status(`Excel 另存失败：${error.message}`);
    }
  }

  async function saveWorkbook() {
    try {
      // Open the directory permission prompt during the Save button's click gesture.
      const directory = await prepareExcelDirectoryForSave();
      const result = await saveSheetExcels('保存', '', { directory });
      showExcelSaveResult('保存', result);
    } catch (error) { if (error.name !== 'AbortError') status(`Excel 保存失败：${error.message}`); }
  }

  // Enter directly from a click handler: pickers and permission prompts need user activation.
  async function prepareExcelDirectoryForSave() {
    const workbook = activeWorkbook();
    if (!workbook) throw new Error('请先创建或导入工程 Excel。');
    let directory = excelDirectoryHandles.get(workbook.WorkbookId);
    if (directory) {
      if (typeof directory.requestPermission === 'function') {
        const permission = await directory.requestPermission({ mode: 'readwrite' });
        if (permission !== 'granted') throw new Error('Excel 保存目录未获得写入权限，请重新选择目录。');
      }
      return directory;
    }
    if (!window.showDirectoryPicker)
      throw new Error('当前浏览器不支持选择 Excel 保存目录，请使用 Chrome 或 Edge 的本机网页地址。');
    directory = await window.showDirectoryPicker({ mode: 'readwrite' });
    if (!directory) throw new Error('尚未选择 Excel 保存目录。');
    excelDirectoryHandles.set(workbook.WorkbookId, directory);
    workbook.ExcelDirectoryName = directory.name;
    workbook.OutputDirectoryName = directory.name;
    await storeHandle(`enum-excel-output:${workbook.WorkbookId}`, directory).catch(() => {});
    render(); persist();
    return directory;
  }

  // Sheets sharing a FileName are saved together in one Excel workbook.
  async function saveSheetExcels(actionLabel, fileNameSuffix = '', options = {}) {
    const workbook = activeWorkbook();
    if (!workbook) return null;
    if (!(workbook.Sheets || []).length) throw new Error('工程 Excel 至少需要一个 Sheet。');
    const groupsByName = new Map();
    workbook.Sheets.forEach(sheet => {
      const original = sheetExcelFileName(sheet);
      const fileName = fileNameSuffix ? `${original.slice(0, -'.xlsx'.length)}${fileNameSuffix}.xlsx` : original;
      const key = fileName.toLowerCase();
      if (!groupsByName.has(key)) groupsByName.set(key, { fileName, sheets: [] });
      groupsByName.get(key).sheets.push(sheet);
    });
    const groups = Array.from(groupsByName.values());
    const fileNames = groups.map(group => group.fileName);
    try {
      const directory = options.directory;
      if (!directory) throw new Error('缺少 Excel 保存目录，请先在枚举管理中选择 Excel 目录。');
      for (const group of groups) {
        const handle = await directory.getFileHandle(group.fileName, { create: true });
        await writeFileHandle(handle, createXlsxBlob({ Sheets: group.sheets }));
      }
      workbook.ExcelDirectoryName = directory.name;
      workbook.OutputDirectoryName = directory.name;
      render(); persist();
      status(`已在 ${directory.name} ${actionLabel} ${fileNames.length} 个 Excel 文件，共 ${workbook.Sheets.length} 个工作表：${fileNames.join('、')}`);
      return { fileName: `${fileNames.length} 个 Excel 文件`, fileNames, sheetCount: fileNames.length, worksheetCount: workbook.Sheets.length, directoryName: directory.name, downloaded: false };
    } catch (error) {
      if (error.name !== 'AbortError') status(`Excel ${actionLabel}失败：${error.message}`);
      if (options.throwErrors) throw error;
      return null;
    }
  }

  // Project Save groups Sheets by file name and writes one Excel workbook per group.
  async function saveProjectWorkbook(directory) {
    const workbook = activeWorkbook();
    if (!workbook) throw new Error('请先创建或导入工程 Excel，再保存项目。');
    if (!(workbook.Sheets || []).length) throw new Error('工程 Excel 至少需要一个 Sheet。');
    if (!directory) throw new Error('缺少 Excel 保存目录，请先在枚举管理中选择 Excel 目录。');
    const result = await saveSheetExcels('保存项目 Excel', '', { throwErrors: true, directory });
    if (!result) throw new Error('枚举 Excel 保存未完成。');
    return result;
  }

  function getCSharpArtifact() {
    const workbook = activeWorkbook();
    if (!workbook) throw new Error('请先创建或导入工程 Excel，再生成 EnumName.cs。');
    return { fileName: 'EnumName.cs', source: makeCSharp(workbook) };
  }

  // C# source generation needs a real path so its success dialog can open Explorer.
  async function getCSharpOutputDirectory(options = {}) {
    return getNativeCSharpOutputDirectory(options);
  }

  async function setCSharpOutputDirectory(directory) {
    const workbook = activeWorkbook();
    if (!workbook || !directory) return null;
    csharpDirectoryHandles.set(workbook.WorkbookId, directory);
    if (!workbook.CSharpOutputDirectoryPath) workbook.CSharpOutputDirectoryName = directory.name;
    await storeHandle(`enum-csharp-output:${workbook.WorkbookId}`, directory).catch(() => {});
    render(); persist();
    return directory;
  }

  // Direct EnumName.cs generation uses the shared native host so the real path is known and Explorer can open it.
  async function getNativeCSharpOutputDirectory(options = {}) {
    const workbook = activeWorkbook();
    const nativeOutput = window.EquipmentFlowNativeOutput;
    if (!workbook) throw new Error('请先创建或导入工程 Excel，再选择 EnumName.cs 输出目录。');
    let directoryPath = String(workbook.CSharpOutputDirectoryPath || '');
    if (!directoryPath && options.allowPrompt === false) return null;
    if (!nativeOutput || !nativeOutput.available)
      throw new Error('当前页面未连接本机文件助手。请通过 WebEditorLocalServer.ps1 或 C# 内嵌界面启动。');
    if (!directoryPath && options.allowPrompt !== false) {
      const selected = await nativeOutput.chooseDirectory('');
      if (!selected) return null;
      directoryPath = String(selected.path || '');
      workbook.CSharpOutputDirectoryPath = directoryPath;
      workbook.CSharpOutputDirectoryName = String(selected.name || '');
      render(); persist();
    }
    if (!directoryPath) return null;
    const name = String(workbook.CSharpOutputDirectoryName || directoryPath.split(/[\\/]/).filter(Boolean).pop() || directoryPath);
    return { native: true, path: directoryPath, name };
  }

  async function ensureDirectory(workbook, kind, options = {}) {
    const isCSharp = kind === 'csharp';
    const allowPrompt = options.allowPrompt !== false;
    const checkPermission = options.checkPermission !== false;
    const handles = isCSharp ? csharpDirectoryHandles : excelDirectoryHandles;
    const key = `${isCSharp ? 'enum-csharp-output' : 'enum-excel-output'}:${workbook.WorkbookId}`;
    let directory = handles.get(workbook.WorkbookId) || await loadHandle(key);
    if (!directory && allowPrompt && window.showDirectoryPicker) {
      directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      handles.set(workbook.WorkbookId, directory);
      if (isCSharp && !workbook.CSharpOutputDirectoryPath) workbook.CSharpOutputDirectoryName = directory.name;
      else { workbook.ExcelDirectoryName = directory.name; workbook.OutputDirectoryName = directory.name; }
      await storeHandle(key, directory).catch(() => {});
      render(); persist();
    }
    if (directory && checkPermission) {
      let permission = await directory.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') permission = await directory.requestPermission({ mode: 'readwrite' });
      if (permission !== 'granted') throw new Error('没有获得所选目录的写入权限。');
      handles.set(workbook.WorkbookId, directory);
    }
    return directory;
  }

  // Enum source generation: each sheet becomes a region in the shared EnumName.cs file.
  function makeCSharp(workbook) {
    const namespace = String(workbook.Namespace || 'ParName').trim() || 'ParName';
    const allNames = new Set();
    const valid = value => /^[_\p{L}][\p{L}\p{N}_]*$/u.test(value || '') && !/^(abstract|as|base|bool|break|byte|case|catch|char|checked|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|goto|if|implicit|in|int|interface|internal|is|lock|long|namespace|new|null|object|operator|out|override|params|private|protected|public|readonly|ref|return|sbyte|sealed|short|sizeof|stackalloc|static|string|struct|switch|this|throw|true|try|typeof|uint|ulong|unchecked|unsafe|ushort|using|virtual|void|volatile|while|async|await|var)$/u.test(value);
    if (!namespace.split('.').every(valid)) throw new Error(`C# 命名空间「${namespace}」无效。`);
    const xmlComment = value => String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const registerEnumName = enumName => {
      if (!valid(enumName)) throw new Error(`C# 类型名「${enumName}」无效。`);
      const duplicateKey = enumName.toLowerCase();
      if (allNames.has(duplicateKey)) throw new Error(`C# 类型名 ${enumName} 重复。`);
      allNames.add(duplicateKey);
    };
    const renderEnum = (enumName, members) => {
      registerEnumName(enumName);
      const memberNames = new Set();
      members.forEach(member => {
        if (!valid(member.Name)) throw new Error(`${enumName} 中成员名「${member.Name}」不是有效 C# 标识符。`);
        if (memberNames.has(member.Name)) throw new Error(`${enumName} 中成员 ${member.Name} 重复。`);
        memberNames.add(member.Name);
        if (member.Value && !/^-?(?:0[xX][0-9a-fA-F]+|\d+)$/u.test(member.Value)) throw new Error(`${enumName}.${member.Name} 的枚举值只能填写十进制或十六进制整数。`);
      });
      const content = members.map(member => `${member.Comment ? `            /// <summary>\r\n            /// ${xmlComment(member.Comment)}\r\n            /// </summary>\r\n` : ''}            ${member.Name}${member.Value ? ` = ${member.Value}` : ''},`).join('\r\n');
      return `        public enum ${enumName}\r\n        {\r\n${content ? content + '\r\n' : ''}        }`;
    };
    if (!(workbook.Sheets || []).length) throw new Error('工作簿至少需要一个 Sheet。');
    const declarations = [];
    (workbook.Sheets || []).forEach(sheet => {
      normalizeSheetData(sheet);
      if (!TYPE_OPTIONS.includes(sheet.Type)) throw new Error(`${sheet.Name} 的枚举类型无效。`);
      const enumName = String(sheet.Name || '').trim();
      if (!valid(enumName)) throw new Error(`${sheet.Name} 的 C# 类型名「${enumName}」无效。`);
      let members;
      if (sheet.Type === 'ParName' && sheet.ParListKind) {
        const columns = sheet.Columns || [];
        const parameterNameColumn = findHeaderIndex(columns, ['参数名称En', '参数名En', 'ParameterNameEn']);
        const parameterCommentColumn = findHeaderIndex(columns, ['参数名称Cn', '参数名Cn', 'ParameterNameCn']);
        const functionNameColumn = findHeaderIndex(columns, ['功能名称En', '功能名En', 'FunctionNameEn']);
        const functionCommentColumn = findHeaderIndex(columns, ['功能名称Cn', '功能名Cn', 'FunctionNameCn']);
        const valueColumn = findLastHeaderIndex(columns, ['参数编号', '参数序号', '序号', '编号', 'Value']);
        const isFunctionEnum = sheet.ParListKind === 'FuncChk';
        const nameColumn = isFunctionEnum ? functionNameColumn : parameterNameColumn;
        const commentColumn = isFunctionEnum ? functionCommentColumn : parameterCommentColumn;
        if (nameColumn < 0 || valueColumn < 0) throw new Error(`${enumName} 缺少名称列或序号列。`);
        members = (sheet.DataRows || []).map(row => ({
          Name: String(row[nameColumn] || '').trim(),
          Value: String(row[valueColumn] || '').trim(),
          Comment: commentColumn < 0 ? '' : String(row[commentColumn] || '').trim(),
          ParameterName: parameterNameColumn < 0 ? '' : String(row[parameterNameColumn] || '').trim(),
        })).filter(member => member.Name && (!isFunctionEnum || !member.ParameterName));
      } else {
        // Keep blank Excel/template rows available in the editor, but do not treat them as enum members.
        members = (sheet.Rows || []).filter(row => row && String(row.Name || '').trim())
          .map(row => ({ Name: String(row.Name || '').trim(), Value: String(row.Value || '').trim(), Comment: String(row.Comment || '').trim() }));
      }
      if (sheet.Type === 'ParName' && members.some(member => !member.Value))
        throw new Error(`${sheet.Name} 中存在未填写的序号，无法保持枚举值与 Excel 一致。`);
      sheet.EnumName = enumName; sheet.RegionName = enumName;
      const enumBlocks = [renderEnum(enumName, members)];
      if (sheet.Type === 'ParName' && !sheet.ParListKind) {
        const parameterNameColumn = sheet.EnumMapping?.Name;
        const sequenceColumn = findLastHeaderIndex(sheet.Columns || [], ['参数编号', '参数序号', '序号', '编号', 'Value']);
        const valueColumn = sequenceColumn >= 0 ? sequenceColumn : sheet.EnumMapping?.Value;
        const functionNameColumn = findHeaderIndex(sheet.Columns || [], ['功能名称En', '功能名En', 'FunctionNameEn']);
        const functionCommentColumn = findHeaderIndex(sheet.Columns || [], ['功能名称Cn', '功能名Cn', 'FunctionNameCn']);
        if (functionNameColumn >= 0) {
          const functionMembers = (sheet.DataRows || []).map(row => ({
            Name: String(row[functionNameColumn] == null ? '' : row[functionNameColumn]).trim(),
            Value: valueColumn == null ? '' : String(row[valueColumn] == null ? '' : row[valueColumn]).trim(),
            Comment: functionCommentColumn < 0 ? '' : String(row[functionCommentColumn] == null ? '' : row[functionCommentColumn]).trim(),
            ParameterName: parameterNameColumn == null ? '' : String(row[parameterNameColumn] == null ? '' : row[parameterNameColumn]).trim(),
          })).filter(member => member.Name && !member.ParameterName);
          if (functionMembers.length) {
            if (functionMembers.some(member => !member.Value))
              throw new Error('FuncChk 中存在未填写序号的功能项，无法保持枚举值与 Excel 一致。');
            enumBlocks.push(renderEnum('FuncChk', functionMembers));
          }
        }
      }
      declarations.push(`        #region ${enumName}\r\n${enumBlocks.join('\r\n\r\n')}\r\n        #endregion`);
    });
    const body = declarations.join('\r\n\r\n');
    return `using System;\r\n\r\nnamespace ${namespace}\r\n{\r\n    public static class EnumName\r\n    {\r\n${body ? body + '\r\n' : ''}    }\r\n}\r\n`;
  }

  // Enum workspace actions: select shared output folders, save Excel, and generate C#.
  async function chooseDirectory(kind) {
    const workbook = activeWorkbook(); if (!workbook) return;
    const isCSharp = kind === 'csharp';
    if (isCSharp) {
      status('正在打开 EnumName.cs 输出目录选择窗口…');
      try {
        const nativeOutput = window.EquipmentFlowNativeOutput;
        if (!nativeOutput || !nativeOutput.available)
          throw new Error('请通过 WebEditorLocalServer.ps1 或 C# 内嵌界面启动，才能选择并打开本机输出目录。');
        const selected = await nativeOutput.chooseDirectory(workbook.CSharpOutputDirectoryPath || '');
        if (!selected) { status('已取消 C# 输出目录选择。'); return; }
        workbook.CSharpOutputDirectoryPath = String(selected.path || '');
        workbook.CSharpOutputDirectoryName = String(selected.name || '');
        render(); persist(); status(`EnumName.cs 输出目录已设为 ${workbook.CSharpOutputDirectoryName}`);
      } catch (error) { if (error.name !== 'AbortError') status(`选择目录失败：${error.message}`); }
      return;
    }
    if (!window.showDirectoryPicker) { status('当前浏览器不支持目录选择，请使用 Edge/Chrome 最新版指定 Excel 或 C# 输出目录。'); return; }
    try {
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      const handles = isCSharp ? csharpDirectoryHandles : excelDirectoryHandles;
      const key = `${isCSharp ? 'enum-csharp-output' : 'enum-excel-output'}:${workbook.WorkbookId}`;
      handles.set(workbook.WorkbookId, handle);
      if (isCSharp) workbook.CSharpOutputDirectoryName = handle.name;
      else { workbook.ExcelDirectoryName = handle.name; workbook.OutputDirectoryName = handle.name; }
      await storeHandle(key, handle).catch(() => {});
      render(); persist(); status(`${isCSharp ? 'EnumName.cs' : 'Excel'} 输出目录已设为 ${handle.name}`);
    } catch (error) { if (error.name !== 'AbortError') status(`选择目录失败：${error.message}`); }
  }

  async function generateCSharp() {
    const workbook = activeWorkbook(); if (!workbook) return;
    try {
      const directory = await getNativeCSharpOutputDirectory({ allowPrompt: false });
      if (!directory) throw new Error('路径配置异常：缺少 EnumName.cs 的 C# 输出目录。请先在枚举管理中选择输出目录。');
      let artifact;
      try { artifact = { fileName: 'EnumName.cs', source: makeCSharp(workbook) }; }
      catch (error) { throw new Error(`EnumName.cs 生成校验失败：${error.message}`); }
      if (!host || typeof host.generateEnumSource !== 'function')
        throw new Error('当前页面未连接 C# 文件生成服务。');
      const generatedFileName = await host.generateEnumSource(artifact, directory);
      if (generatedFileName === false) return;
      render(); persist(); status(`已在 ${directory.name} 生成 ${generatedFileName || artifact.fileName}。`);
    } catch (error) {
      if (error.name === 'AbortError') return;
      const message = `EnumName.cs 写入失败：${error.message}`;
      status(message);
      if (host?.showResult) host.showResult({ Success: false, Message: message, Diagnostics: [message] }, false);
    }
  }

  function initialize(options) {
    host = options;
    importFileInput = $('#enumWorkbookFile');
    $('#newEnumWorkbookButton').addEventListener('click', openNewWorkbook);
    $('#importEnumWorkbookButton').addEventListener('click', () => { if (host && host.setView) host.setView('enum'); importFileInput.click(); });
    $('#enumSaveWorkbookButton').addEventListener('click', saveWorkbook);
    $('#enumExportWorkbookButton').addEventListener('click', saveWorkbookAs);
    $('#enumGenerateCSharpButton').addEventListener('click', generateCSharp);
    $('#chooseEnumExcelDirectoryButton').addEventListener('click', () => chooseDirectory('excel'));
    $('#chooseEnumCSharpDirectoryButton').addEventListener('click', () => chooseDirectory('csharp'));
    $('#enumNewSheetButton').addEventListener('click', () => {
      const workbook = activeWorkbook(); if (!workbook) { openNewWorkbook(); return; }
      openSheetDialog();
    });
    $('#enumDeleteWorkbookButton').addEventListener('click', deleteCurrentWorkbook);
    $('#enumNamespaceInput').addEventListener('change', event => { const workbook = activeWorkbook(); if (workbook) { workbook.Namespace = event.target.value.trim() || 'ParName'; persist(); } });
    $('#newEnumWorkbookForm').addEventListener('submit', createWorkbook);
    $('#newEnumSheetForm').addEventListener('submit', createSheet);
    $('#newEnumSheetNameInput').addEventListener('input', event => {
      const fileNameInput = $('#newEnumSheetFileNameInput');
      if (!pendingNewSheetImport && fileNameInput.dataset.autoName === 'true') fileNameInput.value = normalizeExcelFileName(event.target.value || 'NewEnum');
    });
    $('#newEnumSheetFileNameInput').addEventListener('input', event => { event.target.dataset.autoName = 'false'; });
    $('#newEnumSheetImportChoice').addEventListener('change', event => {
      const source = pendingNewSheetImport;
      if (!source || $('#newEnumSheetFileNameInput').dataset.autoName !== 'true') return;
      const selectedIndex = Number(event.target.value || 0);
      const imported = source.sheets[selectedIndex];
      $('#newEnumSheetFileNameInput').value = suggestedSheetFileName(source.file.name, imported?.name, selectedIndex, source.sheets.length);
    });
    $('#importEnumForm').addEventListener('submit', completeImport);
    $('#enumImportTypeInput').addEventListener('change', renderImportSheetRows);
    $('#enumImportSheets').addEventListener('input', event => {
      if (!pendingImport?.isEmbeddedWorkbook || !event.target.matches('[data-import-file-name]') || event.target.readOnly) return;
      $('#enumImportSheets').querySelectorAll('[data-import-file-name][readonly]').forEach(input => { input.value = event.target.value; });
    });
    $('#importEnumDialog').addEventListener('close', () => {
      pendingImport = null;
      $('#enumImportSheets').replaceChildren();
      $('#enumImportTypeInput').disabled = false;
    });
    $('#newEnumWorkbookTypeInput').addEventListener('change', event => {
      const defaults = DEFAULTS[event.target.value] || DEFAULTS.GenericEnum;
      $('#newEnumWorkbookSheetNameInput').value = defaults[0];
    });
    $('#newEnumSheetImportFile').addEventListener('change', async event => {
      const file = event.target.files?.[0];
      pendingNewSheetImport = null;
      $('#newEnumSheetImportChoiceField').classList.add('hidden');
      $('#newEnumSheetImportChoice').replaceChildren();
      if (!file) return;
      try {
        const imported = await readWorkbookFile(file);
        pendingNewSheetImport = { file, sheets: imported.sheets };
        const select = $('#newEnumSheetImportChoice');
        select.innerHTML = imported.sheets.map((sheet, index) => `<option value="${index}">${esc(sheet.name || `Sheet${index + 1}`)}</option>`).join('');
        if ($('#newEnumSheetFileNameInput').dataset.autoName === 'true') {
          $('#newEnumSheetFileNameInput').value = suggestedSheetFileName(file.name, imported.sheets[0]?.name, 0, imported.sheets.length);
        }
        $('#newEnumSheetImportChoiceField').classList.remove('hidden');
        status(`已读取 ${file.name}，可选择要导入的 Sheet。`);
      } catch (error) {
        event.target.value = '';
        status(`读取 Excel 失败：${error.message || error}`);
      }
    });
    $('#newEnumSheetDialog').addEventListener('close', () => {
      if (!$('#newEnumSheetImportFile').value) pendingNewSheetImport = null;
      editingSheetId = '';
      $('#newEnumSheetImportFile').disabled = false;
      $('#newEnumSheetFileNameInput').dataset.autoName = 'false';
    });
    document.addEventListener('pointerdown', event => { if (!event.target.closest('#enumContextMenu')) hideEnumContextMenu(); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape') hideEnumContextMenu(); });
    importFileInput.addEventListener('change', async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      try { await importWorkbook(file); }
      catch (error) { status(`Excel 导入失败：${error.message}`); }
      event.target.value = '';
    });
    render();
    restoreWorkbookHandles();
  }

  window.EquipmentFlowEnumWorkbench = {
    initialize,
    openWorkbook,
    getWorkbooks: allWorkbooks,
    createXlsxBlob,
    makeCSharp,
    prepareExcelDirectoryForSave,
    saveProjectWorkbook,
    getCSharpArtifact,
    getCSharpOutputDirectory,
    setCSharpOutputDirectory,
    getNativeCSharpOutputDirectory,
    deleteCurrentWorkbook,
  };
})();
