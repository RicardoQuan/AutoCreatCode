(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const parameterBindings = window.EquipmentFlowParameterBindings;
  const methodLibrary = window.EquipmentFlowMethodLibrary;
  const HANDLE_DATABASE = 'botech-equipment-flow-handles';
  const HANDLE_STORE = 'handles';
  const PROJECT_DIRTY_KEY = 'botech.task-editor.project-dirty';
  const PROJECT_SAVED_LABEL_KEY = 'botech.task-editor.project-saved-label';
  const PROJECT_FILE_PATH_KEY = 'botech.task-editor.project-file-path';
  const TASK_SAVE_STATES_KEY = 'botech.task-editor.task-save-states';
  const TOOL_PANELS = {
    methods: { rail: 'leftRail', toggle: 'methodsPanelToggle', edge: 'methodsEdgeToggle', floating: 'methodsFloatToggle', autoHide: 'methodsAutoHideToggle', close: 'methodsHideToggle', title: '方法库', width: 330 },
    node: { rail: 'nodeRail', toggle: 'nodePanelToggle', edge: 'nodeEdgeToggle', floating: 'nodeFloatToggle', autoHide: 'nodeAutoHideToggle', close: 'nodeHideToggle', title: '节点绑定', width: 360 },
    hardware: { rail: 'hardwareRail', toggle: 'hardwarePanelToggle', edge: 'hardwareEdgeToggle', floating: 'hardwareFloatToggle', autoHide: 'hardwareAutoHideToggle', close: 'hardwareHideToggle', title: '硬件清单', width: 360 },
  };
  const PANEL_ICONS = {
    float: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M8 4H4v12h12v-4M11 3h6v6M17 3l-8 8"/></svg>',
    dock: '<svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M12 3v14"/></svg>',
    pin: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 3 6 0 1 5 2 2v1H4v-1l2-2 1-5ZM10 11v6"/></svg>',
    unpin: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 4 10 10M7 3h6l1 5 2 2v1H4v-1l2-2 1-5ZM10 11v6"/></svg>',
    close: '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m5 5 10 10M15 5 5 15"/></svg>',
  };
  let methodCodeEditor = null;
  let methodDialogBaseline = '';
  let taskVariablesDialogBaseline = '';
  let methodSelectionAnchor = '';
  let editingHardwareId = '';
  let hardwareDialogSlots = [];
  let hardwareDialogParts = [];
  let hardwareDialogNozzles = [];
  let selectedHardwareNozzleId = '';
  let hardwareDialogVariables = [];
  let methodCustomVariables = [];
  const selectedMethodIds = new Set();
  const state = {
    workspace: null,
    mode: 'browser',
    activeWorkspaceView: 'flow',
    stationId: null,
    editingMethod: null,
    pendingTaskTemplate: null,
    pendingTaskCopySourceId: '',
    selectedNodeId: null,
    activeInspector: 'node',
    layout: {},
    activeHardwareResourceKey: '',
    panelState: { methods: true, node: true, hardware: true },
    panelDock: { methods: 'left', node: 'right', hardware: 'right' },
    panelFloating: { methods: false, node: false, hardware: false },
    panelAutoHide: { methods: false, node: false, hardware: false },
    panelPeek: { methods: false, node: false, hardware: false },
    panelBounds: {},
    panelWidths: { left: 330, right: 360 },
    panelResize: null,
    panelHideTimers: {},
    panelDrag: null,
    suppressPanelClick: false,
    projectFileHandle: null,
    projectFilePath: '',
    projectFileDirectoryPath: '',
    projectDirty: true,
    projectSavedLabel: '',
    taskSaveStates: {},
    suppressProjectDirty: false,
    taskOutputDirectories: new Map(),
    invalidFields: new Set(),
    invalidDrafts: new Map(),
    infoBindingKey: null,
  };

  // Shared selectors, current Task/flow lookup, and user-facing status helpers.
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
  }

  function currentFlow() {
    return state.workspace && state.workspace.Flows.find(flow => flow.StationId === state.stationId);
  }

  function currentTask() {
    return state.workspace && (state.workspace.Tasks || []).find(task => task.TaskId === state.stationId);
  }

  function taskBaseTypeIdentity(typeName) {
    const value = String(typeName || '').trim().replace(/^global::/, '').replace(/\s+/g, '');
    if (!value) return '';
    if (value.toLowerCase() === 'taskbase_moverstation') return 'botech.taskbase_moverstation';
    return value.toLowerCase();
  }

  function isDefaultTaskBase(typeName) {
    const value = String(typeName || '').trim().replace(/^global::/, '').replace(/\s+/g, '').toLowerCase();
    return value === 'taskbase_moverstation' || value === 'botech.taskbase_moverstation';
  }

  function taskInheritsAutoRun(task) {
    if (!task?.BaseType) return false;
    let typeName = String(task.BaseType).trim();
    const visited = new Set();
    while (typeName) {
      const identity = taskBaseTypeIdentity(typeName);
      if (!identity || visited.has(identity)) return false;
      visited.add(identity);
      if (isDefaultTaskBase(typeName)) return true;
      const definition = baseTypeDefinition(typeName);
      const hasInheritedAutoRun = definition.methods.some(method =>
        String(method.MethodName || method.name || '').toLowerCase() === 'autorun'
        && String(method.AccessModifier || '').toLowerCase() !== 'private'
        && !methodModifierSet(method).has('static'));
      if (hasInheritedAutoRun) return true;
      typeName = String(definition.BaseType || '').trim();
    }
    return false;
  }

  function flowHasExecutableNodes(flow) {
    return Boolean(flow && (flow.Nodes || []).some(node => node && !['Start', 'End'].includes(node.NodeType)));
  }

  function taskUsesInheritedAutoRun(task, flow = currentFlow()) {
    return taskInheritsAutoRun(task) && !flowHasExecutableNodes(flow);
  }

  function flowForTaskGeneration(task, flow) {
    return taskUsesInheritedAutoRun(task, flow) ? null : flow;
  }

  function createTaskFlow(task) {
    const flow = window.EquipmentFlowTaskCodegen.defaultFlow(task);
    if (taskInheritsAutoRun(task)) {
      flow.EntryNodeId = '';
      flow.Nodes = [];
      flow.Transitions = [];
    }
    return flow;
  }

  function nodeDraftKey(flow, nodeId, field) {
    return JSON.stringify([flow.FlowId, flow.StationId, nodeId, field]);
  }

  function clearFlowDrafts(invalidFields, invalidDrafts, flow, nodeId) {
    const scope = [flow.FlowId, flow.StationId];
    if (nodeId !== undefined) scope.push(nodeId);
    const prefix = JSON.stringify(scope).slice(0, -1) + ',';
    for (const collection of [invalidFields, invalidDrafts]) {
      for (const key of Array.from(collection.keys())) if (key.startsWith(prefix)) collection.delete(key);
    }
  }

  function selectedNode() {
    const flow = currentFlow();
    return flow && flow.Nodes.find(node => node.NodeId === state.selectedNodeId);
  }

  function applicableMethods(flow = currentFlow()) {
    if (!state.workspace || !flow) return [];
    return methodsForTask(flow.StationId).filter(method => method.CanBind !== false);
  }

  // Keep generated partial classes isolated to methods valid for their Task and machine.
  function methodsForTask(taskId) {
    if (!state.workspace) return [];
    return (state.workspace.Methods || []).filter(method => method &&
      (!method.TaskId || method.TaskId === taskId)
      && (!method.MachineName || method.MachineName === state.workspace.MachineName)
      && (!method.StationId || method.StationId === taskId));
  }

  function methodFor(node, taskId = state.stationId) {
    if (!node || !state.workspace) return null;
    const hasExplicitScope = Object.prototype.hasOwnProperty.call(node, 'MethodMachineName')
      || Object.prototype.hasOwnProperty.call(node, 'MethodStationId');
    const matches = (state.workspace.Methods || []).filter(method => method &&
      method.MethodId === node.MethodId
      && Number(method.SchemaVersion) === Number(node.MethodSchemaVersion)
      && (!hasExplicitScope || (String(method.MachineName || '') === String(node.MethodMachineName || '')
        && String(method.StationId || '') === String(node.MethodStationId || '')))
      && (!method.TaskId || method.TaskId === taskId)
      && (!method.MachineName || method.MachineName === state.workspace.MachineName)
      && (!method.StationId || method.StationId === taskId));
    return matches.sort((left, right) => Number(Boolean(right.MachineName)) + Number(Boolean(right.StationId))
      - Number(Boolean(left.MachineName)) - Number(Boolean(left.StationId)))[0] || null;
  }

  // Show the latest validation or save result without taking space from either workspace.
  let diagnosticsHideTimer = null;
  function showDiagnosticsToast() {
    $('#diagnosticsPanel').classList.remove('hidden');
    window.clearTimeout(diagnosticsHideTimer);
    diagnosticsHideTimer = window.setTimeout(closeDiagnostics, 2000);
  }

  function appendDiagnosticMessage(message, kind = 'error') {
    const panel = $('#diagnosticsPanel');
    const list = $('#diagnosticsList');
    if (!panel || !list || !message) return;
    if (panel.classList.contains('hidden')) list.replaceChildren();
    if (list.lastElementChild?.textContent === String(message)) {
      showDiagnosticsToast();
      return;
    }
    const row = document.createElement('div');
    row.className = `diagnostic-item${kind === 'success' ? ' diagnostic-ok' : kind === 'warning' ? ' diagnostic-warning' : ''}`;
    row.textContent = String(message);
    list.appendChild(row);
    while (list.childElementCount > 100) list.firstElementChild.remove();
    list.scrollTop = list.scrollHeight;
    showDiagnosticsToast();
  }

  function setStatus(message, kind = 'normal', logWarning = true) {
    const statusText = $('#statusMessage');
    statusText.textContent = message;
    statusText.title = String(message || '');
    const text = String(message || '');
    const detectedKind = kind === 'warning' || kind === 'error' ? kind
      : /失败|错误|无效|无法|不能|未找到|不支持|校验发现|缺少|重复|已存在|必须|超出/.test(text) ? 'error'
        : /成功|已.+(?:生成|保存|导入|导出|更新|删除|新增|创建|恢复|读取|写入|设置|重命名|复制|另存)|校验通过/.test(text) ? 'success'
          : kind;
    statusText.dataset.state = detectedKind;
    const lamp = $('.status-led');
    lamp.className = `status-led${detectedKind === 'error' ? ' error' : detectedKind === 'warning' ? ' warning' : detectedKind === 'success' ? ' success' : ''}`;
    if (logWarning && (detectedKind === 'error' || detectedKind === 'warning'))
      appendDiagnosticMessage(message, detectedKind);
  }

  function setWorkspaceView(view) {
    const activeView = view === 'enum' ? 'enum' : 'flow';
    state.activeWorkspaceView = activeView;
    $('#flowWorkspace').classList.toggle('hidden', activeView !== 'flow');
    $('#enumWorkspace').classList.toggle('hidden', activeView !== 'enum');
    $('#flowWorkspaceMenuButton').setAttribute('aria-pressed', String(activeView === 'flow'));
    $('#enumWorkspaceMenuButton').setAttribute('aria-pressed', String(activeView === 'enum'));
    const viewTitle = activeView === 'enum' ? '设备枚举表' : '设备流程图';
    $('#workspaceBrandTitle').textContent = viewTitle;
    document.title = `${viewTitle} · WebEditor`;
    try { localStorage.setItem('botech.task-editor.active-view', activeView); } catch (_) { /* View choice is optional. */ }
    $$('details.top-menu[open]').forEach(menu => menu.removeAttribute('open'));
    if (activeView === 'flow') requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }

  function showResult(result, projectSaved) {
    $('#diagnosticsList').replaceChildren();
    if (!result || !result.Success) {
      const items = (result && result.Diagnostics && result.Diagnostics.length)
        ? result.Diagnostics : [(result && result.Message) || '校验失败'];
      items.forEach(item => appendDiagnosticMessage(item, 'error'));
      setStatus(`校验发现 ${items.length} 项需要修正的问题`, 'error', false);
      return;
    }
    appendDiagnosticMessage(projectSaved ? '项目流程与配置已保存为 JSON，工程枚举工作表已保存为 Excel。' : '全部 Task 流程、方法绑定、硬件绑定和工程枚举检查通过。', 'success');
    (result.Diagnostics || []).forEach(item => appendDiagnosticMessage(item, 'success'));
    setStatus(projectSaved
      ? '项目 JSON 与枚举 Excel 已保存'
      : '检查通过', 'normal');
  }

  function showProjectSaveSuccess(path, directoryPath, excel) {
    const dialog = $('#projectSaveSuccessDialog');
    const nativeAvailable = Boolean(window.EquipmentFlowNativeOutput?.available && directoryPath);
    $('#projectSavePath').textContent = path || '浏览器已保存文件，但未提供本机绝对路径。';
    $('#projectSaveExcelSummary').textContent = excel
      ? `工程 Excel 已保存：${excel.sheetCount} 个文件、${excel.worksheetCount} 个工作表，目录：${excel.directoryName}`
      : '工程 Excel 已随项目保存。';
    $('#projectSaveFolderHint').textContent = nativeAvailable
      ? '更改位置会另存一份项目文件，原文件保留；也可以打开当前文件夹。'
      : '浏览器未提供本机目录权限；若需显示完整路径并打开文件夹，请通过本机助手或 C# 内嵌界面保存。';
    $('#changeSavedProjectPathButton').hidden = !window.EquipmentFlowNativeOutput?.available;
    $('#openSavedProjectFolderButton').hidden = !nativeAvailable;
    $('#projectSaveSuccessError').textContent = '';
    $('#projectSaveSuccessError').classList.add('hidden');
    dialog.dataset.projectDirectoryPath = directoryPath || '';
    if (!dialog.open) dialog.showModal();
  }

  // Workspace startup, recovery, and normalization of older saved projects.
  function initializeEditor() {
    loadPanelState();
    let repairedFlows = [];
    state.workspace = {
      MachineName: '', PackageName: '', PackageVersion: '1.0.0',
      Stations: [], Tasks: [], Methods: [], MethodFiles: [], Hardware: [],
      HardwareFiles: [], HardwareFactories: [], HardwareCatalogResources: [], HardwareSlots: [], HardwareBindings: [], HardwareDefinitions: [],
      DataBindings: [], Flows: [], StartupDiagnostics: [], TaskTemplate: null, EnumWorkbooks: [],
    };
    try {
      const saved = JSON.parse(localStorage.getItem('botech.task-editor.project') || 'null');
      if (saved && saved.format === 'BoTech.TaskEditorProject' && saved.workspace) {
        const savedFlows = Array.isArray(saved.workspace.Flows) ? saved.workspace.Flows : [];
        const previousEntries = new Map(savedFlows.map(flow => [`${flow.StationId || ''}\u0000${flow.FlowId || ''}`, flow.EntryNodeId]));
        state.workspace = normalizeWorkspace(saved.workspace);
        repairedFlows = state.workspace.Flows.filter(flow => {
          const key = `${flow.StationId || ''}\u0000${flow.FlowId || ''}`;
          return previousEntries.has(key) && previousEntries.get(key) !== flow.EntryNodeId;
        });
        state.stationId = saved.activeTaskId || (state.workspace.Tasks[0] && state.workspace.Tasks[0].TaskId) || '';
      }
    } catch (_) { /* Ignore an invalid or unavailable browser draft. */ }
    try {
      state.projectDirty = localStorage.getItem(PROJECT_DIRTY_KEY) !== 'false';
      state.projectSavedLabel = localStorage.getItem(PROJECT_SAVED_LABEL_KEY) || '';
    } catch (_) { state.projectDirty = true; }
    restoreTaskSaveStates();
    if (repairedFlows.length) {
      new Set(repairedFlows.map(flow => flow.StationId).filter(Boolean)).forEach(taskId => markProjectDirty(taskId));
      try { localStorage.setItem('botech.task-editor.project', JSON.stringify(projectSnapshot())); }
      catch (_) { /* Keep the in-memory repair if browser storage is unavailable. */ }
    }
    updateProjectSaveStatus();
    $('#stationCount').textContent = '0';
    $('#methodCount').textContent = '0';
    $('#validateButton').disabled = true;
    $('#downloadGenerateButton').disabled = true;
    $('#saveButton').disabled = true;
    $('#exportDrawioButton').disabled = true;
    $('#newMethodButton').disabled = true;
    $('#importMethodsButton').disabled = true;
    $('#deleteTaskButton').disabled = true;
    renderAll();
    updateWorkspaceHeader();
    $('#viewTaskTemplateButton').disabled = !state.workspace.TaskTemplate;
    renderPanelVisibility();
    let preferredView = 'flow';
    try { preferredView = localStorage.getItem('botech.task-editor.active-view') || 'flow'; } catch (_) { /* Keep the default view when storage is unavailable. */ }
    setWorkspaceView(preferredView === 'enum' ? 'enum' : 'flow');
    setStatus(repairedFlows.length
      ? `已自动修正 ${repairedFlows.length} 个流程入口，请保存项目`
      : state.workspace.Tasks.length ? '已恢复 Task 项目，可继续编辑' : '新建 Task 或导入 Task 模板开始编辑',
    repairedFlows.length ? 'warning' : 'normal');
  }

  function normalizeWorkspace(workspace) {
    const result = workspace && typeof workspace === 'object' ? workspace : {};
    result.Tasks = Array.isArray(result.Tasks) ? result.Tasks : [];
    result.Stations = Array.isArray(result.Stations) ? result.Stations : [];
    result.Flows = Array.isArray(result.Flows) ? result.Flows : [];
    result.Methods = Array.isArray(result.Methods) ? result.Methods : [];
    result.Methods.forEach(method => {
      if (!Array.isArray(method.Parameters)) method.Parameters = [];
      let sourceParameters = [];
      if (method.SourceCode && window.EquipmentFlowCSharpCatalog) {
        try {
          const parsed = window.EquipmentFlowCSharpCatalog.parseSource(
            `partial class __TaskProjectMethodSignature {\n${method.SourceCode}\n}`, '__TaskProjectMethodSignature.cs');
          sourceParameters = (parsed.classes[0]?.methods || [])
            .find(item => item.MethodName === method.MethodName)?.Parameters || [];
        } catch (_) { sourceParameters = []; }
      }
      method.Parameters = method.Parameters.map(parameter => {
        const sourceParameter = sourceParameters.find(item => item.Name === parameter.Name);
        const direction = sourceParameter ? sourceParameter.Direction
          : Number(method.ParameterModelVersion) >= 2 ? parameter.Direction || 'value'
            : parameter.Direction === 'in' ? 'value' : parameter.Direction || 'value';
        const defaultValue = sourceParameter ? sourceParameter.DefaultValue || '' : parameter.DefaultValue || '';
        const isParams = sourceParameter ? Boolean(sourceParameter.IsParams) : Boolean(parameter.IsParams);
        return { ...parameter, Direction: direction, DefaultValue: defaultValue, IsParams: isParams,
          Required: direction !== 'out' && !defaultValue && !isParams };
      });
      method.ParameterModelVersion = 2;
    });
    result.Tasks.forEach(task => {
      task.Namespace = String(task.Namespace || 'BoTech').trim() || 'BoTech';
      task.ClassName = String(task.ClassName || task.Name || 'Task').trim() || 'Task';
      task.OutputDirectoryPath = String(task.OutputDirectoryPath || '');
      task.OutputDirectoryName = String(task.OutputDirectoryName || '');
      task.BaseType = Object.prototype.hasOwnProperty.call(task, 'BaseType')
        ? String(task.BaseType || '').trim()
        : 'TaskBase_MoverStation';
      task.SourceBaseType = Object.prototype.hasOwnProperty.call(task, 'SourceBaseType')
        ? String(task.SourceBaseType || '').trim()
        : task.BaseType;
      task.AccessModifier = ['public', 'internal'].includes(task.AccessModifier) ? task.AccessModifier : 'public';
      task.ClassModifier = ['abstract', 'sealed'].includes(task.ClassModifier) ? task.ClassModifier : '';
      if (!Array.isArray(task.MethodCategories)) task.MethodCategories = [];
      task.MethodCategories = task.MethodCategories.map((item, index) => {
        const category = typeof item === 'string' ? { Name: item, RegionName: item, Order: index }
          : item && typeof item === 'object' ? item : null;
        if (!category) return null;
        category.Name = String(category.Name || category.RegionName || '').trim();
        category.RegionName = category.Name;
        if (category.Order == null || !Number.isFinite(Number(category.Order))) category.Order = index;
        return category;
      }).filter(category => category && category.Name);
      if (!task.MethodCategories.length) task.MethodCategories.push({ Name: 'Common', RegionName: 'Common', Order: 0 });
      const legacyVariables = result.Methods.filter(method => method.TaskId === task.TaskId && Array.isArray(method.CustomVariables))
        .flatMap(method => method.CustomVariables);
      const taskVariables = Array.isArray(task.MethodVariables) ? task.MethodVariables.slice() : [];
      const variableNames = new Set(taskVariables.map(variable => String(variable.Name || '').toLowerCase()));
      legacyVariables.forEach(variable => {
        const key = String(variable.Name || '').toLowerCase();
        if (!variableNames.has(key)) { taskVariables.push(variable); variableNames.add(key); }
      });
      task.MethodVariables = taskVariables;
      result.Methods.filter(method => method.TaskId === task.TaskId).forEach(method => { delete method.CustomVariables; });
    });
    result.MethodFiles = Array.isArray(result.MethodFiles) ? result.MethodFiles : [];
    result.EnumWorkbooks = Array.isArray(result.EnumWorkbooks) ? result.EnumWorkbooks : [];
    result.Hardware = Array.isArray(result.Hardware) ? result.Hardware : [];
    result.HardwareFiles = Array.isArray(result.HardwareFiles) ? result.HardwareFiles : [];
    result.HardwareFactories = Array.isArray(result.HardwareFactories) ? result.HardwareFactories : [];
    result.HardwareCatalogResources = Array.isArray(result.HardwareCatalogResources) ? result.HardwareCatalogResources : [];
    result.HardwareSlots = Array.isArray(result.HardwareSlots) ? result.HardwareSlots : [];
    result.HardwareBindings = Array.isArray(result.HardwareBindings) ? result.HardwareBindings : [];
    result.HardwareDefinitions = Array.isArray(result.HardwareDefinitions) ? result.HardwareDefinitions : [];
    // Port placement is geometry, not the state value. Preserve explicit bool
    // outcomes when arranging or reopening; infer only missing legacy values.
    result.Flows.forEach(flow => {
      if (!flow || !Array.isArray(flow.Nodes)) return;
      if (!Array.isArray(flow.Transitions)) flow.Transitions = [];
      window.EquipmentFlowCanvas.synchronizeEntryNode(flow);
      flow.Nodes.forEach(node => {
        if (node && node.NodeType === 'Start') node.DisplayName = '开始';
        else if (node && node.NodeType === 'End') node.DisplayName = '结束';
      });
      const methods = result.Methods.filter(method => method &&
        (!method.TaskId || method.TaskId === flow.StationId)
        && (!method.StationId || method.StationId === flow.StationId));
      const nodesById = new Map(flow.Nodes.filter(node => node && typeof node === 'object').map(node => [node.NodeId, node]));
      flow.Transitions.forEach(edge => {
        if (!edge || typeof edge !== 'object') return;
        const source = nodesById.get(edge.FromNodeId);
        const sourcePort = edge.CanvasSourcePort;
        if (!source || source.NodeType !== 'Condition' || !source.MethodId) return;
        const method = methodLibrary.resolveMethodSelection(methods, source.MethodId);
        if (!method || !['bool', 'system.boolean'].includes(String(method.ReturnType || '').toLowerCase())) return;
        const outcome = String(edge.Outcome ?? '').toLowerCase();
        if (['true', 'false'].includes(outcome)) edge.Outcome = outcome;
        else if (['e', 's'].includes(sourcePort)) edge.Outcome = sourcePort === 'e' ? 'false' : 'true';
      });
    });
    result.CanvasLayouts = result.CanvasLayouts && typeof result.CanvasLayouts === 'object' ? result.CanvasLayouts : {};
    return result;
  }

  function updateWorkspaceHeader() {
    if (!state.workspace) return;
    const task = currentTask();
    updateProjectSaveStatus();
    $('#stationCount').textContent = String((state.workspace.Tasks || []).length);
    const taskMethods = (state.workspace.Methods || []).filter(method => !task || taskOwnsMethod(method, task.TaskId));
    const inheritedMethods = task ? inheritedMethodsForTask(task) : [];
    $('#methodCount').textContent = String(taskMethods.length + inheritedMethods.filter(item => !item.local).length);
    renderTaskClassSettings(task);
    $('#taskOutputDirectoryInput').value = task
      ? taskOutputDirectoryLabel(task)
      : '';
    $('#validateButton').disabled = !(state.workspace.Tasks || []).length;
    $('#downloadGenerateButton').disabled = !(state.workspace.Tasks || []).length;
    $('#saveButton').disabled = !(state.workspace.Tasks || []).length;
    $('#exportTaskSourcesMenuButton').disabled = !task;
    ['flowSourceButton', 'methodsSourceButton', 'hardwareSourceButton'].forEach(id => {
      const button = $('#' + id);
      if (button) button.disabled = !task;
    });
    const flowSourceButton = $('#flowSourceButton');
    if (flowSourceButton) {
      const inheritedOnly = taskUsesInheritedAutoRun(task, currentFlow());
      flowSourceButton.disabled = !task || inheritedOnly;
      flowSourceButton.title = inheritedOnly ? '此 Task 继承父类 AutoRun，无需生成流程 .cs' : '生成流程 .cs';
    }
    $('#saveAsProjectButton').disabled = !(state.workspace.Tasks || []).length;
    $('#newMethodButton').disabled = !task;
    $('#manageTaskVariablesButton').disabled = !task;
    $('#importMethodsButton').disabled = !task;
    $('#manageMethodRegionsButton').disabled = !task;
    $('#deleteTaskButton').disabled = !task;
    $('#copyTaskAsNewButton').disabled = !task;
    $('#copyTaskIntoExistingButton').disabled = !task || (state.workspace.Tasks || []).length < 2;
    $('#chooseTaskOutputDirectoryButton').disabled = !task;
    $('#hardwareCreateButton').disabled = !task;
    $('#hardwareImportButton').disabled = !task;
    $('#exportDrawioButton').disabled = !currentFlow();
  }

  // Task class configuration: expose valid bases and keep partial declarations consistent.
  const CUSTOM_TASK_BASE = '__custom_task_base__';

  function taskBaseTypeOptions(task) {
    const candidates = new Map();
    const addCandidate = (typeName, label = typeName, modifier = '') => {
      const name = String(typeName || '').trim();
      if (!name || name === `${task.Namespace || 'BoTech'}.${task.ClassName}` || name === task.ClassName) return;
      if (modifier === 'sealed' || modifier === 'static') return;
      const identity = taskBaseTypeIdentity(name);
      if (!candidates.has(identity)) candidates.set(identity, { value: name, label });
    };
    addCandidate('BoTech.TaskBase_MoverStation', 'TaskBase_MoverStation · 默认运行基类');
    (state.workspace?.Tasks || []).forEach(candidate => {
      if (candidate.TaskId === task.TaskId) return;
      const fullName = `${candidate.Namespace || 'BoTech'}.${candidate.ClassName}`;
      addCandidate(fullName, fullName, candidate.ClassModifier || '');
    });
    (task.TemplateFiles || []).forEach(file => {
      try {
        const parsed = window.EquipmentFlowCSharpCatalog.parseSource(String(file.Source || ''), file.Path || `${task.ClassName}.cs`);
        parsed.classes.filter(type => type.kind === 'class').forEach(type => {
          addCandidate(type.fullName, type.fullName, (type.Modifiers || []).find(item => ['sealed', 'static'].includes(item)) || '');
        });
      } catch (_) { /* One incomplete template file must not hide the other base type choices. */ }
    });
    const current = String(task.BaseType || '').trim();
    const currentIdentity = taskBaseTypeIdentity(current);
    if (current && !candidates.has(currentIdentity))
      candidates.set(currentIdentity, { value: current, label: `${current} · 当前基类` });
    return Array.from(candidates.values());
  }

  function renderTaskClassSettings(task) {
    const identity = $('#taskClassNameInput');
    const baseSelect = $('#taskBaseTypeSelect');
    const customBase = $('#taskBaseTypeCustom');
    const modifierSelect = $('#taskClassModifierSelect');
    const accessSelect = $('#taskAccessModifierSelect');
    const hint = $('#taskClassModifierHint');
    if (!identity || !baseSelect || !customBase || !modifierSelect || !accessSelect || !hint) return;
    const enabled = Boolean(task);
    identity.value = task ? `${task.Namespace || 'BoTech'}.${task.ClassName}` : '';
    [baseSelect, modifierSelect, accessSelect].forEach(control => { control.disabled = !enabled; });
    if (!task) {
      baseSelect.innerHTML = '<option value="">先选择 Task</option>';
      customBase.value = ''; customBase.disabled = true; customBase.classList.add('hidden');
      modifierSelect.value = ''; accessSelect.value = 'public'; hint.textContent = '';
      return;
    }
    const options = taskBaseTypeOptions(task);
    const base = String(task.BaseType || '').trim();
    baseSelect.innerHTML = '<option value="">无基类</option>'
      + options.map(item => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('')
      + `<option value="${CUSTOM_TASK_BASE}">自定义类型…</option>`;
    const knownBase = options.find(item => taskBaseTypeIdentity(item.value) === taskBaseTypeIdentity(base));
    const isKnownBase = !base || Boolean(knownBase);
    baseSelect.value = !base ? '' : isKnownBase ? knownBase.value : CUSTOM_TASK_BASE;
    customBase.value = isKnownBase ? '' : base;
    customBase.disabled = isKnownBase;
    customBase.classList.toggle('hidden', isKnownBase);
    modifierSelect.value = ['abstract', 'sealed'].includes(task.ClassModifier) ? task.ClassModifier : '';
    accessSelect.value = task.AccessModifier === 'internal' ? 'internal' : 'public';
    hint.textContent = !base
      ? '当前 Task 不继承基类；流程运行所需的 StaInfo、SetStep 等成员需由当前 Task 提供。'
      : taskUsesInheritedAutoRun(task)
        ? `继承父类 ${base} 的 AutoRun；当前 Task 无需绘制或生成流程 AutoRun。`
      : task.ClassModifier === 'abstract'
        ? 'abstract 类不能直接实例化，适用于抽象基类或模板。'
        : task.ClassModifier === 'sealed' ? 'sealed 类不能再作为其他 Task 的基类。' : '';
  }

  function isValidTaskBaseType(value) {
    const segments = String(value || '').trim().split('.');
    return segments.length > 0 && segments.every(segment => window.EquipmentFlowTaskCodegen.validIdentifier(segment));
  }

  function projectTaskForBaseType(typeName) {
    const value = String(typeName || '').trim();
    return (state.workspace?.Tasks || []).find(candidate => value === candidate.ClassName
      || value === `${candidate.Namespace || 'BoTech'}.${candidate.ClassName}`) || null;
  }

  function taskBaseChainContains(startTask, targetTaskId) {
    const visited = new Set();
    let candidate = startTask;
    while (candidate && !visited.has(candidate.TaskId)) {
      if (candidate.TaskId === targetTaskId) return true;
      visited.add(candidate.TaskId);
      candidate = projectTaskForBaseType(candidate.BaseType);
    }
    return false;
  }

  function saveTaskClassSetting(field, value) {
    const task = currentTask();
    if (!task) return false;
    const next = String(value || '').trim();
    if (field === 'BaseType' && next && !isValidTaskBaseType(next)) {
      setStatus('继承类型需要是有效的 C# 类型名，例如 TaskBase_MoverStation 或 Namespace.BaseTask。', 'error');
      renderTaskClassSettings(task);
      return false;
    }
    if (field === 'BaseType' && next) {
      const selfNames = new Set([task.ClassName, `${task.Namespace || 'BoTech'}.${task.ClassName}`]);
      if (selfNames.has(next)) {
        setStatus('Task 不能继承自身。', 'error');
        renderTaskClassSettings(task);
        return false;
      }
      const baseTask = projectTaskForBaseType(next);
      if (baseTask && ['sealed', 'static'].includes(baseTask.ClassModifier)) {
        setStatus(`不能继承 ${baseTask.ClassName}：该类是 ${baseTask.ClassModifier} 类。`, 'error');
        renderTaskClassSettings(task);
        return false;
      }
      if (baseTask && taskBaseChainContains(baseTask, task.TaskId)) {
        setStatus(`设置该继承关系会形成循环：${task.ClassName} 不能继承 ${baseTask.ClassName}。`, 'error');
        renderTaskClassSettings(task);
        return false;
      }
    }
    if (field === 'ClassModifier' && next === 'sealed') {
      const descendants = new Set([task.TaskId]);
      let added = true;
      while (added) {
        added = false;
        (state.workspace.Tasks || []).forEach(candidate => {
          const parent = projectTaskForBaseType(candidate.BaseType);
          if (parent && descendants.has(parent.TaskId) && !descendants.has(candidate.TaskId)) {
            descendants.add(candidate.TaskId);
            added = true;
          }
        });
      }
      const child = (state.workspace.Tasks || []).find(item => descendants.has(item.TaskId) && item.TaskId !== task.TaskId);
      if (child) {
        setStatus(`Task ${child.ClassName} 当前继承此类，不能将 ${task.ClassName} 设为 sealed。`, 'error');
        renderTaskClassSettings(task);
        return false;
      }
    }
    const normalized = field === 'AccessModifier' ? (next === 'internal' ? 'internal' : 'public')
      : field === 'ClassModifier' ? (['abstract', 'sealed'].includes(next) ? next : '') : next;
    if (task[field] === normalized) {
      renderTaskClassSettings(task);
      return true;
    }
    task[field] = normalized;
    renderTaskClassSettings(task);
    if (field === 'BaseType') { renderMethods(); updateWorkspaceHeader(); }
    persistProjectDraft();
    setStatus(`已更新 ${task.ClassName} 的 ${field === 'BaseType' ? '继承类型' : field === 'AccessModifier' ? '访问级别' : '类修饰符'}。`, 'normal');
    return true;
  }

  function resetEditorSelection() {
    state.invalidFields.clear();
    state.invalidDrafts.clear();
    state.selectedNodeId = null;
    state.layout = {};
    state.infoBindingKey = null;
    canvasEditor.reset();
    const flows = state.workspace && state.workspace.Flows || [];
    if (!flows.some(flow => flow.StationId === state.stationId))
      state.stationId = flows.length ? flows[0].StationId : '';
    updateWorkspaceHeader();
    renderAll();
  }

  // Task method catalog: categories, imported methods, templates, and hardware.
  function addTaskMethodCategory(task, name) {
    const normalized = String(name || '').trim();
    if (!task || !normalized || /[\r\n]|#(?:end)?region/i.test(normalized)) return false;
    if (!Array.isArray(task.MethodCategories)) task.MethodCategories = [];
    if (task.MethodCategories.some(item => String(typeof item === 'string' ? item : item && (item.Name || item.RegionName) || '').toLowerCase() === normalized.toLowerCase())) return false;
    const nextOrder = task.MethodCategories.reduce((maximum, item) => Math.max(maximum, Number(typeof item === 'string' ? 0 : item.Order) || 0), -1) + 1;
    task.MethodCategories.push({ Name: normalized, RegionName: normalized, Order: nextOrder });
    return true;
  }

  function syncTaskMethodCategories(task, additionalNames = []) {
    if (!task) return [];
    if (!Array.isArray(task.MethodCategories)) task.MethodCategories = [];
    const seen = new Set();
    task.MethodCategories = task.MethodCategories.filter(item => {
      const name = String(typeof item === 'string' ? item : item && (item.Name || item.RegionName) || '').trim();
      const key = name.toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).map((item, index) => {
      const category = typeof item === 'string' ? { Name: item, RegionName: item, Order: index } : item;
      category.Name = String(category.Name || category.RegionName || '').trim();
      category.RegionName = category.Name;
      if (category.Order == null || !Number.isFinite(Number(category.Order))) category.Order = index;
      return category;
    });
    if (!task.MethodCategories.length) task.MethodCategories.push({ Name: 'Common', RegionName: 'Common', Order: 0 });
    const methodNames = (state.workspace?.Methods || [])
      .filter(method => method.TaskId === task.TaskId)
      .map(method => method.Category);
    [...additionalNames, ...methodNames].forEach(name => addTaskMethodCategory(task, name));
    return task.MethodCategories;
  }

  function currentTaskMethodCategories(task = currentTask()) {
    return syncTaskMethodCategories(task).map((category, index) => ({ category, index }))
      .sort((left, right) => (Number(left.category.Order) || 0) - (Number(right.category.Order) || 0) || left.index - right.index)
      .map(item => item.category);
  }

  function refreshMethodCategorySelect(selectedName = '') {
    const select = $('#methodCategoryInput');
    const categories = currentTaskMethodCategories();
    const previous = selectedName || select.value;
    select.innerHTML = categories.length
      ? categories.map(category => `<option value="${esc(category.Name)}">${esc(category.Name)}</option>`).join('')
      : '<option value="" disabled selected>当前 Task 尚无 Region</option>';
    if (categories.some(category => category.Name === previous)) select.value = previous;
    else if (categories.length) select.value = categories[0].Name;
  }

  function normalizedMethodImportSource(method) {
    const source = String(method.SourceCode || window.EquipmentFlowTaskCodegen.methodSource(method) || '');
    const tokens = window.EquipmentFlowCSharpCatalog.tokenize(source);
    const parts = [];
    let previousEnd = 0;
    const appendComments = text => {
      const comments = text.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g) || [];
      comments.forEach(comment => parts.push(`comment:${JSON.stringify(comment.replace(/\s+/g, ' ').trim())}`));
    };
    tokens.forEach(token => {
      appendComments(source.slice(previousEnd, token.start));
      const value = ['string', 'char'].includes(token.kind) ? source.slice(token.start, token.end) : token.value;
      parts.push(`${token.kind}:${JSON.stringify(value)}`);
      previousEnd = token.end;
    });
    appendComments(source.slice(previousEnd));
    return parts.join('|');
  }

  function normalizedMethodImportUsings(method) {
    return JSON.stringify(Array.from(new Set((method.ImportedUsings || []).map(using =>
      window.EquipmentFlowCSharpCatalog.tokenize(String(using || '')).map(token =>
        `${token.kind}:${JSON.stringify(['string', 'char'].includes(token.kind) ? String(using).slice(token.start, token.end) : token.value)}`
      ).join('|')
    ))).sort());
  }

  function importedMethodDifferences(existing, incoming) {
    const differences = [];
    const normalizeText = value => String(value || '').replace(/\s+/g, ' ').trim();
    const parameterSignature = method => JSON.stringify([
      method.ReturnType || '', method.MethodName || '', (method.Parameters || []).map(parameter => [
        parameter.Direction || 'value', normalizeText(parameter.TypeName), Boolean(parameter.IsParams), normalizeText(parameter.DefaultValue),
      ]),
    ]);
    if (parameterSignature(existing) !== parameterSignature(incoming)) differences.push('函数签名');
    if (normalizedMethodImportSource(existing) !== normalizedMethodImportSource(incoming)) differences.push('函数代码');
    if (normalizeText(existing.DocumentationSummary) !== normalizeText(incoming.DocumentationSummary)) differences.push('方法注释');
    if (String(existing.Category || '').trim() !== String(incoming.Category || '').trim()) differences.push('Region');
    if (String(existing.DisplayName || '') !== String(incoming.DisplayName || '')) differences.push('显示名称');
    if (String(existing.MethodId || '') !== String(incoming.MethodId || '')) differences.push('方法 ID');
    if (Number(existing.SchemaVersion || 1) !== Number(incoming.SchemaVersion || 1)) differences.push('方法版本');
    const statusMetadata = method => JSON.stringify([
      method.ResultStatusCodes || [], method.PendingStatusCodes || [], method.AlarmStatusCodes || [],
    ]);
    if (statusMetadata(existing) !== statusMetadata(incoming)) differences.push('状态码配置');
    return differences;
  }

  async function importMethodLibrary(files) {
    const selected = Array.from(files || []);
    const task = currentTask();
    if (!task) throw new Error('请先新建 Task，再导入方法 .cs 文件。');
    if (!selected.length || selected.some(file => !String(file.name || '').toLowerCase().endsWith('.cs')))
      throw new Error('方法库只接受一个或多个 C# .cs 文件。');
    const parsedFiles = [];
    const parsedMethods = [];
    const parsedVariables = [];
    let ignoredVariableCount = 0;
    for (const file of selected) {
      const source = await file.text();
      const importedUsings = Array.from(source.matchAll(/^\s*using\s+(?:static\s+)?[\w.]+(?:\s*=\s*[\w.]+)?\s*;\s*$/gm), match => match[0].trim());
      const parsed = window.EquipmentFlowCSharpCatalog.parseSource(source, file.name);
      const regions = window.EquipmentFlowTaskTemplate.extractRegions(source, file.name);
      const variableTypeAliases = new Map([
        ['bool', 'bool'], ['system.boolean', 'bool'], ['int', 'int'], ['system.int32', 'int'],
        ['string', 'string'], ['system.string', 'string'], ['long', 'long'], ['system.int64', 'long'],
        ['float', 'float'], ['system.single', 'float'], ['double', 'double'], ['system.double', 'double'],
        ['decimal', 'decimal'], ['system.decimal', 'decimal'],
      ]);
      parsed.classes.filter(classType => classType.name === task.ClassName && (!classType.namespace || classType.namespace === task.Namespace))
        .flatMap(classType => classType.memberVariables || []).forEach(variable => {
          const type = variableTypeAliases.get(String(variable.TypeName || '').replace(/\s+/g, '').toLowerCase());
          if (!type) { ignoredVariableCount += 1; return; }
          const region = regions.filter(item => item.Line <= variable.Line && item.EndLine >= variable.Line)
            .sort((left, right) => right.Depth - left.Depth)[0];
          const initializer = String(variable.InitializerSource || '').trim();
          parsedVariables.push({
            VariableId: `imported_variable_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
            Name: variable.Name, Type: type, MemberKind: variable.MemberKind,
            AccessModifier: variable.AccessModifier || 'public', Modifiers: variable.Modifiers || [],
            HasInitialValue: Boolean(initializer), InitialValue: '', InitializerSource: initializer,
            RegionName: region?.Name || currentTaskMethodCategories(task)[0]?.Name || 'Common', ImportedFileName: file.name,
          });
        });
      const classes = parsed.classes.map(classType => ({
        ...classType,
        methods: classType.methods.map(sourceMethod => {
          const containingRegion = regions
            .filter(region => region.Line <= sourceMethod.Line && region.EndLine >= sourceMethod.Line)
            .sort((left, right) => right.Depth - left.Depth)[0];
          const hasDeclaredCategory = /\bFlowMethodCategory\s*\(/.test(sourceMethod.AttributeSource || '');
          const category = hasDeclaredCategory ? sourceMethod.Category : containingRegion?.Name || sourceMethod.Category || '导入方法';
          const method = {
            ...sourceMethod,
            TaskId: task.TaskId,
            MethodId: sourceMethod.MethodId || `${task.ClassName}.${sourceMethod.MethodName}(${(sourceMethod.Parameters || []).map(parameter => `${parameter.Direction}:${parameter.TypeName}`).join(',')})`,
            MachineName: '', StationId: '',
            DisplayName: sourceMethod.DisplayName || sourceMethod.MethodName,
            Category: category,
            SchemaVersion: Number(sourceMethod.SchemaVersion) || 1,
            CanBind: true,
            ContractIssue: '',
            ResultStatusCodes: sourceMethod.ResultStatusCodes || [],
            PendingStatusCodes: sourceMethod.PendingStatusCodes || [],
            AlarmStatusCodes: sourceMethod.AlarmStatusCodes || [],
            Outcomes: sourceMethod.ReturnType === 'bool' ? ['true', 'false'] : (sourceMethod.ResultStatusCodes || []).map(String),
            ImportedFileName: file.name,
            ImportedClassName: classType.name,
            ImportedClassNamespace: classType.namespace || '',
            ImportedClassKind: classType.kind || 'class',
            ImportedUsings: importedUsings,
            AttributeSource: sourceMethod.AttributeSource || '',
            PreserveSource: true,
            AccessModifier: sourceMethod.AccessModifier || 'private',
            Parameters: (sourceMethod.Parameters || []).map(parameter => ({ ...parameter })),
          };
          parsedMethods.push(method);
          return method;
        }),
      }));
      parsedFiles.push({ fileName: file.name, classes, regions, diagnostics: parsed.diagnostics || [] });
    }
    const taskMethods = state.workspace.Methods.filter(method => method.TaskId === task.TaskId);
    const existingById = new Map();
    const existingBySignature = new Map();
    taskMethods.forEach(method => {
      if (method.MethodId && !existingById.has(method.MethodId)) existingById.set(method.MethodId, method);
      const signature = csharpMethodSignatureKey(method);
      if (signature && !existingBySignature.has(signature)) existingBySignature.set(signature, method);
    });
    const plans = [];
    const plansByExisting = new Map();
    const plansById = new Map();
    const plansBySignature = new Map();
    let identicalMethodCount = 0;
    parsedMethods.forEach(incoming => {
      const signature = csharpMethodSignatureKey(incoming);
      let plan = (incoming.MethodId && plansById.get(incoming.MethodId)) || plansBySignature.get(signature);
      if (!plan) {
        const existingMethod = (incoming.MethodId && existingById.get(incoming.MethodId)) || existingBySignature.get(signature);
        if (existingMethod) plan = plansByExisting.get(existingMethod) || null;
      }
      if (!plan) {
        const existingMethod = (incoming.MethodId && existingById.get(incoming.MethodId)) || existingBySignature.get(signature);
        plan = {
          existing: existingMethod || null,
          preview: existingMethod ? { ...existingMethod } : { ...incoming },
          differences: new Set(), fileDifferences: new Set(), hasChanges: false, hasIncoming: false,
        };
        plans.push(plan);
        if (existingMethod) plansByExisting.set(existingMethod, plan);
      }
      if (!plan.existing && !plan.hasIncoming) {
        plan.preview = { ...incoming, TaskId: task.TaskId };
        plan.hasIncoming = true;
        plansById.set(incoming.MethodId, plan);
        plansBySignature.set(signature, plan);
        return;
      }
      const differences = importedMethodDifferences(plan.preview, incoming);
      const usingsChanged = normalizedMethodImportUsings(plan.preview) !== normalizedMethodImportUsings(incoming);
      if (!differences.length && !usingsChanged) {
        identicalMethodCount += 1;
        return;
      }
      plan.hasChanges = true;
      differences.forEach(difference => plan.differences.add(difference));
      if (usingsChanged) plan.fileDifferences.add('using 引用');
      plan.preview = {
        ...incoming,
        TaskId: task.TaskId,
        MethodId: incoming.MethodId || plan.preview.MethodId || '',
        SchemaVersion: Number(incoming.SchemaVersion) || Number(plan.preview.SchemaVersion) || 1,
      };
      if (plan.existing) {
        plansById.set(plan.existing.MethodId, plan);
        plansById.set(plan.preview.MethodId, plan);
      }
      plansById.set(incoming.MethodId, plan);
      plansBySignature.set(signature, plan);
      plansBySignature.set(csharpMethodSignatureKey(plan.preview), plan);
    });

    const updatedExistingMethods = new Set(plans.filter(plan => plan.existing).map(plan => plan.existing));
    const plannedMethodIds = new Map(taskMethods.filter(method => !updatedExistingMethods.has(method) && method.MethodId)
      .map(method => [method.MethodId, method]));
    const plannedSignatures = new Map(taskMethods.filter(method => !updatedExistingMethods.has(method))
      .map(method => [csharpMethodSignatureKey(method), method]));
    plans.forEach(plan => {
      const methodId = String(plan.preview.MethodId || '');
      const signature = csharpMethodSignatureKey(plan.preview);
      if (methodId && plannedMethodIds.has(methodId) && plannedMethodIds.get(methodId) !== plan.existing)
        throw new Error(`导入失败：方法 ${plan.preview.MethodName} 的方法 ID ${methodId} 已被其他方法使用。`);
      if (signature && plannedSignatures.has(signature) && plannedSignatures.get(signature) !== plan.existing)
        throw new Error(`导入失败：方法 ${plan.preview.MethodName} 与已有 C# 签名重复。`);
      if (methodId) plannedMethodIds.set(methodId, plan.existing || plan);
      if (signature) plannedSignatures.set(signature, plan.existing || plan);
    });

    const variablesByName = new Map((task.MethodVariables || []).map((variable, index) => [String(variable.Name || '').toLowerCase(), index]));
    const mergedVariables = (task.MethodVariables || []).slice();
    parsedVariables.forEach(variable => {
      const key = String(variable.Name || '').toLowerCase();
      const existingIndex = variablesByName.get(key);
      if (existingIndex == null) {
        variablesByName.set(key, mergedVariables.length);
        mergedVariables.push(variable);
      } else mergedVariables[existingIndex] = variable;
    });
    task.MethodVariables = mergedVariables;
    plans.filter(plan => plan.existing).forEach(plan => {
      const previousMethod = plan.existing;
      const previousId = previousMethod.MethodId;
      const nextMethod = plan.preview;
      if (previousId !== nextMethod.MethodId
        || Number(previousMethod.SchemaVersion || 1) !== Number(nextMethod.SchemaVersion || 1)
        || String(previousMethod.MachineName || '') !== String(nextMethod.MachineName || '')
        || String(previousMethod.StationId || '') !== String(nextMethod.StationId || '')) {
        state.workspace.Flows.filter(flow => flow.StationId === task.TaskId).forEach(flow => {
          (flow.Nodes || []).filter(node => node.MethodId === previousId).forEach(node => {
            node.MethodId = nextMethod.MethodId;
            node.MethodSchemaVersion = nextMethod.SchemaVersion;
            node.MethodMachineName = nextMethod.MachineName || '';
            node.MethodStationId = nextMethod.StationId || '';
          });
        });
      }
      Object.assign(previousMethod, nextMethod);
    });
    const addedMethods = plans.filter(plan => !plan.existing).map(plan => plan.preview);
    state.workspace.Methods.push(...addedMethods);
    syncTaskMethodCategories(task, [
      ...parsedFiles.flatMap(file => file.regions.filter(region => region.Depth === 0).map(region => region.Name)),
      ...parsedMethods.map(method => method.Category),
      ...parsedVariables.map(variable => variable.RegionName),
    ]);
    state.workspace.MethodFiles = [...(state.workspace.MethodFiles || []).filter(item => item.taskId !== task.TaskId),
      ...parsedFiles.map(file => ({ ...file, taskId: task.TaskId }))];
    updateWorkspaceHeader();
    renderAll();
    closeDiagnostics();
    const changedPlans = plans.filter(plan => plan.hasChanges);
    setStatus(`已导入 ${parsedFiles.length} 个 C# 文件：新增 ${addedMethods.length} 个方法，更新 ${changedPlans.filter(plan => plan.existing).length} 个，跳过 ${identicalMethodCount} 个相同方法；读取 ${parsedVariables.length} 个类成员变量${ignoredVariableCount ? `，${ignoredVariableCount} 个非支持类型变量未导入` : ''}。`,
      changedPlans.length || ignoredVariableCount ? 'warning' : 'normal', false);
    if (changedPlans.length) {
      appendDiagnosticMessage('以下方法与当前内容不同，已按导入文件更新：', 'warning');
      changedPlans.filter(plan => plan.differences.size).forEach(plan => appendDiagnosticMessage(
        `${plan.preview.MethodName || plan.preview.MethodId}：${Array.from(plan.differences).join('、')}`, 'warning'));
      const changedUsingFiles = new Set(changedPlans.filter(plan => plan.fileDifferences.size)
        .map(plan => plan.preview.ImportedFileName || '导入的 C# 文件'));
      changedUsingFiles.forEach(fileName => appendDiagnosticMessage(`${fileName}：using 引用`, 'warning'));
      window.clearTimeout(diagnosticsHideTimer);
      diagnosticsHideTimer = null;
    }
    persistProjectDraft();
  }

  async function importTaskTemplate(file) {
    const template = await window.EquipmentFlowTaskTemplate.parseFile(file);
    state.workspace.TaskTemplate = template;
    persistProjectDraft();
    $('#viewTaskTemplateButton').disabled = false;
    renderTaskTemplatePreview(template);
    openTaskTemplateDialog();
    const issueCount = template.Diagnostics.length + Number(template.ContainsLegacyRuntimeAdapters);
    setStatus(`已载入 Task 模板 ${template.Template.ClassName}：${template.Files.length} 个 partial 源文件、${template.Methods.length} 个方法${issueCount ? `；${issueCount} 项提示` : ''}`, issueCount ? 'warning' : 'normal');
  }

  function openTaskTemplateDialog() {
    const dialog = $('#taskTemplateDialog');
    if (dialog.open) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeTaskTemplateDialog() {
    const dialog = $('#taskTemplateDialog');
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  function renderTaskTemplatePreview(template) {
    const task = template.Template;
    const subtitle = [task.MachineName, task.StationId].filter(Boolean).join(' · ');
    $('#taskTemplateDialogTitle').textContent = `${task.DisplayName || task.ClassName} · 模板预览`;
    const baseLabel = task.BaseType ? ` : ${task.BaseType}` : '（无基类）';
    $('#taskTemplateDialogSubtitle').textContent = `${task.Namespace}.${task.ClassName}${baseLabel}${subtitle ? `　|　${subtitle}` : ''}`;
    const sourceCards = template.Files.map((file, index) => {
      const groupedMethods = new Map();
      file.Methods.forEach(method => {
        const category = method.Category || '未分类';
        if (!groupedMethods.has(category)) groupedMethods.set(category, []);
        groupedMethods.get(category).push(method);
      });
      const methods = file.Methods.length
        ? Array.from(groupedMethods.entries()).map(([category, items]) => `<div class="template-method-group"><h4>${esc(category)} <span>${items.length}</span></h4><ul class="template-method-list">${items.map(method => `<li><div><strong>${esc(method.MethodName)}</strong><small>${esc(method.Signature || method.MethodName)} · ${esc(method.AccessModifier)} · ${esc(method.Category)}</small></div><span>${esc(method.ReturnType)}</span></li>`).join('')}</ul></div>`).join('')
        : '<p class="template-empty-note">未解析到该 partial 中的 Task 类方法。</p>';
      const regions = file.Regions.length
        ? `<div class="template-region-list">${file.Regions.map(region => `<span class="template-region-chip" style="--region-depth:${region.Depth}">${esc(region.Name)}</span>`).join('')}</div>`
        : '<span class="template-muted">源码中没有 #region</span>';
      return `<details class="template-source-card" ${index === 0 ? 'open' : ''}><summary><span><strong>${esc(file.Path)}</strong><small>${esc(file.DisplayName || file.Role || '')} · ${esc(file.MethodCategory || '未分类')}</small></span><b>${file.Methods.length} 个方法</b></summary><div class="template-source-details"><div class="template-detail-label">代码区域</div>${regions}<div class="template-detail-label">方法与访问级别</div>${methods}</div></details>`;
    }).join('');
    const declaredRegions = template.RegionCatalog.map(region => `<li><span class="template-region-mark">#</span><span><strong>${esc(region.Name)}</strong><small>${esc(region.Purpose || region.Description || '')}</small></span></li>`).join('');
    const taskData = template.TaskData.length
      ? `<ul class="template-data-list">${template.TaskData.map(item => `<li><code>${esc(item.Type || '')}</code><strong>${esc(item.Name)}</strong><span>${esc(item.Access || 'private')} · ${esc(item.Region || 'Task 数据')}</span></li>`).join('')}</ul>`
      : '<p class="template-empty-note">清单未声明 Task 数据成员。</p>';
    const hardware = template.HardwareContext;
    const hardwareHtml = hardware
      ? `<dl class="template-hardware-facts"><div><dt>吸嘴集合</dt><dd><code>${esc(hardware.CollectionExpression || hardware.Collection || '未声明')}</code></dd></div><div><dt>对象类型</dt><dd>${esc(hardware.NozzleType || '未声明')}</dd></div><div><dt>数量来源</dt><dd>${esc(hardware.CountSource || '由现有机种硬件加载流程决定')}</dd></div></dl><p class="template-hardware-note">${esc(hardware.Note || '模板引用已加载的硬件对象，不替换机种硬件加载实现。')}</p>`
      : '<p class="template-empty-note">未声明硬件引用；请从 Task 源码确认已有硬件上下文。</p>';
    const categoryItems = template.MethodCategories.map(category => `<li><span class="template-category-swatch"></span><strong>${esc(category.Name)}</strong><code>${esc(category.RegionName || category.Name)}</code><small>${esc(category.Description || '')}</small></li>`).join('');
    const diagnostics = [
      ...template.Diagnostics.map(esc),
      ...(template.ContainsLegacyRuntimeAdapters ? [esc('模板源码含有旧版 EquipmentFlow 注册适配方法；导入只解析源码，不会在浏览器执行这些方法。')] : []),
      ...template.ImportNotes.map(esc),
    ];
    $('#taskTemplateDialogBody').innerHTML = `
      <div class="template-summary-grid">
        <article class="template-summary-card template-summary-primary"><span>Task 类</span><strong>${esc(task.ClassName)}</strong><small>${esc(task.Namespace)} · ${esc(task.BaseType || '无基类')}</small></article>
        <article class="template-summary-card"><span>partial 源文件</span><strong>${template.Files.length}</strong><small>主 Task + 工艺文件</small></article>
        <article class="template-summary-card"><span>方法</span><strong>${template.Methods.length}</strong><small>按源码文件分组</small></article>
        <article class="template-summary-card"><span>Task 数据成员</span><strong>${template.TaskData.length}</strong><small>${template.RegionCatalog.length} 个主代码区域</small></article>
      </div>
      <div class="template-preview-columns">
        <div class="template-preview-main">
          <section class="template-preview-section"><div class="template-section-heading"><div><span class="template-eyebrow">SOURCE SET</span><h3>Task partial 文件</h3></div><span>${template.Files.length} FILES</span></div><div class="template-source-list">${sourceCards}</div></section>
        </div>
        <aside class="template-preview-side">
          <section class="template-preview-section"><div class="template-section-heading"><div><span class="template-eyebrow">TASK STRUCTURE</span><h3>区域与数据</h3></div></div>${declaredRegions ? `<ul class="template-region-catalog">${declaredRegions}</ul>` : '<p class="template-empty-note">未声明区域目录。</p>'}${taskData}</section>
          <section class="template-preview-section"><div class="template-section-heading"><div><span class="template-eyebrow">MACHINE CONTEXT</span><h3>硬件上下文</h3></div></div>${hardwareHtml}</section>
          <section class="template-preview-section"><div class="template-section-heading"><div><span class="template-eyebrow">METHOD REGIONS</span><h3>方法分类</h3></div></div>${categoryItems ? `<ul class="template-category-list">${categoryItems}</ul>` : '<p class="template-empty-note">未定义方法分类。</p>'}</section>
          ${diagnostics.length ? `<section class="template-preview-section template-diagnostics"><div class="template-section-heading"><div><span class="template-eyebrow">IMPORT NOTES</span><h3>导入提示</h3></div></div><ul>${diagnostics.map(message => `<li>${message}</li>`).join('')}</ul></section>` : ''}
        </aside>
      </div>
      <footer class="template-preview-footer"><span>解析 Task 主 partial 与方法；创建后可继续编辑并导出两个 .cs 文件。</span><div><button id="acknowledgeTaskTemplateButton" class="button button-quiet" type="button">关闭</button><button id="importTaskTemplateIntoProjectButton" class="button button-primary" type="button">按模板创建 Task</button></div></footer>`;
    $('#acknowledgeTaskTemplateButton').addEventListener('click', closeTaskTemplateDialog);
    $('#importTaskTemplateIntoProjectButton').addEventListener('click', applyTaskTemplateToProject);
  }

  async function importHardwareLibrary(files) {
    const selected = Array.from(files || []);
    if (!state.workspace) initializeEditor();
    const catalog = await window.EquipmentFlowHardwareLibrary.parseFiles(selected, state.workspace.MachineName);
    const previousBindings = window.EquipmentFlowHardwareLibrary.createBindings(state.workspace.HardwareSlots || []);
    catalog.slots = applyHardwareBindings(catalog.slots, catalog.resources,
      [...previousBindings, ...(state.workspace.HardwareBindings || [])]);
    canvasEditor.reset();
    state.workspace.HardwareFiles = catalog.files;
    state.workspace.HardwareFactories = catalog.factories || [];
    state.workspace.HardwareCatalogResources = catalog.resources;
    state.workspace.HardwareSlots = catalog.slots;
    state.workspace.HardwareBindings = window.EquipmentFlowHardwareLibrary.createBindings(catalog.slots);
    renderAll();
    closeDiagnostics();
    persistProjectDraft();
    setStatus(`已解析 ${catalog.files.length} 个硬件 C# 文件：${catalog.resources.length} 个枚举资源、${catalog.slots.length} 个逻辑槽位`, 'normal');
  }

  function applyHardwareBindings(slots, resources, bindings) {
    const bySlot = new Map();
    (bindings || []).forEach(binding => {
      bySlot.set(binding.SlotKey || `${binding.SourceFile || ''}::${binding.SlotId}`, binding);
      if (binding.SlotId) bySlot.set(binding.SlotId, binding);
    });
    return (slots || []).map(slot => {
      const binding = bySlot.get(slot.SlotKey) || bySlot.get(`${slot.SourceFile || ''}::${slot.SlotId}`) || bySlot.get(slot.SlotId);
      if (!binding || binding.ResourceType !== slot.ResourceType) return { ...slot, BoundResourceId: '', BoundResourceKey: '' };
      const resource = (resources || []).find(item => (binding.ResourceKey && item.ResourceKey === binding.ResourceKey)
        || item.ResourceId === binding.ResourceId);
      return resource && window.EquipmentFlowHardwareLibrary.canBind(slot, resource)
        ? { ...slot, BoundResourceId: resource.ResourceId, BoundResourceKey: resource.ResourceKey }
        : { ...slot, BoundResourceId: '', BoundResourceKey: '' };
    });
  }

  function downloadBytes(bytes, fileName, mimeType) {
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }

  // Project persistence: local draft, file handles, and the JSON + Excel deliverables.
  function projectSnapshot() {
    const layouts = state.workspace.CanvasLayouts || {};
    return { format: 'BoTech.TaskEditorProject', schemaVersion: 1, activeTaskId: state.stationId, workspace: state.workspace, layouts };
  }

  function cacheProjectSnapshot(text) {
    try { localStorage.setItem('botech.task-editor.project', text); }
    catch (_) { /* Browser cache is optional; the selected project file is the durable save target. */ }
  }

  function persistProjectDraft(options = {}) {
    if (!state.workspace) return;
    if (!state.suppressProjectDirty) markProjectDirty(state.stationId, Boolean(options.allTasksDirty));
    try { localStorage.setItem('botech.task-editor.project', JSON.stringify(projectSnapshot())); }
    catch (_) { /* Large or unavailable browser storage is reported by explicit Save. */ }
  }

  function restoreTaskSaveStates() {
    try {
      const savedStates = JSON.parse(localStorage.getItem(TASK_SAVE_STATES_KEY) || '{}');
      state.taskSaveStates = savedStates && typeof savedStates === 'object' && !Array.isArray(savedStates) ? savedStates : {};
    } catch (_) { state.taskSaveStates = {}; }
    const taskIds = new Set((state.workspace?.Tasks || []).map(task => task.TaskId));
    Object.keys(state.taskSaveStates).forEach(taskId => { if (!taskIds.has(taskId)) delete state.taskSaveStates[taskId]; });
    taskIds.forEach(taskId => {
      if (typeof state.taskSaveStates[taskId] !== 'boolean') state.taskSaveStates[taskId] = !state.projectDirty;
    });
    persistTaskSaveStates();
  }

  function persistTaskSaveStates() {
    try { localStorage.setItem(TASK_SAVE_STATES_KEY, JSON.stringify(state.taskSaveStates)); }
    catch (_) { /* Save indicators remain available for this session if storage is unavailable. */ }
  }

  function isTaskSaved(taskId) {
    return Boolean(taskId && state.taskSaveStates[taskId] === true);
  }

  function updateTaskSaveIndicators() {
    const picker = $('#stationSelect');
    if (!picker) return;
    Array.from(picker.options).forEach(option => {
      if (!option.dataset.taskLabel) return;
      const saved = isTaskSaved(option.value);
      option.textContent = `${option.dataset.taskLabel} ${saved ? '🟢' : '🔴'}`;
      option.title = saved ? '此 Task 已保存' : '此 Task 有未保存的修改';
    });
  }

  function updateProjectSaveStatus() {
    const element = $('#projectSaveStatus');
    if (!element) return;
    const tasks = state.workspace?.Tasks || [];
    const allTasksSaved = tasks.length > 0 && tasks.every(task => isTaskSaved(task.TaskId));
    const dirty = state.projectDirty !== false || !allTasksSaved;
    element.dataset.state = dirty ? 'unsaved' : 'saved';
    element.classList.toggle('is-unsaved', dirty);
    element.classList.toggle('is-saved', !dirty);
    element.textContent = dirty ? '未保存' : '保存成功';
    element.title = dirty ? '至少一个 Task 或工程配置有未保存的修改' : `所有 ${tasks.length} 个 Task 均已保存${state.projectSavedLabel ? `：${state.projectSavedLabel}` : ''}`;
    updateTaskSaveIndicators();
  }

  function markProjectDirty(taskId = state.stationId, allTasksDirty = false) {
    state.projectDirty = true;
    const tasks = state.workspace?.Tasks || [];
    if (allTasksDirty) tasks.forEach(task => { state.taskSaveStates[task.TaskId] = false; });
    else if (taskId && tasks.some(task => task.TaskId === taskId)) state.taskSaveStates[taskId] = false;
    persistTaskSaveStates();
    try { localStorage.setItem(PROJECT_DIRTY_KEY, 'true'); } catch (_) { /* The visible status remains authoritative for this session. */ }
    updateProjectSaveStatus();
  }

  function markProjectSaved(label = '') {
    state.projectDirty = false;
    state.projectSavedLabel = String(label || '');
    (state.workspace?.Tasks || []).forEach(task => { state.taskSaveStates[task.TaskId] = true; });
    persistTaskSaveStates();
    try {
      localStorage.setItem(PROJECT_DIRTY_KEY, 'false');
      localStorage.setItem(PROJECT_SAVED_LABEL_KEY, state.projectSavedLabel);
    } catch (_) { /* The selected file handle still identifies the saved project. */ }
    updateProjectSaveStatus();
  }

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

  async function storeFileHandle(key, handle) {
    const database = await openHandleDatabase();
    if (!database) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, 'readwrite');
      transaction.objectStore(HANDLE_STORE).put(handle, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('无法保存文件路径关联。'));
      transaction.onabort = () => reject(transaction.error || new Error('文件路径关联保存已取消。'));
    });
    database.close();
  }

  async function loadFileHandle(key) {
    const database = await openHandleDatabase();
    if (!database) return null;
    const handle = await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, 'readonly');
      const request = transaction.objectStore(HANDLE_STORE).get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error('无法读取文件路径关联。'));
    });
    database.close();
    return handle;
  }

  async function removeStoredFileHandle(key) {
    const database = await openHandleDatabase();
    if (!database) return;
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(HANDLE_STORE, 'readwrite');
      transaction.objectStore(HANDLE_STORE).delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error('无法移除文件路径关联。'));
    });
    database.close();
  }

  async function restoreTaskOutputDirectories() {
    for (const task of state.workspace?.Tasks || []) {
      try {
        if (task.OutputDirectoryPath) {
          const name = task.OutputDirectoryPath.split(/[\\/]/).filter(Boolean).pop() || task.OutputDirectoryPath;
          state.taskOutputDirectories.set(task.TaskId, { native: true, path: task.OutputDirectoryPath, name });
          continue;
        }
        const handle = await loadFileHandle(`task-output:${task.TaskId}`);
        if (handle) state.taskOutputDirectories.set(task.TaskId, { native: false, legacyHandle: handle, name: handle.name });
      } catch (_) { /* The project remains usable if the browser clears handle storage. */ }
    }
    const sharedDirectory = projectTaskOutputDirectory();
    if (sharedDirectory) setProjectTaskOutputDirectory(sharedDirectory);
    updateWorkspaceHeader();
  }

  async function restoreProjectFileHandle() {
    try {
      state.projectFileHandle = await loadFileHandle('active-project');
      state.projectFilePath = localStorage.getItem(PROJECT_FILE_PATH_KEY) || '';
      state.projectFileDirectoryPath = state.projectFilePath ? state.projectFilePath.replace(/[\\/][^\\/]+$/, '') : '';
      if (!state.projectDirty && (state.projectFilePath || state.projectFileHandle))
        state.projectSavedLabel = state.projectFilePath || state.projectFileHandle.name;
      updateProjectSaveStatus();
    } catch (_) { state.projectFileHandle = null; state.projectFilePath = ''; state.projectFileDirectoryPath = ''; }
  }

  async function writeFileHandle(handle, content, mimeType) {
    const writable = await handle.createWritable();
    await writable.write(new Blob([content], { type: mimeType }));
    await writable.close();
  }

  async function requestWritePermission(handle) {
    if (!handle || typeof handle.queryPermission !== 'function') return true;
    let permission = await handle.queryPermission({ mode: 'readwrite' });
    if (permission !== 'granted') permission = await handle.requestPermission({ mode: 'readwrite' });
    return permission === 'granted';
  }

  function persistProjectFilePath(path) {
    state.projectFilePath = String(path || '');
    state.projectFileDirectoryPath = state.projectFilePath ? state.projectFilePath.replace(/[\\/][^\\/]+$/, '') : '';
    try {
      if (state.projectFilePath) localStorage.setItem(PROJECT_FILE_PATH_KEY, state.projectFilePath);
      else localStorage.removeItem(PROJECT_FILE_PATH_KEY);
    } catch (_) { /* The current session still retains the selected path. */ }
  }

  async function saveProjectAs() {
    if (!state.workspace || !(state.workspace.Tasks || []).length) return;
    try {
      if (!(state.workspace.EnumWorkbooks || []).length) throw new Error('请先在枚举管理中创建或导入 Excel，再保存完整项目。');
      const suggestedName = state.projectFilePath.split(/[\\/]/).pop()
        || `${safeFileName(currentTask()?.ClassName || 'TaskProject')}.TaskProject.json`;
      const native = window.EquipmentFlowNativeOutput;
      if (!native?.available)
        throw new Error('项目保存需要本机路径助手。请通过 WebEditorLocalServer.ps1 或 C# 内嵌界面启动后再保存。');
      // The browser directory picker must start before awaiting the native Save As dialog.
      setStatus('如出现文件夹选择框，请选择工程枚举 Excel 文件的保存文件夹。', 'normal');
      const excelDirectory = await window.EquipmentFlowEnumWorkbench.prepareExcelDirectoryForSave();
      setStatus('接下来请选择 Task 项目 JSON 文件的保存位置。', 'normal');
      const nativeTarget = await native.chooseProjectFile(suggestedName, state.projectFileDirectoryPath);
      if (!nativeTarget) {
        if (!state.projectFilePath) {
          setStatus('首次保存已取消。', 'normal');
        } else {
          setStatus('已取消项目另存为。', 'normal');
        }
        return;
      }
      const excel = await window.EquipmentFlowEnumWorkbench.saveProjectWorkbook(excelDirectory);
      const text = JSON.stringify(projectSnapshot(), null, 2);
      cacheProjectSnapshot(text);
      const written = await native.writeProjectFile(nativeTarget.path, text);
      const projectPath = written.path || nativeTarget.path;
      const directoryPath = nativeTarget.directoryPath || projectPath.replace(/[\\/][^\\/]+$/, '');
      state.projectFileHandle = null;
      persistProjectFilePath(projectPath);
      await removeStoredFileHandle('active-project').catch(() => {});
      markProjectSaved(`${projectPath} + ${excel.sheetCount} 个 Sheet Excel`);
      showResult({ Success: true, Diagnostics: [`项目流程与配置：${projectPath}`, `已保存 ${excel.sheetCount} 个独立 Sheet Excel：${excel.fileNames.join('、')}（${excel.directoryName}）`] }, true);
      showProjectSaveSuccess(projectPath, directoryPath, excel);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      const message = error.message || '项目暂存失败。';
      showResult({ Success: false, Message: message, Diagnostics: [message] }, false);
      setStatus(message, 'error');
      const successDialog = $('#projectSaveSuccessDialog');
      if (successDialog?.open) {
        const errorLabel = $('#projectSaveSuccessError');
        errorLabel.textContent = `更改保存位置失败：${message}`;
        errorLabel.classList.remove('hidden');
      }
    }
  }

  async function saveProject() {
    if (!state.workspace || !(state.workspace.Tasks || []).length) return;
    try {
      if (!state.projectFilePath) {
        setStatus('首次保存需要选择 Excel 文件夹和项目 JSON 文件位置。', 'normal');
        await saveProjectAs();
        return;
      }
      if (!(state.workspace.EnumWorkbooks || []).length) throw new Error('请先在枚举管理中创建或导入 Excel，再保存完整项目。');
      const native = window.EquipmentFlowNativeOutput;
      if (!native?.available)
        throw new Error('项目保存需要本机路径助手。请通过 WebEditorLocalServer.ps1 或 C# 内嵌界面启动后再保存。');
      const excelDirectory = await window.EquipmentFlowEnumWorkbench.prepareExcelDirectoryForSave();
      const excel = await window.EquipmentFlowEnumWorkbench.saveProjectWorkbook(excelDirectory);
      const text = JSON.stringify(projectSnapshot(), null, 2);
      cacheProjectSnapshot(text);
      const written = await native.writeProjectFile(state.projectFilePath, text);
      const projectPath = written.path || state.projectFilePath;
      const directoryPath = written.directoryPath || state.projectFileDirectoryPath;
      markProjectSaved(`${projectPath} + ${excel.sheetCount} 个 Sheet Excel`);
      showResult({ Success: true, Diagnostics: [`项目流程与配置：${projectPath}`, `已保存 ${excel.sheetCount} 个独立 Sheet Excel：${excel.fileNames.join('、')}（${excel.directoryName}）`] }, true);
      showProjectSaveSuccess(projectPath, directoryPath, excel);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      const message = error.message || '项目保存失败。';
      showResult({ Success: false, Message: message, Diagnostics: [message] }, false);
      setStatus(message, 'error');
    }
  }

  async function openProject(snapshot, fileHandle = null) {
    if (!snapshot || snapshot.format !== 'BoTech.TaskEditorProject' || !snapshot.workspace)
      throw new Error('项目文件格式不正确。');
    state.workspace = normalizeWorkspace(snapshot.workspace);
    state.taskSaveStates = Object.fromEntries((state.workspace.Tasks || []).map(task => [task.TaskId, Boolean(fileHandle)]));
    persistTaskSaveStates();
    state.projectFileHandle = fileHandle;
    persistProjectFilePath('');
    state.taskOutputDirectories.clear();
    if (fileHandle) await storeFileHandle('active-project', fileHandle).catch(() => {});
    else await removeStoredFileHandle('active-project').catch(() => {});
    state.workspace.CanvasLayouts = snapshot.layouts || state.workspace.CanvasLayouts || {};
    state.stationId = snapshot.activeTaskId || (state.workspace.Tasks[0] && state.workspace.Tasks[0].TaskId) || '';
    Object.entries(snapshot.layouts || {}).forEach(([taskId, layout]) => {
      const flow = state.workspace.Flows.find(item => item.StationId === taskId);
      if (!flow) return;
      try { localStorage.setItem(`botech.task.layout.${flow.StationId}.${flow.FlowId}`, JSON.stringify(layout || {})); }
      catch (_) { /* Layout remains available in the imported workspace while editing. */ }
    });
    state.selectedNodeId = null; state.layout = {};
    canvasEditor.reset(); renderAll(); updateWorkspaceHeader();
    state.suppressProjectDirty = true;
    persistProjectDraft();
    state.suppressProjectDirty = false;
    if (fileHandle) markProjectSaved(fileHandle.name);
    else markProjectDirty('', true);
    await restoreTaskOutputDirectories();
    setStatus(`已打开项目：${state.workspace.Tasks.length} 个 Task`, 'normal');
  }

  async function openProjectFromPicker() {
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          multiple: false,
          types: [{ description: 'Task 项目 JSON', accept: { 'application/json': ['.json'] } }],
        });
        const file = await handle.getFile();
        await openProject(JSON.parse(await file.text()), handle);
      } catch (error) {
        if (error && error.name !== 'AbortError') showResult({ Success: false, Message: error.message, Diagnostics: [error.message] }, false);
      }
      return;
    }
    $('#projectFile').click();
  }

  function generateTaskSources(task, flow, validateEnums = true) {
    const enumWorkbook = state.workspace.EnumWorkbooks?.[0];
    if (enumWorkbook && validateEnums) window.EquipmentFlowEnumWorkbench.makeCSharp(enumWorkbook);
    const methods = methodsForTask(task.TaskId);
    const hardware = state.workspace.HardwareDefinitions || [];
    const enumNamespace = enumWorkbook?.Namespace || 'ParName';
    const enumResources = enumBindingResources();
    if (taskUsesInheritedAutoRun(task, flow)) {
      const methodsSource = window.EquipmentFlowTaskCodegen.generateSingleSource('methods', task, null, methods);
      const hardwareSource = window.EquipmentFlowTaskCodegen.generateSingleSource('hardware', task, null, methods,
        hardware, enumNamespace, enumResources);
      return {
        taskFileName: `${task.ClassName}.cs`, taskSource: '', includeTaskSource: false,
        methodsFileName: methodsSource.fileName, methodsSource: methodsSource.source,
        hardwareFileName: hardwareSource.fileName, hardwareSource: hardwareSource.source,
        supportFiles: methodsSource.supportFiles || [],
      };
    }
    return window.EquipmentFlowTaskCodegen.generateSources(task, flow, methods,
      hardware, enumNamespace, enumResources);
  }

  function generateTaskSingleSource(task, flow, kind) {
    const enumWorkbook = state.workspace.EnumWorkbooks?.[0];
    if (kind === 'hardware' && enumWorkbook) window.EquipmentFlowEnumWorkbench.makeCSharp(enumWorkbook);
    return window.EquipmentFlowTaskCodegen.generateSingleSource(kind, task, flowForTaskGeneration(task, flow), methodsForTask(task.TaskId),
      state.workspace.HardwareDefinitions || [], enumWorkbook?.Namespace || 'ParName',
      kind === 'hardware' ? enumBindingResources() : null);
  }

  function projectTaskOutputDirectory() {
    const tasks = state.workspace?.Tasks || [];
    return state.taskOutputDirectories.get(state.stationId)
      || tasks.map(task => state.taskOutputDirectories.get(task.TaskId)).find(Boolean)
      || null;
  }

  // Every Task in the project writes its generated sources into one selected folder.
  function setProjectTaskOutputDirectory(directory) {
    if (!directory) return;
    for (const task of state.workspace?.Tasks || []) {
      state.taskOutputDirectories.set(task.TaskId, directory);
      task.OutputDirectoryPath = directory.native && directory.path ? directory.path : '';
      task.OutputDirectoryName = directory.name || directory.legacyHandle?.name || '';
    }
  }

  // Write directly into the selected folder; never create a TaskName subfolder.
  function taskOutputDirectoryLabel(task, selectedDirectory = state.taskOutputDirectories.get(task.TaskId)) {
    if (!selectedDirectory && task.OutputDirectoryPath) {
      const name = task.OutputDirectoryPath.split(/[\\/]/).filter(Boolean).pop() || task.OutputDirectoryPath;
      return name;
    }
    if (!selectedDirectory) return '未配置（生成 .cs 前请选择）';
    return selectedDirectory.name || selectedDirectory.legacyHandle?.name || '';
  }

  async function taskOutputDirectory(task) {
    const selectedDirectory = state.taskOutputDirectories.get(task.TaskId);
    if (!selectedDirectory)
      throw new Error('路径配置异常：缺少项目统一 C# 输出目录。请先在 Task 设置中选择一次生成目录。');
    if (!selectedDirectory.native || !selectedDirectory.path)
      throw new Error('旧项目保存的是浏览器目录权限，无法打开资源管理器。请点击“选择”重新选择项目统一输出目录后再生成。');
    if (!window.EquipmentFlowTaskCodegen.validIdentifier(task.ClassName))
      throw new Error('Task 类名「' + task.ClassName + '」不是有效的 C# 标识符。');
    return selectedDirectory;
  }

  function splitNativePath(path) {
    const value = String(path || '').replace(/\//g, '\\').replace(/\\+$/, '');
    const drive = value.match(/^([A-Za-z]:)(?:\\|$)/);
    if (drive) return { root: drive[1] + '\\', segments: value.slice(drive[0].length).split('\\').filter(Boolean) };
    if (value.startsWith('\\\\')) {
      const parts = value.slice(2).split('\\').filter(Boolean);
      if (parts.length < 2) return null;
      return { root: `\\\\${parts[0]}\\${parts[1]}`, segments: parts.slice(2) };
    }
    return null;
  }

  function joinNativePath(root, segments) {
    if (!segments.length) return root;
    return root.endsWith('\\') ? root + segments.join('\\') : root + '\\' + segments.join('\\');
  }

  function parentNativePath(path) {
    const parts = splitNativePath(path);
    if (!parts || !parts.segments.length) return null;
    return joinNativePath(parts.root, parts.segments.slice(0, -1));
  }

  // Keep shared generated support files beside the Task sources whenever they share an output folder.
  function commonTaskSupportDirectory(taskDirectories) {
    const paths = taskDirectories.map(directory => directory && directory.path);
    if (!paths.length || paths.some(path => !path)) return null;
    const parsed = paths.map(splitNativePath);
    if (parsed.some(parts => !parts) || parsed.some(parts => parts.root.toLowerCase() !== parsed[0].root.toLowerCase())) return null;
    let sharedCount = Math.min(...parsed.map(parts => parts.segments.length));
    for (let index = 0; index < sharedCount; index += 1) {
      if (parsed.some(parts => parts.segments[index].toLowerCase() !== parsed[0].segments[index].toLowerCase())) {
        sharedCount = index;
        break;
      }
    }
    // A drive or share root is too broad for a project support file.
    if (sharedCount < 1) return null;
    const path = joinNativePath(parsed[0].root, parsed[0].segments.slice(0, sharedCount));
    return { native: true, path, name: path.split('\\').filter(Boolean).pop() || path };
  }

  async function chooseTaskSupportDirectory(taskDirectories) {
    const sharedDirectory = commonTaskSupportDirectory(taskDirectories);
    if (sharedDirectory) return sharedDirectory;
    const firstParent = parentNativePath(taskDirectories[0]?.path) || taskDirectories[0]?.path || '';
    const selected = await window.EquipmentFlowNativeOutput.chooseDirectory(firstParent);
    return selected || null;
  }

  function supportFilePlans(task, directory, supportFiles) {
    return (supportFiles || []).map(file => ({
      kind: 'task-support', label: task ? `${task.ClassName} 共享特性` : '项目共享特性', task, directory,
      source: file.source, fileName: file.fileName,
      baseFileNames: [file.fileName], fileNames: [file.fileName],
    }));
  }
  // Validate the complete deliverable set before saving or generating any source files.
  function collectProjectValidationDiagnostics() {
    const diagnostics = [];
    const rawTasks = state.workspace?.Tasks || [];
    const rawFlows = state.workspace?.Flows || [];
    const tasks = rawTasks.filter((task, index) => {
      if (task && typeof task === 'object') return true;
      diagnostics.push(`Task #${index + 1} 数据格式无效。`);
      return false;
    });
    const flows = rawFlows.filter((flow, index) => {
      if (flow && typeof flow === 'object') return true;
      diagnostics.push(`流程 #${index + 1} 数据格式无效。`);
      return false;
    });
    const workbooks = state.workspace?.EnumWorkbooks || [];
    const add = (task, message) => diagnostics.push(task ? `${task.ClassName || task.Name}：${message}` : message);

    state.invalidFields.forEach(field => diagnostics.push(`无效输入：${field}`));
    if (!tasks.length) diagnostics.push('项目中没有 Task。');
    if (workbooks.length !== 1) diagnostics.push(`工程枚举表必须且只能有一个，当前为 ${workbooks.length} 个。`);
    else {
      try { window.EquipmentFlowEnumWorkbench.makeCSharp(workbooks[0]); }
      catch (error) { diagnostics.push(`工程枚举表：${error.message}`); }
    }

    const seenTaskIds = new Set();
    const seenClassNames = new Set();
    tasks.forEach(task => {
      const taskId = String(task.TaskId || '');
      const className = String(task.ClassName || '').toLowerCase();
      if (!taskId) add(task, '缺少 TaskId。');
      else if (seenTaskIds.has(taskId)) add(task, `TaskId ${taskId} 重复。`);
      seenTaskIds.add(taskId);
      if (!className) add(task, '缺少 Task 类名。');
      else if (seenClassNames.has(className)) add(task, `Task 类名 ${task.ClassName} 重复，生成文件会冲突。`);
      seenClassNames.add(className);

      inheritedMethodsForTask(task).filter(item => item.mustOverride).forEach(item => {
        add(task, item.local
          ? `同签名方法 ${item.method.MethodName} 必须声明 override，才能实现 ${item.owner.ClassName} 的 abstract 方法。`
          : `必须重写父类 ${item.owner.ClassName} 的 abstract 方法 ${item.method.Signature || item.method.MethodName}。`);
      });

      const taskFlows = flows.filter(flow => flow.StationId === task.TaskId);
      const inheritedAutoRun = taskInheritsAutoRun(task);
      if (taskFlows.length > 1 || (!inheritedAutoRun && taskFlows.length !== 1)) {
        add(task, inheritedAutoRun
          ? `最多关联一个 Task 专属流程，当前找到 ${taskFlows.length} 个。`
          : `必须关联一个 AutoRun 流程，当前找到 ${taskFlows.length} 个。`);
        return;
      }
      const flow = taskFlows[0] || null;
      const hasOwnFlow = flowHasExecutableNodes(flow);
      if (hasOwnFlow) validateTaskFlow(task, flow, diagnostics);
      const methodIds = new Set();
      const methodSignatures = new Map();
      methodsForTask(task.TaskId).forEach(method => {
        if (method.MethodId) {
          if (methodIds.has(method.MethodId)) add(task, `方法 ID ${method.MethodId} 在此 Task 中不唯一。`);
          methodIds.add(method.MethodId);
        }
        const signature = csharpMethodSignatureKey(method);
        const duplicate = methodSignatures.get(signature);
        if (duplicate) {
          const parameterTypes = (method.Parameters || []).map(parameter => parameter.TypeName).join(', ');
          add(task, `方法 ${method.MethodName}(${parameterTypes}) 与 ${duplicate} 的 C# 签名重复。`);
        }
        else methodSignatures.set(signature, method.MethodName);
      });
      try { generateTaskSources(task, flow, false); }
      catch (error) { add(task, `C# 生成检查失败：${error.message}`); }
    });

    flows.filter(flow => !tasks.some(task => task.TaskId === flow.StationId))
      .forEach(flow => diagnostics.push(`流程 ${flow.FlowId || flow.StationId} 没有关联 Task。`));
    return Array.from(new Set(diagnostics));
  }

  function csharpMethodSignatureKey(method) {
    const aliases = {
      'System.Boolean': 'bool', 'System.Byte': 'byte', 'System.SByte': 'sbyte',
      'System.Int16': 'short', 'System.UInt16': 'ushort', 'System.Int32': 'int', 'System.UInt32': 'uint',
      'System.Int64': 'long', 'System.UInt64': 'ulong', 'System.Single': 'float', 'System.Double': 'double',
      'System.Decimal': 'decimal', 'System.Char': 'char', 'System.String': 'string', 'System.Object': 'object',
    };
    const parameters = (method.Parameters || []).map(parameter => {
      const type = String(parameter.TypeName || 'object').replace(/\s+/g, '').replace(/^global::/, '');
      const canonicalType = aliases[type] || type;
      const direction = ['out', 'ref'].includes(parameter.Direction)
        ? 'ref'
        : parameter.Direction === 'in' ? 'in' : 'value';
      return `${direction}:${canonicalType}`;
    });
    return `${String(method.MethodName || '')}(${parameters.join(',')})`;
  }

  function validateTaskFlow(task, flow, diagnostics) {
    const add = message => diagnostics.push(`${task.ClassName || task.Name}：${message}`);
    const validNodeTypes = new Set(['Start', 'Action', 'Condition', 'Wait', 'Alarm', 'End']);
    const rawNodes = Array.isArray(flow.Nodes) ? flow.Nodes : [];
    const rawTransitions = Array.isArray(flow.Transitions) ? flow.Transitions : [];
    const nodes = rawNodes.filter((node, index) => {
      if (node && typeof node === 'object') return true;
      add(`第 ${index + 1} 个节点数据格式无效。`);
      return false;
    });
    const transitions = rawTransitions.filter((edge, index) => {
      if (edge && typeof edge === 'object') return true;
      add(`第 ${index + 1} 条连线数据格式无效。`);
      return false;
    });
    const nodesById = new Map();
    const outgoing = new Map();
    nodes.forEach(node => {
      const id = String(node.NodeId || '');
      if (typeof node.NodeId !== 'string' || !id) add('流程节点编号必须是非空文本。');
      else if (nodesById.has(id)) add(`节点编号 ${id} 重复。`);
      else nodesById.set(id, node);
      if (!validNodeTypes.has(node.NodeType)) add(`${id || '未命名节点'} 的节点类型无效。`);
      if (id && !outgoing.has(id)) outgoing.set(id, []);
    });

    const starts = nodes.filter(node => node.NodeType === 'Start');
    if (starts.length !== 1) add(`流程必须有一个开始节点，当前为 ${starts.length} 个。`);
    if (typeof flow.EntryNodeId !== 'string' || !flow.EntryNodeId)
      add('流程入口编号必须是非空文本。');
    const entry = typeof flow.EntryNodeId === 'string' ? nodesById.get(flow.EntryNodeId) : null;
    if (!entry || entry.NodeType !== 'Start') {
      const entryLabel = entry ? `${entry.NodeId}（${entry.NodeType}）` : String(flow.EntryNodeId || '未设置');
      const uniqueStartHint = starts.length === 1 ? `；当前开始节点为 ${starts[0].NodeId}` : '';
      add(`流程入口 ${entryLabel} 未指向有效的开始节点${uniqueStartHint}。`);
    }
    if (!nodes.some(node => node.NodeType === 'End')) add('流程中没有结束节点。');

    const edgeKeys = new Set();
    transitions.forEach((edge, index) => {
      if (typeof edge.FromNodeId !== 'string' || !edge.FromNodeId
        || typeof edge.ToNodeId !== 'string' || !edge.ToNodeId) {
        add(`第 ${index + 1} 条连线的节点编号必须是非空文本。`);
      }
      const from = typeof edge.FromNodeId === 'string' ? nodesById.get(edge.FromNodeId) : null;
      const to = typeof edge.ToNodeId === 'string' ? nodesById.get(edge.ToNodeId) : null;
      if (!from || !to) add(`第 ${index + 1} 条连线引用了不存在的节点。`);
      if (from?.NodeType === 'End') add(`第 ${index + 1} 条连线从结束节点发出。`);
      if (to?.NodeType === 'Start') add(`第 ${index + 1} 条连线指向开始节点。`);
      if (from && to && from.NodeId === to.NodeId && from.NodeType === 'Start') add('开始节点不能连接自身。');
      const edgeKey = `${edge.FromNodeId}:${String(edge.Outcome)}`;
      if (edgeKeys.has(edgeKey)) add(`${edge.FromNodeId} 的分支 ${edge.Outcome} 重复。`);
      edgeKeys.add(edgeKey);
      if (from && to) outgoing.get(String(from.NodeId))?.push(String(to.NodeId));
    });

    nodes.filter(node => node.NodeType !== 'End' && !outgoing.get(String(node.NodeId))?.length)
      .forEach(node => add(`${node.NodeId}（${node.DisplayName || '未命名节点'}）没有后续连线。`));
    if (entry && entry.NodeType === 'Start') {
      const reachable = new Set([String(entry.NodeId)]);
      const queue = [String(entry.NodeId)];
      while (queue.length) {
        const nodeId = queue.shift();
        (outgoing.get(nodeId) || []).forEach(nextId => {
          if (!reachable.has(nextId)) { reachable.add(nextId); queue.push(nextId); }
        });
      }
      nodes.filter(node => !reachable.has(String(node.NodeId)))
        .forEach(node => add(`${node.NodeId}（${node.DisplayName || '未命名节点'}）无法从流程入口到达。`));
      if (!nodes.some(node => node.NodeType === 'End' && reachable.has(String(node.NodeId)))) add('流程入口无法到达任何结束节点。');
    }

    nodes.forEach(node => {
      const nodeTransitions = transitions.filter(edge => edge.FromNodeId === node.NodeId);
      if (!node.MethodId) {
        if (['Action', 'Condition'].includes(node.NodeType)) add(`${node.NodeId}（${node.DisplayName || '未命名节点'}）没有绑定方法。`);
        if (nodeTransitions.length > 1) add(`${node.NodeId} 没有绑定方法，不能提供多个结果分支。`);
        return;
      }
      const method = methodFor(node, task.TaskId);
      if (!method) {
        add(`${node.NodeId} 绑定的方法在此 Task 中不存在或版本不匹配。`);
        return;
      }
      if (method.CanBind === false) add(`${node.NodeId} 绑定的方法不可调用：${method.ContractIssue || method.MethodName}。`);
      if (method.ReturnType === 'int' && !(method.ResultStatusCodes || []).length)
        add(`${method.MethodName} 返回 int，但没有配置状态码。`);
      if (method.ReturnType === 'int') {
        const pending = new Set((method.PendingStatusCodes || []).map(String));
        const allowed = new Set((method.ResultStatusCodes || []).map(String).filter(code => !pending.has(code)));
        if (pending.has('0')) {
          add(`${node.NodeId} 的状态 0 不能同时作为待处理状态和普通返回分支。`);
        } else {
          allowed.add('0');
        }
        const branchOutcomes = new Set(nodeTransitions.map(edge => String(edge.Outcome)));
        const hasFallback = branchOutcomes.has('*');
        nodeTransitions.forEach(edge => {
          const outcome = String(edge.Outcome);
          if (outcome === '*') return;
          if (outcome === '0' && pending.has('0')) return;
          if (!/^-?\d+$/.test(outcome)) add(`${node.NodeId} 的分支 ${outcome} 不是有效整数状态码。`);
          else if (!allowed.has(outcome)) add(`${node.NodeId} 的分支状态 ${outcome} 未在 ${method.MethodName} 中声明。`);
        });
        if (!hasFallback) {
          allowed.forEach(code => {
            if (!branchOutcomes.has(code)) add(`${node.NodeId} 缺少状态 ${code} 的分支；如需统一处理未列出的状态，可添加 * 默认分支。`);
          });
        }
      } else if (method.ReturnType === 'bool') {
        const branchOutcomes = new Set(nodeTransitions.map(edge => String(edge.Outcome).toLowerCase()));
        const hasFallback = branchOutcomes.has('*');
        nodeTransitions.filter(edge => !['true', 'false', '*'].includes(String(edge.Outcome).toLowerCase()))
          .forEach(edge => add(`${node.NodeId} 的布尔分支只能是 true 或 false。`));
        if (!hasFallback) ['true', 'false'].forEach(outcome => {
          if (!branchOutcomes.has(outcome)) add(`${node.NodeId} 缺少 ${outcome} 分支；如需统一处理，可添加 * 默认分支。`);
        });
      } else if (nodeTransitions.length > 1) {
        add(`${node.NodeId} 绑定的 ${method.ReturnType} 方法不支持多个结果分支。`);
      }

      (node.Parameters || []).filter(hasOutputParameterSource).forEach(binding => {
        const sourceNode = typeof binding.SourceNodeId === 'string' && binding.SourceNodeId
          ? nodesById.get(binding.SourceNodeId)
          : null;
        const sourceMethod = sourceNode && methodFor(sourceNode, task.TaskId);
        const sourceParameterName = binding.SourceParameterName || binding.Name;
        const output = sourceMethod && (sourceMethod.Parameters || []).find(parameter =>
          (parameter.Name === sourceParameterName || parameter.FlowName === sourceParameterName)
          && ['out', 'ref'].includes(parameter.Direction));
        if (!sourceNode || !sourceMethod || !output)
          add(`${node.NodeId}.${binding.Name} 引用了无效的 out/ref 数据来源。`);
        else if (String(output.TypeName) !== String(binding.TypeName))
          add(`${node.NodeId}.${binding.Name} 与来源参数类型不一致。`);
      });
    });
  }

  // Empty strings represent an unbound/manual value; numeric IDs such as 0 are malformed bindings and must be validated.
  function hasOutputParameterSource(binding) {
    const hasNodeId = binding.SourceNodeId !== '' && binding.SourceNodeId != null;
    const hasParameterName = binding.SourceParameterName !== '' && binding.SourceParameterName != null;
    return hasNodeId || hasParameterName;
  }

  // C# output planning groups Task partial files so conflicts are resolved as one package.
  function makeTaskSourcePlan(task, directory, sources) {
    const files = [
      ...(sources.includeTaskSource === false ? [] : [{ key: 'task', fileName: sources.taskFileName, source: sources.taskSource }]),
      { key: 'methods', fileName: sources.methodsFileName, source: sources.methodsSource },
      { key: 'hardware', fileName: sources.hardwareFileName, source: sources.hardwareSource },
    ];
    const fileNames = files.map(file => file.fileName);
    return {
      kind: 'task', label: task.ClassName, task, directory, files,
      baseSources: sources, sources, baseFileNames: fileNames, fileNames,
    };
  }

  function makeTaskSingleSourcePlan(task, directory, kind, generated) {
    const labels = { flow: '流程', methods: '方法库', hardware: '硬件库' };
    return {
      kind: 'task-file', label: task.ClassName + ' ' + labels[kind], task, directory,
      source: generated.source, fileName: generated.fileName,
      baseFileNames: [generated.fileName], fileNames: [generated.fileName],
    };
  }
  function makeEnumSourcePlan(directory, artifact) {
    return {
      kind: 'enum', label: '工程枚举', directory,
      baseSource: artifact.source, source: artifact.source,
      baseFileNames: [artifact.fileName], fileName: artifact.fileName, fileNames: [artifact.fileName],
    };
  }

  // Route the enum workspace through the same preflight conflict dialog as project-wide generation.
  async function generateEnumSource(artifact, directory) {
    if (!directory) throw new Error('请先设置 EnumName.cs 输出目录。');
    if (!directory.native && !(await requestWritePermission(directory))) throw new Error('没有获得 EnumName.cs 输出目录的写入权限。');
    const plan = makeEnumSourcePlan(directory, artifact);
    if (!(await resolveOutputPlanConflicts([plan]))) return false;
    await formatOutputPlans([plan]);
    await writeOutputPlan(plan);
    setStatus(`已在 ${directory.name} 生成 ${plan.fileName}。`, 'normal');
    showGeneratedOutputSuccess([plan]);
    return plan.fileName;
  }

  function outputPlanFiles(plan) {
    if (plan.kind === 'task') {
      return plan.files.map((file, index) => ({ fileName: plan.fileNames[index] || file.fileName, source: file.source }));
    }
    return [{ fileName: plan.fileName, source: plan.source }];
  }

  // Format every source sequentially through the native helper before any plan is written.
  async function formatOutputPlans(plans) {
    const formatter = window.EquipmentFlowNativeOutput;
    if (!formatter?.available || typeof formatter.formatCSharp !== 'function')
      throw new Error('C# 代码格式化助手不可用，请通过本机助手启动 WebEditor。');
    const formatSource = async (fileName, source) => {
      try { return await formatter.formatCSharp(source); }
      catch (error) { throw new Error(`${fileName} 格式化失败：${error.message || error}`); }
    };
    for (const plan of plans) {
      if (!plan.directory?.native || !plan.directory.path)
        throw new Error(`「${plan.label}」缺少本机输出路径，请重新选择 C# 输出目录。`);
      if (plan.kind === 'task') {
        for (let index = 0; index < plan.files.length; index += 1)
          plan.files[index].source = await formatSource(plan.fileNames[index], plan.files[index].source);
      } else {
        plan.source = await formatSource(plan.fileName, plan.source);
      }
    }
  }

  function showGeneratedOutputSuccess(plans, afterClose = null) {
    const dialog = $('#generatedFileSuccessDialog');
    const fileList = $('#generatedFileSuccessFiles');
    const folderList = $('#generatedFileSuccessFolders');
    const files = [];
    const folders = [];
    for (const plan of plans) {
      const path = String(plan.directory.path).replace(/[\\/]+$/, '');
      let folder = folders.find(item => item.path.toLowerCase() === path.toLowerCase());
      if (!folder) {
        folder = { path, name: plan.directory.name || path.split(/[\\/]/).pop() };
        folders.push(folder);
      }
      for (const file of outputPlanFiles(plan)) {
        const fullPath = `${path}\\${file.fileName}`;
        files.push(fullPath);
      }
    }
    $('#generatedFileSuccessSummary').textContent = `${files.length} 个 C# 文件已生成，涉及 ${folders.length} 个输出目录。`;
    fileList.replaceChildren();
    for (const path of files) {
      const item = document.createElement('div');
      item.className = 'generated-file-success-path';
      item.textContent = path;
      fileList.append(item);
    }
    folderList.replaceChildren();
    for (const folder of folders) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'button button-primary';
      button.dataset.openGeneratedOutputFolder = 'true';
      button.dataset.outputDirectoryPath = folder.path;
      button.textContent = folders.length === 1 ? '打开输出文件夹' : `打开：${folder.name}`;
      folderList.append(button);
    }
    $('#generatedFileSuccessError').textContent = '';
    $('#generatedFileSuccessError').classList.add('hidden');
    if (!dialog.dataset.outputCloseHandlerBound) {
      dialog.addEventListener('close', () => {
        const callback = dialog._afterGeneratedOutputClose;
        dialog._afterGeneratedOutputClose = null;
        if (callback) window.setTimeout(callback, 0);
      });
      dialog.dataset.outputCloseHandlerBound = 'true';
    }
    dialog._afterGeneratedOutputClose = afterClose;
    if (!dialog.open) dialog.showModal();
  }

  function addFileSuffix(fileName, suffix) {
    const dot = fileName.lastIndexOf('.');
    return dot > 0 ? `${fileName.slice(0, dot)}_${suffix}${fileName.slice(dot)}` : `${fileName}_${suffix}`;
  }

  function applyPlanSuffix(plan, suffix) {
    plan.fileNames = plan.baseFileNames.map(fileName => addFileSuffix(fileName, suffix));
    if (plan.kind !== 'task') {
      plan.fileName = plan.fileNames[0];
    }
  }

  async function assignAvailablePlanSuffix(plan, reservedNames, directory = null) {
    for (let suffix = 1; suffix < 10000; suffix++) {
      const candidateNames = plan.baseFileNames.map(fileName => addFileSuffix(fileName, suffix));
      if (candidateNames.some(fileName => reservedNames.has(fileName.toLowerCase()))) continue;
      if (directory) {
        let exists = false;
        for (const fileName of candidateNames) {
          if (await outputFileExists(directory, fileName)) { exists = true; break; }
        }
        if (exists) continue;
      }
      applyPlanSuffix(plan, suffix);
      plan.fileNames.forEach(fileName => reservedNames.add(fileName.toLowerCase()));
      return true;
    }
    return false;
  }

  async function outputDirectoryIsSame(left, right) {
    if (left === right) return true;
    if (left && right && left.native && right.native)
      return String(left.path).toLowerCase() === String(right.path).toLowerCase();
    if (left && typeof left.isSameEntry === 'function') {
      try { return await left.isSameEntry(right); } catch (_) { return false; }
    }
    return false;
  }

  async function outputFileExists(directory, fileName) {
    if (directory && directory.native)
      return window.EquipmentFlowNativeOutput.fileExists(directory.path, fileName);
    try { await directory.getFileHandle(fileName); return true; }
    catch (error) {
      if (error && error.name === 'NotFoundError') return false;
      throw error;
    }
  }

  async function chooseOutputConflictAction(conflictPlans, hasInternalConflict) {
    const dialog = $('#generatedFileConflictDialog');
    $('#generatedFileConflictSummary').textContent = conflictPlans.map(plan =>
      `${plan.directory.name}\\${plan.fileNames.join('、')}${plan.internalConflict ? '（与本次其他输出重名）' : '（文件已存在）'}`
    ).join('\n');
    $('#generatedFileConflictHint').textContent = hasInternalConflict
      ? '自动重命名会在文件名末尾添加 _1、_2…；同一 Task 的三个分部类会一起重命名。存在本次输出之间的重名时不可选择覆盖。'
      : '选择覆盖现有文件，或自动重命名为 _1、_2…；同一 Task 的三个分部类会一起重命名。';
    $('#overwriteGeneratedFilesButton').disabled = hasInternalConflict;
    dialog.returnValue = '';
    const result = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue || 'cancel'), { once: true }));
    dialog.showModal();
    const action = await result;
    $('#overwriteGeneratedFilesButton').disabled = false;
    return action;
  }

  async function resolveOutputPlanConflicts(plans) {
    const groups = [];
    for (const plan of plans) {
      let group = null;
      for (const candidate of groups) {
        if (await outputDirectoryIsSame(candidate.directory, plan.directory)) { group = candidate; break; }
      }
      if (!group) { group = { directory: plan.directory, plans: [] }; groups.push(group); }
      group.plans.push(plan);
      plan.internalConflict = false;
      plan.diskConflict = false;
    }

    const conflicts = [];
    let hasInternalConflict = false;
    for (const group of groups) {
      const reserved = new Set();
      for (const plan of group.plans) {
        plan.internalConflict = plan.fileNames.some(fileName => reserved.has(fileName.toLowerCase()));
        plan.diskConflict = false;
        for (const fileName of plan.fileNames) {
          if (await outputFileExists(group.directory, fileName)) plan.diskConflict = true;
          reserved.add(fileName.toLowerCase());
        }
        if (plan.internalConflict || plan.diskConflict) conflicts.push(plan);
        hasInternalConflict ||= plan.internalConflict;
      }
    }
    if (!conflicts.length) return true;
    const action = await chooseOutputConflictAction(conflicts, hasInternalConflict);
    if (action === 'cancel') return false;
    if (action === 'overwrite') return true;

    // Reserve the unchanged targets first, then assign the lowest available suffix to each conflict group.
    for (const group of groups) {
      const reserved = new Set(group.plans.filter(plan => !conflicts.includes(plan)).flatMap(plan => plan.fileNames.map(name => name.toLowerCase())));
      for (const plan of group.plans.filter(item => conflicts.includes(item))) {
        if (!(await assignAvailablePlanSuffix(plan, reserved, group.directory)))
          throw new Error(`无法为 ${plan.label} 找到可用的重命名文件名。`);
      }
    }
    return true;
  }

  async function writeOutputPlan(plan) {
    if (plan.kind === 'enum') {
      if (plan.directory && plan.directory.native) {
        await window.EquipmentFlowNativeOutput.writeText(plan.directory.path, plan.fileName, plan.source);
        return;
      }
      const handle = await plan.directory.getFileHandle(plan.fileName, { create: true });
      await writeFileHandle(handle, plan.source, 'text/plain;charset=utf-8');
      return;
    }
    if (plan.kind === 'task-file' || plan.kind === 'task-support') {
      if (plan.directory && plan.directory.native) {
        await window.EquipmentFlowNativeOutput.writeText(plan.directory.path, plan.fileName, plan.source);
        return;
      }
      // Use the resolved filename so automatic _1/_2 conflict renaming applies to this file.
      const handle = await plan.directory.getFileHandle(plan.fileName, { create: true });
      await writeFileHandle(handle, plan.source, 'text/plain;charset=utf-8');
      return;
    }
    const { directory } = plan;
    const files = outputPlanFiles(plan);
    if (directory && directory.native) {
      for (const file of files) await window.EquipmentFlowNativeOutput.writeText(directory.path, file.fileName, file.source);
      return;
    }
    for (const file of files) {
      const handle = await directory.getFileHandle(file.fileName, { create: true });
      await writeFileHandle(handle, file.source, 'text/plain;charset=utf-8');
    }
  }

  // Shared IO is informational: preserve bindings and list every component using the same resource.
  function collectSharedHardwareIo(tasks) {
    const taskIds = new Set(tasks.map(task => task.TaskId));
    const uses = new Map();
    const enumResources = new Map(enumBindingResources().map(resource => [resource.ResourceKey, resource]));
    const record = (task, definition, slot, owner) => {
      if (!['input', 'output'].includes(slot.Category) || (!slot.Binding?.MemberName && !slot.Binding?.ResourceKey)) return;
      const binding = slot.Binding;
      const currentResource = enumResources.get(binding.ResourceKey);
      const resource = `${currentResource?.EnumTypeName || binding.EnumTypeName || binding.ResourceType || 'IO'}.${currentResource?.MemberName || binding.MemberName}`;
      const channelValue = currentResource?.Value;
      const hasChannelValue = channelValue != null && String(channelValue).trim() !== '';
      const channel = hasChannelValue ? String(channelValue).trim() : (binding.ResourceKey || resource);
      const key = `${slot.Category}:${channel.toLowerCase()}`;
      const label = hasChannelValue ? `${slot.Category === 'input' ? '输入' : '输出'} IO ${channel}` : resource;
      if (!uses.has(key)) uses.set(key, { resource: label, owners: [] });
      uses.get(key).owners.push(`${task.ClassName} / ${definition.Name} / ${owner} / ${slot.DisplayName || slot.PropertyName}（${resource}）`);
    };
    (state.workspace.HardwareDefinitions || []).forEach(definition => {
      if (!taskIds.has(definition.TaskId)) return;
      const task = tasks.find(item => item.TaskId === definition.TaskId);
      if (definition.Type === 'Nozzle' && Array.isArray(definition.Nozzles) && definition.Nozzles.length) {
        definition.Nozzles.forEach((nozzle, index) => {
          const parts = nozzle.Parts || [];
          const slots = (nozzle.Slots || []).length ? nozzle.Slots : parts.flatMap(part => part.Slots || []);
          slots.forEach(slot => {
            const part = parts.find(item => (item.Slots || []).some(partSlot => partSlot.SlotId === slot.SlotId));
            const owner = `${nozzle.Name || '吸嘴' + (index + 1)}${part ? ' / ' + part.Name : ''}`;
            record(task, definition, slot, owner);
          });
        });
      } else {
        (definition.Slots || []).forEach(slot => record(task, definition, slot, definition.Type === 'Nozzle' ? '吸嘴1' : 'Task 独立组件'));
      }
    });
    return Array.from(uses.values()).filter(entry => entry.owners.length > 1);
  }

  function showSharedHardwareIoNotice(tasks) {
    const warnings = collectSharedHardwareIo(tasks);
    if (!warnings.length) return;
    const list = $('#hardware-shared-io-list');
    list.innerHTML = warnings.map(item =>
      `<article class="hardware-shared-io-row"><strong>${esc(item.resource)}</strong><small>${item.owners.map(esc).join('<br>')}</small></article>`
    ).join('');
    const dialog = $('#hardware-shared-io-dialog');
    if (!dialog.open) dialog.showModal();
  }

  // Generate one partial from its own panel without writing its two siblings.
  async function exportCurrentTaskSource(kind) {
    const task = currentTask();
    if (!task) return;
    try {
      const flow = currentFlow();
      if (kind === 'flow') {
        if (taskUsesInheritedAutoRun(task, flow)) {
          setStatus(`Task ${task.ClassName} 继承父类 AutoRun，无需生成 Task 主文件。`, 'normal');
          return;
        }
        if (!flow) throw new Error('当前 Task 缺少流程，无法生成流程.cs。');
        const diagnostics = [];
        validateTaskFlow(task, flow, diagnostics);
        if (diagnostics.length) {
          showResult({ Success: false, Diagnostics: diagnostics }, false);
          return;
        }
      }
      const generated = generateTaskSingleSource(task, flow, kind);
      const directory = await taskOutputDirectory(task);
      const plan = makeTaskSingleSourcePlan(task, directory, kind, generated);
      const plans = [plan];
      if ((generated.supportFiles || []).length) {
        const supportDirectory = await chooseTaskSupportDirectory([directory]);
        if (!supportDirectory) return;
        plans.push(...supportFilePlans(task, supportDirectory, generated.supportFiles));
      }
      if (!(await resolveOutputPlanConflicts(plans))) return;
      await formatOutputPlans(plans);
      for (const item of plans) await writeOutputPlan(item);
      setStatus('已生成 ' + plan.fileName + ' 到 ' + taskOutputDirectoryLabel(task), 'normal');
      showGeneratedOutputSuccess(plans, kind === 'hardware' ? () => showSharedHardwareIoNotice([task]) : null);
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      showResult({ Success: false, Message: error.message, Diagnostics: [error.message] }, false);
    }
  }

  // The File menu still exports the three current Task partials together.
  async function exportCurrentTaskSources() {
    const task = currentTask();
    const flow = currentFlow();
    if (!task || (!flow && !taskInheritsAutoRun(task))) return;
    try {
      const diagnostics = collectProjectValidationDiagnostics();
      if (diagnostics.length) {
        showResult({ Success: false, Diagnostics: diagnostics }, false);
        return;
      }
      const sources = generateTaskSources(task, flow);
      const directory = await taskOutputDirectory(task);
      const plan = makeTaskSourcePlan(task, directory, sources);
      const plans = [plan];
      if ((sources.supportFiles || []).length) {
        const supportDirectory = await chooseTaskSupportDirectory([directory]);
        if (!supportDirectory) return;
        plans.push(...supportFilePlans(task, supportDirectory, sources.supportFiles));
      }
      if (!(await resolveOutputPlanConflicts(plans))) return;
      await formatOutputPlans(plans);
      for (const item of plans) await writeOutputPlan(item);
      const generatedFileCount = plans.reduce((count, item) => count + outputPlanFiles(item).length, 0);
      setStatus(`已生成 ${generatedFileCount} 个 C# 文件到 ${taskOutputDirectoryLabel(task)}`, 'normal');
      showGeneratedOutputSuccess(plans, () => showSharedHardwareIoNotice([task]));
    } catch (error) {
      if (error && error.name === 'AbortError') return;
      showResult({ Success: false, Message: error.message, Diagnostics: [error.message] }, false);
    }
  }
  async function chooseTaskOutputDirectory() {
    const task = currentTask(); if (!task) return;
    const native = window.EquipmentFlowNativeOutput;
    if (!native?.available) { setStatus('选择项目统一 C# 输出目录需要通过本机助手启动 WebEditor。', 'error'); return; }
    try {
      const directory = await native.chooseDirectory(projectTaskOutputDirectory()?.path || '');
      if (!directory) return;
      directory.native = true;
      setProjectTaskOutputDirectory(directory);
      updateWorkspaceHeader(); persistProjectDraft();
      setStatus('项目中所有 Task 的 C# 文件将输出到 ' + taskOutputDirectoryLabel(task, directory), 'normal');
    } catch (error) { if (error.name !== 'AbortError') setStatus(`选择输出目录失败：${error.message}`, 'error'); }
  }

  // Export all Tasks and the shared enum source only after project-wide validation succeeds.
  async function exportAllTaskSources() {
    if (!state.workspace || !(state.workspace.Tasks || []).length) return;
    try {
      const tasks = state.workspace.Tasks || [];
      const sharedDirectory = projectTaskOutputDirectory();
      if (!sharedDirectory)
        throw new Error('路径配置异常：缺少项目统一 C# 输出目录。请先在 Task 设置中选择一次生成目录。');
      setProjectTaskOutputDirectory(sharedDirectory);
      let enumDirectory = await window.EquipmentFlowEnumWorkbench.getCSharpOutputDirectory({
        allowPrompt: false,
        checkPermission: false,
      });
      if (!enumDirectory && window.EquipmentFlowEnumWorkbench.getNativeCSharpOutputDirectory)
        enumDirectory = await window.EquipmentFlowEnumWorkbench.getNativeCSharpOutputDirectory({ allowPrompt: false });
      if (!enumDirectory) throw new Error('路径配置异常：缺少 EnumName.cs 的 C# 输出目录。请先在枚举管理中选择输出目录。');
      const diagnostics = collectProjectValidationDiagnostics();
      if (diagnostics.length) {
        showResult({ Success: false, Diagnostics: diagnostics }, false);
        return;
      }
      const enumArtifact = window.EquipmentFlowEnumWorkbench.getCSharpArtifact();
      const plans = [];
      const taskDirectories = [];
      for (const task of tasks) {
        const flow = state.workspace.Flows.find(item => item.StationId === task.TaskId);
        const sources = generateTaskSources(task, flow, false);
        const directory = await taskOutputDirectory(task);
        taskDirectories.push(directory);
        plans.push(makeTaskSourcePlan(task, directory, sources));
      }
      const supportFiles = plans.flatMap(plan => plan.sources.supportFiles || []);
      if (supportFiles.length) {
        const supportDirectory = await chooseTaskSupportDirectory(taskDirectories);
        if (!supportDirectory) return;
        // The attribute type is project-wide. Write its single definition once, even when several Tasks use it.
        plans.push(...supportFilePlans(tasks[0], supportDirectory, [supportFiles[0]]));
      }
      const enumPlan = makeEnumSourcePlan(enumDirectory, enumArtifact);
      if (!(await requestWritePermission(enumDirectory))) throw new Error('没有获得 EnumName.cs 输出目录的写入权限。');
      // Native paths and browser directory handles cannot be compared for identity.
      // Reject the only filename collision when their visible folder names also match.
      if (enumDirectory.native && plans.some(plan => plan.fileNames.some(name =>
        name.toLowerCase() === enumPlan.fileName.toLowerCase())
        && String(plan.directory.name || '').toLowerCase() === String(enumDirectory.name || '').toLowerCase()))
        throw new Error('Task 与枚举输出可能指向同一目录且文件名相同。请为 EnumName.cs 选择独立输出目录。');
      plans.push(enumPlan);
      if (plans.length && !(await resolveOutputPlanConflicts(plans))) return;
      await formatOutputPlans(plans);
      for (const plan of plans) await writeOutputPlan(plan);
      const totalFiles = plans.reduce((count, plan) => count + outputPlanFiles(plan).length, 0);
      setStatus(`已校验并生成 ${totalFiles} 个 C# 文件到设置目录。`, 'normal');
      showGeneratedOutputSuccess(plans, () => showSharedHardwareIoNotice(tasks));
    } catch (error) {
      if (error.name !== 'AbortError')
        showResult({ Success: false, Message: error.message, Diagnostics: [error.message] }, false);
    }
  }

  // View rendering: Task list, method tree, flow canvas, and hardware catalog.
  function renderAll() {
    renderStations();
    renderMethods();
    renderFlow();
    renderHardware();
    updateInspectorTab();
  }

  function renderStations() {
    const list = $('#stationList');
    list.innerHTML = '';
    const tasks = state.workspace ? state.workspace.Tasks || [] : [];
    const picker = $('#stationSelect');
    picker.innerHTML = tasks.length ? tasks.map(task => `<option value="${esc(task.TaskId)}" data-task-label="${esc(task.Name || task.ClassName)}"></option>`).join('')
      : '<option value="">新建 Task</option>';
    updateTaskSaveIndicators();
    picker.value = state.stationId || '';
    tasks.forEach((task, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `station-item${task.TaskId === state.stationId ? ' active' : ''}`;
      button.innerHTML = `<span class="station-index">${String(index + 1).padStart(2, '0')}</span>
        <span class="station-copy"><span class="station-name">${esc(task.Name || task.ClassName)}</span><span class="station-id">${esc(task.ClassName)}.cs + Methods</span></span>
        <span class="station-state"></span>`;
      button.addEventListener('click', () => {
        switchStation(task.TaskId);
        setStatus(`已切换到 Task ${task.ClassName}`, 'normal');
      });
      list.appendChild(button);
    });
    if (!tasks.length) list.innerHTML = '<div class="empty-inline">新建 Task 或导入 Task 模板</div>';
  }

  function methodModifierSet(method) {
    const modifiers = new Set([...(method?.Modifiers || []), ...String(method?.MethodModifier || '').split(/\s+/).filter(Boolean)]);
    if (method?.SourceCode) {
      try { (parseMethodCodeEditor(method.SourceCode).Modifiers || []).forEach(modifier => modifiers.add(modifier)); }
      catch (_) { /* Keep metadata already parsed from the source. */ }
    }
    return modifiers;
  }

  function matchesCSharpTypeName(requestedName, candidate) {
    const requested = String(requestedName || '').trim().replace(/^global::/, '').replace(/\s+/g, '');
    const fullName = String(candidate?.fullName || candidate?.FullName || '').trim().replace(/^global::/, '').replace(/\s+/g, '');
    const className = String(candidate?.ClassName || candidate?.name || candidate?.Class || '').trim();
    if (!requested || !className) return false;
    return requested === className || requested === fullName;
  }

  function sourceClassDefinitionsForType(typeName) {
    const result = [];
    const seen = new Set();
    const projectTask = projectTaskForBaseType(typeName);
    const add = type => {
      if (!type || type.kind !== 'class' || !matchesCSharpTypeName(typeName, type)) return;
      const identity = String(type.fullName || `${type.namespace || ''}.${type.name || type.ClassName}`);
      if (seen.has(identity)) return;
      seen.add(identity); result.push(type);
    };
    (state.workspace?.MethodFiles || []).forEach(file => (file.classes || []).forEach(add));
    (state.workspace?.Tasks || []).filter(candidate => !projectTask || candidate.TaskId === projectTask.TaskId).forEach(candidate => {
      const sources = [candidate.PrimarySource, ...(candidate.TemplateFiles || []).map(file => file.Source)];
      sources.filter(source => typeof source === 'string' && source.trim()).forEach(source => {
        try {
          const fileName = `${candidate.ClassName}.cs`;
          const parsed = window.EquipmentFlowCSharpCatalog.parseSource(source, fileName);
          const regions = window.EquipmentFlowTaskTemplate.extractRegions(source, fileName);
          parsed.classes.forEach(type => {
            (type.methods || []).forEach(method => {
              const region = regions.filter(item => item.Line <= method.Line && item.EndLine >= method.Line)
                .sort((left, right) => right.Depth - left.Depth)[0];
              const explicitCategory = /\bFlowMethodCategory\s*\(|\bFlowMethod\s*\([\s\S]*?\bCategory\s*=/.test(method.AttributeSource || '');
              if (region && !explicitCategory) method.Category = region.Name;
            });
            add(type);
          });
        }
        catch (_) { /* An incomplete imported source must not block the other Task/base definitions. */ }
      });
    });
    return result;
  }

  function baseTypeDefinition(typeName) {
    const task = projectTaskForBaseType(typeName);
    const sourceTypes = sourceClassDefinitionsForType(typeName);
    const type = sourceTypes[0] || null;
    const className = task?.ClassName || type?.name || String(typeName || '').split('.').pop();
    const namespace = task?.Namespace || type?.namespace || '';
    const methods = [];
    if (task) methods.push(...(state.workspace?.Methods || []).filter(method => taskOwnsMethod(method, task.TaskId)));
    (state.workspace?.Methods || []).filter(method => matchesCSharpTypeName(typeName, {
      name: method.ImportedClassName,
      fullName: [method.ImportedClassNamespace, method.ImportedClassName].filter(Boolean).join('.'),
    })).forEach(method => methods.push(method));
    sourceTypes.forEach(sourceType => methods.push(...(sourceType.methods || [])));
    const uniqueMethods = new Map();
    methods.forEach(method => {
      const signature = csharpMethodSignatureKey(method);
      if (!uniqueMethods.has(signature)) uniqueMethods.set(signature, method);
    });
    const taskBaseType = String(task?.BaseType || '').trim();
    const taskBaseIsSelf = task && matchesCSharpTypeName(taskBaseType, {
      name: task.ClassName,
      fullName: [task.Namespace, task.ClassName].filter(Boolean).join('.'),
    });
    return {
      task,
      owner: task || { TaskId: '', ClassName: className, Namespace: namespace },
      BaseType: taskBaseType && !taskBaseIsSelf ? taskBaseType : type?.BaseType || taskBaseType,
      methods: Array.from(uniqueMethods.values()),
    };
  }

  function inheritedMethodsForTask(task) {
    if (!task?.BaseType || !state.workspace) return [];
    const visibleBySignature = new Map();
    const visited = new Set();
    let baseType = task.BaseType;
    while (baseType) {
      const definition = baseTypeDefinition(baseType);
      const ownerKey = definition.task?.TaskId || `${definition.owner.Namespace || ''}.${definition.owner.ClassName}`;
      if (!definition.owner.ClassName || visited.has(ownerKey)) break;
      visited.add(ownerKey);
      definition.methods.forEach(method => {
        const signature = csharpMethodSignatureKey(method);
        if (!visibleBySignature.has(signature)) visibleBySignature.set(signature, { method, owner: definition.owner });
      });
      baseType = definition.BaseType;
    }
    const ownMethods = (state.workspace.Methods || []).filter(method => taskOwnsMethod(method, task.TaskId));
    const inherited = Array.from(visibleBySignature.values()).flatMap(({ method, owner }) => {
      const modifiers = methodModifierSet(method);
      if (modifiers.has('static') || modifiers.has('sealed') || method.AccessModifier === 'private') return [];
      if (!['abstract', 'virtual', 'override'].some(modifier => modifiers.has(modifier))) return [];
      const signature = csharpMethodSignatureKey(method);
      const local = ownMethods.find(item => csharpMethodSignatureKey(item) === signature);
      const localIsOverride = Boolean(local && methodModifierSet(local).has('override'));
      const isAbstract = modifiers.has('abstract');
      return [{ method, owner, local, signature,
        localIsOverride,
        mustOverride: isAbstract && task.ClassModifier !== 'abstract' && !localIsOverride,
        canDeferOverride: isAbstract && task.ClassModifier === 'abstract' && !localIsOverride,
      }];
    });
    const inheritedSignatures = new Set(inherited.map(item => item.signature));
    const declaredOverrides = ownMethods.filter(method => methodModifierSet(method).has('override')
      && !inheritedSignatures.has(csharpMethodSignatureKey(method)));
    declaredOverrides.forEach(method => {
      const signature = csharpMethodSignatureKey(method);
      inherited.push({ method, local: method, localIsOverride: true, signature,
        owner: { ClassName: String(task.BaseType || '').split('.').pop(), Namespace: '' },
        mustOverride: false, canDeferOverride: false, sourceUnresolved: true });
    });
    return inherited;
  }

  function addInheritedMethodOverride(item) {
    const task = currentTask();
    if (!task || !item?.method || !item.owner) return;
    if (item.local) { openMethodDialog(item.local); return; }
    const duplicate = (state.workspace.Methods || []).find(method => taskOwnsMethod(method, task.TaskId)
      && csharpMethodSignatureKey(method) === item.signature);
    if (duplicate) { openMethodDialog(duplicate); return; }
    const inherited = item.method;
    const parameters = (inherited.Parameters || []).map(parameter => ({ ...parameter }));
    const sourceModifiers = methodModifierSet(inherited);
    const isAbstract = sourceModifiers.has('abstract');
    const args = parameters.map(parameter => `${['in', 'ref', 'out'].includes(parameter.Direction) ? `${parameter.Direction} ` : ''}${parameter.Name}`);
    const baseCall = `base.${inherited.MethodName}(${args.join(', ')})`;
    const bodyText = isAbstract
      ? `throw new global::System.NotImplementedException(${JSON.stringify(`请实现 ${inherited.MethodName}`)});`
      : inherited.ReturnType === 'void' ? `${baseCall};` : `return ${baseCall};`;
    let methodId = inherited.MethodId || `${task.ClassName}.${item.signature}`;
    if ((state.workspace.Methods || []).some(method => taskOwnsMethod(method, task.TaskId) && method.MethodId === methodId))
      methodId = `${task.ClassName}.${item.signature}.override`;
    const method = rewriteCopiedMethodMetadata(cloneTaskJson(inherited), item.owner.TaskId, task.TaskId, methodId);
    Object.assign(method, {
      TaskId: task.TaskId,
      MethodModifier: 'override',
      Modifiers: ['override'],
      Parameters: parameters,
      ParameterModelVersion: 2,
      BodyText: bodyText,
      PreserveSource: false,
      ImportedFileName: `${task.ClassName}_Methods.cs`,
      ImportedClassName: task.ClassName,
      ImportedClassNamespace: task.Namespace,
    });
    method.SourceCode = window.EquipmentFlowTaskCodegen.methodSource(method);
    method.PreserveSource = true;
    method.AttributeSource = method.AttributeSource || '';
    method.CanBind = Boolean(inherited.CanBind && method.MethodId);
    if (!method.CanBind) method.ContractIssue = inherited.ContractIssue || '该继承方法没有可用于流程绑定的元数据。';
    method.Category = method.Category || currentTaskMethodCategories(task)[0]?.Name || 'Common';
    state.workspace.Methods.push(method);
    addTaskMethodCategory(task, method.Category);
    renderAll(); updateWorkspaceHeader(); persistProjectDraft();
    setStatus(`已在 ${task.ClassName}_Methods.cs 生成 ${method.MethodModifier} ${method.MethodName}。`, 'normal');
    openMethodDialog(method);
  }

  function restoreMethodLibrarySectionState(section, storageKey) {
    try { section.open = localStorage.getItem(storageKey) !== 'false'; }
    catch (_) { section.open = true; }
    section.addEventListener('toggle', () => {
      try { localStorage.setItem(storageKey, String(section.open)); }
      catch (_) { /* Collapsed state is a convenience and may be unavailable in private browsing. */ }
    });
  }

  function renderInheritedMethods(list, items, options = {}) {
    const section = document.createElement('details');
    section.className = 'inherited-method-library method-library-section';
    const storageKey = `botech.task-editor.inherited-methods-open.${options.taskId || currentTask()?.TaskId || ''}`;
    restoreMethodLibrarySectionState(section, storageKey);
    section.innerHTML = `<summary class="inherited-method-heading method-library-section-toggle"><strong>父类继承</strong><span>${items.length} 个</span></summary>`;
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'inherited-method-empty';
      empty.textContent = options.hasActiveFilters
        ? '没有符合当前搜索、修饰符或 Region 筛选条件的父类方法'
        : options.hasCandidates
          ? '当前父类没有 abstract/virtual/override 方法'
          : `没有读取到 ${options.baseType || '父类'} 的可重写方法定义；请确认其 Task 或 C# 源码已导入项目`;
      section.appendChild(empty);
      list.appendChild(section);
      return;
    }
    items.forEach(item => {
      const method = item.local || item.method;
      const card = document.createElement('article');
      card.className = 'inherited-method-card';
      const badge = item.localIsOverride ? '已重写' : item.local ? '同签名未重写' : item.mustOverride ? '必须重写' : item.canDeferOverride ? '可延后重写' : '可重写';
      const badgeClass = item.local && !item.localIsOverride ? 'conflict' : item.mustOverride ? 'required' : 'optional';
      const modifiers = [...methodModifierSet(method)].join(' ') || '无修饰符';
      const returnType = method.ReturnType || 'void';
      const outputs = (method.Parameters || []).filter(parameter => ['out', 'ref'].includes(parameter.Direction));
      const outcomes = returnType === 'bool' ? 'true / false'
        : returnType === 'int' ? (method.ResultStatusCodes || []).join(' / ') || '状态码未配置'
          : '顺序执行';
      card.innerHTML = `<div class="inherited-method-card-heading"><strong>${esc(method.MethodName || method.MethodId)}</strong><span class="inherited-method-state inherited-method-state-${badgeClass}">${esc(badge)}</span></div>
        <span class="method-tags">
          <span class="method-tag">${esc(method.AccessModifier || 'private')}</span>
          <span class="method-return-shape ${returnType === 'bool' ? 'return-bool' : returnType === 'int' ? 'return-int' : 'return-void'}">${esc(returnType)}</span>
          <span class="method-tag">${esc(modifiers)}</span>
          <span class="method-tag method-tag-category">${esc(method.Category || '未分类')}</span>
        </span>
        <small>${esc(item.owner.ClassName)} · ${esc(method.Signature || method.MethodName)}</small>
        ${method.DocumentationSummary ? `<p>${esc(method.DocumentationSummary)}</p>` : ''}
        <small>${esc(outcomes)}</small>
        ${outputs.length ? `<small>out ${esc(outputs.map(parameter => `${parameter.Name}: ${parameter.TypeName}`).join(' · '))}</small>` : ''}`;
      if (item.local && item.localIsOverride && item.local.CanBind !== false) {
        card.draggable = true;
        card.title = '此方法已满足父类 override 契约；拖到画布可创建流程节点。';
        card.addEventListener('dragstart', event => {
          event.dataTransfer.effectAllowed = 'copy';
          event.dataTransfer.setData('application/x-equipment-flow-method', JSON.stringify({
            MethodId: item.local.MethodId, SchemaVersion: item.local.SchemaVersion, TaskId: item.local.TaskId,
          }));
        });
      }
      const action = document.createElement('button');
      action.type = 'button'; action.className = 'catalog-action';
      action.textContent = item.local ? (item.localIsOverride ? '编辑 override' : '编辑同名方法') : '编辑 override';
      if (!item.local) action.title = '尚未重写时会先生成当前 Task 的 override，再打开编辑器';
      action.addEventListener('click', () => addInheritedMethodOverride(item));
      card.appendChild(action); section.appendChild(card);
    });
    list.appendChild(section);
  }

  function renderTaskVariableSummary(task = currentTask()) {
    const host = $('#taskVariableSummary');
    if (!host) return;
    if (!task) {
      host.classList.add('hidden');
      host.innerHTML = '';
      return;
    }
    const variables = Array.isArray(task.MethodVariables) ? task.MethodVariables : [];
    const fallbackRegion = currentTaskMethodCategories(task)[0]?.Name || 'Common';
    host.classList.remove('hidden');
    host.innerHTML = `<div class="task-variable-summary-heading"><strong>Task 变量</strong><span>${variables.length} 项</span></div>
      ${variables.length ? `<div class="task-variable-summary-list">${variables.map(variable => `<button type="button" class="task-variable-summary-item" data-open-task-variables title="编辑 Task 变量定义">
        <strong>${esc(variable.Name || '未命名变量')}</strong><code>${esc(variable.Type || 'bool')}</code><span>${String(variable.MemberKind || 'field').toLowerCase() === 'property' ? '属性' : '字段'}</span><small>${esc(variable.RegionName || fallbackRegion)}</small>
      </button>`).join('')}</div>` : '<div class="task-variable-summary-empty">尚未添加变量；变量定义与函数同级，生成在函数外。</div>'}`;
    host.querySelectorAll('[data-open-task-variables]').forEach(button => button.addEventListener('click', openTaskVariablesDialog));
  }

  function renderMethods() {
    const list = $('#methodList');
    const task = currentTask();
    const regionFilter = $('#methodRegionFilter');
    renderTaskVariableSummary(task);
    if (!state.workspace || !task) {
      selectedMethodIds.clear(); methodSelectionAnchor = '';
      regionFilter.innerHTML = '<option value="">全部 Region</option>';
      regionFilter.value = ''; regionFilter.disabled = true;
      list.innerHTML = '<div class="empty-inline">先新建或导入 Task</div>';
      return;
    }
    regionFilter.disabled = false;
    const taskMethods = (state.workspace.Methods || []).filter(method => taskOwnsMethod(method, task.TaskId));
    const inheritedCandidates = inheritedMethodsForTask(task);
    const previousRegion = regionFilter.value;
    const regionNames = [...new Set([
      ...(task.MethodCategories || []).map(category => typeof category === 'string' ? category : category && (category.Name || category.RegionName)),
      ...taskMethods.map(method => String(method.Category || '').trim() || '未分类'),
        ...inheritedCandidates.flatMap(item => [
          String(item.local?.Category || '').trim() || '未分类',
          String(item.method.Category || '').trim() || '未分类',
        ])
    ].map(region => String(region || '').trim()).filter(Boolean))];
    regionFilter.innerHTML = '<option value="">全部 Region</option>'
      + regionNames.map(region => `<option value="${esc(region)}">${esc(region)}</option>`).join('');
    regionFilter.value = regionNames.includes(previousRegion) ? previousRegion : '';
    const validSelection = new Set(taskMethods.map(method => method.MethodId));
    selectedMethodIds.forEach(methodId => { if (!validSelection.has(methodId)) selectedMethodIds.delete(methodId); });
    const modifierFilter = $('#methodModifierFilter').value;
    const selectedRegion = regionFilter.value;
    const query = ($('#methodSearch').value || '').trim().toLowerCase();
    const matchesMethodFilters = (method, extraText = '', checkRegion = true) => {
      const matchesQuery = !query || [method.MethodName, method.MethodId, method.Category, method.Signature,
        method.ReturnType, extraText, ...(method.Parameters || []).map(item => item.TypeName)].join(' ').toLowerCase().includes(query);
      if (!matchesQuery) return false;
      if (checkRegion && selectedRegion && (String(method.Category || '').trim() || '未分类') !== selectedRegion) return false;
      if (!modifierFilter) return true;
      const modifiers = methodModifierSet(method);
      return modifierFilter === 'none' ? modifiers.size === 0 : modifiers.has(modifierFilter);
    };
    const methods = taskMethods.filter(method => matchesMethodFilters(method));
    const inheritedMethods = inheritedCandidates.filter(item => {
      const method = item.local || item.method;
      const baseMethod = item.method;
      const regionMatches = !selectedRegion || [method.Category, baseMethod.Category]
        .some(category => (String(category || '').trim() || '未分类') === selectedRegion);
      const searchText = [item.owner.ClassName, baseMethod.MethodName, baseMethod.MethodId,
        baseMethod.Signature, baseMethod.Category, baseMethod.ReturnType,
        ...(baseMethod.Parameters || []).map(parameter => parameter.TypeName)].join(' ');
      return regionMatches && matchesMethodFilters(method, searchText, false);
    });
    if (!methods.length && !inheritedMethods.length && !taskMethods.length && !inheritedCandidates.length && !task.BaseType) {
      list.innerHTML = '<div class="empty-inline">当前 Task 还没有方法。<br>点击“新增函数”或导入 Task partial .cs 文件。</div>';
      return;
    }
    const files = new Map();
    methods.forEach(method => {
      const fileName = method.ImportedFileName || `${task.ClassName}_Methods.cs`;
      const className = method.ImportedClassName || task.ClassName;
      if (!files.has(fileName)) files.set(fileName, new Map());
      const classes = files.get(fileName);
      if (!classes.has(className)) classes.set(className, []);
      classes.get(className).push(method);
    });
    if (!files.size && (taskMethods.length || inheritedCandidates.length || task.BaseType))
      files.set(`${task.ClassName}_Methods.cs`, new Map([[task.ClassName, []]]));
    const parentMethodSet = new Set(inheritedCandidates.map(item => item.local).filter(Boolean));
    inheritedCandidates.filter(item => item.localIsOverride).forEach(item => parentMethodSet.add(item.local));
    selectedMethodIds.forEach(methodId => {
      if (Array.from(parentMethodSet).some(method => method.MethodId === methodId)) selectedMethodIds.delete(methodId);
    });
    const classNames = Array.from(files.values()).flatMap(classes => Array.from(classes.keys()));
    const parentMethodClassName = classNames.includes(task.ClassName) ? task.ClassName : classNames[0] || task.ClassName;
    let parentSectionRendered = false;
    list.innerHTML = '';
    files.forEach((classes, fileName) => {
      const fileTree = document.createElement('details');
      fileTree.className = 'catalog-file-tree'; fileTree.open = true;
      const total = Array.from(classes.values()).reduce((count, items) => count + items.length, 0);
      fileTree.innerHTML = `<summary><span class="tree-file-icon">CS</span><span class="tree-summary-copy"><strong>${esc(fileName)}</strong><small>${total} 个方法</small></span></summary>`;
      fileTree.querySelector('summary').addEventListener('contextmenu', event => {
        event.preventDefault(); event.stopPropagation();
        showContextMenu(event.clientX, event.clientY, [
          { label: '复制文件名', action: () => copyText(fileName) },
          { label: '从工程移除', action: () => removeMethodLibraryFile(fileName) },
        ]);
      });
      const children = document.createElement('div'); children.className = 'catalog-tree-children';
      classes.forEach((items, className) => {
        const classTree = document.createElement('details'); classTree.className = 'catalog-class-tree'; classTree.open = true;
        classTree.innerHTML = `<summary><span class="tree-class-icon">C</span><span class="tree-summary-copy"><strong>${esc(className)}</strong><small>${esc(task.Namespace || 'BoTech')} partial</small></span></summary>`;
        const methodRoot = document.createElement('div'); methodRoot.className = 'catalog-tree-children catalog-method-list';
        if (!parentSectionRendered && className === parentMethodClassName) {
          renderInheritedMethods(methodRoot, inheritedMethods, {
            hasCandidates: inheritedCandidates.length > 0,
            hasActiveFilters: Boolean(query || selectedRegion || modifierFilter),
            baseType: task.BaseType,
            taskId: task.TaskId,
          });
          parentSectionRendered = true;
        }
        const privateMethods = items.filter(method => !parentMethodSet.has(method));
        const privateSection = document.createElement('details');
        privateSection.className = 'private-method-library method-library-section';
        const privateStorageKey = `botech.task-editor.private-methods-open.${task.TaskId}.${fileName}.${className}`;
        restoreMethodLibrarySectionState(privateSection, privateStorageKey);
        privateSection.innerHTML = `<summary class="inherited-method-heading private-method-heading method-library-section-toggle"><strong>私有方法</strong><span>${privateMethods.length} 个</span></summary>`;
        if (!privateMethods.length) {
          const empty = document.createElement('div');
          empty.className = 'private-method-empty';
          empty.textContent = '没有符合当前筛选条件的私有方法';
          privateSection.appendChild(empty);
        }
        privateMethods.forEach(method => {
          const button = document.createElement('button');
          button.type = 'button'; button.className = `method-card catalog-method-card${selectedMethodIds.has(method.MethodId) ? ' method-selected' : ''}`; button.draggable = true;
          button.dataset.methodId = method.MethodId;
          const outputs = (method.Parameters || []).filter(parameter => parameter.Direction === 'out' || parameter.Direction === 'ref');
          const outcomes = method.ReturnType === 'bool' ? 'true / false'
            : method.ReturnType === 'int' ? (method.ResultStatusCodes || []).join(' / ') || '状态码未配置'
              : '顺序执行';
          const returnType = method.ReturnType || 'void';
          const modifiers = Array.isArray(method.Modifiers) ? method.Modifiers
            : String(method.MethodModifier || '').split(/\s+/).filter(Boolean);
          const modifierText = modifiers.join(' ') || '无修饰符';
          const comment = String(method.DocumentationSummary || '').trim();
          button.title = `${method.MethodName || method.MethodId}\n单击选择，双击编辑，右键编辑或删除`;
          button.innerHTML = `<span class="method-add">＋</span><span class="method-copy">
            <span class="method-id">${esc(method.MethodName || method.MethodId)}</span>
            <span class="method-tags">
              <span class="method-tag">${esc(method.AccessModifier || 'private')}</span>
              <span class="method-return-shape ${returnType === 'bool' ? 'return-bool' : returnType === 'int' ? 'return-int' : 'return-void'}">${esc(returnType)}</span>
              <span class="method-tag">${esc(modifierText)}</span>
              <span class="method-tag method-tag-category">${esc(method.Category || '未分类')}</span>
            </span>
            ${comment ? `<span class="method-comment">${esc(comment)}</span>` : ''}
            <span class="method-meta">${esc(outcomes)}</span>
            ${outputs.length ? `<span class="method-outputs">out ${esc(outputs.map(item => `${item.Name}: ${item.TypeName}`).join(' · '))}</span>` : ''}
          </span>`;
          button.addEventListener('click', event => {
            const visible = $$('#methodList .method-card');
            if (event.shiftKey && methodSelectionAnchor) {
              const start = visible.findIndex(item => item.dataset.methodId === methodSelectionAnchor);
              const end = visible.indexOf(button);
              if (!event.ctrlKey && !event.metaKey) selectedMethodIds.clear();
              visible.slice(Math.min(start < 0 ? end : start, end), Math.max(start < 0 ? end : start, end) + 1)
                .forEach(item => selectedMethodIds.add(item.dataset.methodId));
            } else if (event.ctrlKey || event.metaKey) {
              if (selectedMethodIds.has(method.MethodId)) selectedMethodIds.delete(method.MethodId);
              else selectedMethodIds.add(method.MethodId);
              methodSelectionAnchor = method.MethodId;
            } else {
              selectedMethodIds.clear(); selectedMethodIds.add(method.MethodId); methodSelectionAnchor = method.MethodId;
            }
            visible.forEach(item => item.classList.toggle('method-selected', selectedMethodIds.has(item.dataset.methodId)));
            const selectedCount = selectedMethodIds.size;
            setStatus(selectedCount > 1 ? `已选择 ${selectedCount} 个方法；拖拽单个方法到画布创建节点。`
              : `已选中 ${method.Signature || method.MethodName}；拖拽到画布才会创建节点。`, 'normal');
          });
          button.addEventListener('dblclick', () => {
            if (selectedMethodIds.size <= 1) openMethodDialog(method);
          });
          button.addEventListener('contextmenu', event => {
            event.preventDefault(); event.stopPropagation();
            if (!selectedMethodIds.has(method.MethodId)) {
              selectedMethodIds.clear(); selectedMethodIds.add(method.MethodId); methodSelectionAnchor = method.MethodId;
              $$('#methodList .method-card').forEach(item => item.classList.toggle('method-selected', item.dataset.methodId === method.MethodId));
            }
            const canEdit = selectedMethodIds.size === 1;
            showContextMenu(event.clientX, event.clientY, [
              { label: '编辑方法', disabled: !canEdit, action: () => { if (canEdit) openMethodDialog(method); } },
              { label: `删除方法${selectedMethodIds.size > 1 ? `（${selectedMethodIds.size}）` : ''}`, action: deleteSelectedMethods },
            ]);
          });
          button.addEventListener('dragstart', event => {
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-equipment-flow-method', JSON.stringify({
              MethodId: method.MethodId, SchemaVersion: method.SchemaVersion, TaskId: method.TaskId,
            }));
          });
          privateSection.appendChild(button);
        });
        methodRoot.appendChild(privateSection);
        classTree.appendChild(methodRoot); children.appendChild(classTree);
      });
      fileTree.appendChild(children); list.appendChild(fileTree);
    });
  }

  function removeMethodLibraryFile(fileName) {
    const task = currentTask();
    if (!task || !fileName) return;
    const methodFileName = method => method.ImportedFileName || `${task.ClassName}_Methods.cs`;
    const removedMethods = (state.workspace.Methods || [])
      .filter(method => method.TaskId === task.TaskId && methodFileName(method) === fileName);
    const hasFileRecord = (state.workspace.MethodFiles || [])
      .some(file => file.taskId === task.TaskId && file.fileName === fileName);
    if (!removedMethods.length && !hasFileRecord) return;

    const message = `确定从当前工程移除方法库文件“${fileName}”吗？这会移除当前 Task 中的 ${removedMethods.length} 个方法及导入记录；相关流程节点会显示未绑定方法，磁盘上的原文件不会删除。`;
    if (!window.confirm(message)) return;

    const removedIds = new Set(removedMethods.map(method => method.MethodId));
    state.workspace.Methods = (state.workspace.Methods || [])
      .filter(method => method.TaskId !== task.TaskId || methodFileName(method) !== fileName);
    state.workspace.MethodFiles = (state.workspace.MethodFiles || [])
      .filter(file => file.taskId !== task.TaskId || file.fileName !== fileName);
    removedIds.forEach(methodId => selectedMethodIds.delete(methodId));
    if (removedIds.has(methodSelectionAnchor)) methodSelectionAnchor = '';

    renderAll();
    persistProjectDraft();
    setStatus(`已从当前工程移除方法库文件 ${fileName}；相关流程节点保留并显示为未绑定，磁盘原文件未删除。`, 'normal');
  }

  function scopeLabel(method) {
    if (method.StationId) return method.StationId;
    if (method.MachineName) return method.MachineName;
    return '公共方法';
  }

  function loadLayout(flow) {
    const key = `botech.task.layout.${flow.StationId}.${flow.FlowId}`;
    try {
      const cached = JSON.parse(localStorage.getItem(key) || JSON.stringify((state.workspace.CanvasLayouts || {})[flow.StationId] || {}));
      state.layout = cached && typeof cached === 'object' ? cached : {};
    } catch (_) {
      state.layout = {};
    }
    flow.Nodes.forEach((node, index) => {
      if (!state.layout[node.NodeId]) state.layout[node.NodeId] = { x: 180, y: 60 + index * 210 };
    });
    Object.keys(state.layout).forEach(id => {
      if (!flow.Nodes.some(node => node.NodeId === id)) delete state.layout[id];
    });
  }

  function saveLayout(flow) {
    if (!flow || !state.workspace) return;
    flow.Nodes.forEach(node => {
      const point = state.layout[node.NodeId];
      if (point) { node.CanvasX = Math.round(point.x); node.CanvasY = Math.round(point.y); }
    });
    const key = `botech.task.layout.${flow.StationId}.${flow.FlowId}`;
    try { localStorage.setItem(key, JSON.stringify(state.layout)); } catch (_) { /* Browser storage is optional. */ }
    state.workspace.CanvasLayouts = state.workspace.CanvasLayouts || {};
    state.workspace.CanvasLayouts[flow.StationId] = JSON.parse(JSON.stringify(state.layout));
    state.workspace.DataBindings = collectDataBindings();
    persistProjectDraft();
  }

  function collectDataBindings() {
    if (!state.workspace) return [];
    return state.workspace.Flows.flatMap(flow => (flow.Nodes || []).flatMap(node => (node.Parameters || [])
      .filter(parameter => parameter.SourceNodeId && parameter.SourceParameterName)
      .map(parameter => ({
        FlowId: flow.FlowId, StationId: flow.StationId,
        NodeId: node.NodeId, ParameterName: parameter.Name, ParameterType: parameter.TypeName,
        SourceNodeId: parameter.SourceNodeId, SourceParameterName: parameter.SourceParameterName,
      }))));
  }

  function loadPanelState() {
    try {
      const saved = JSON.parse(localStorage.getItem('botech.flow.panels') || '{}');
      state.panelState = {
        methods: (saved.methods ?? saved.left) !== false,
        node: (saved.node ?? saved.right) !== false,
        hardware: saved.hardware !== false,
      };
      const dock = saved.dock || {};
      const validSide = (value, fallback) => value === 'left' || value === 'right' ? value : fallback;
      state.panelDock = {
        methods: validSide(dock.methods ?? dock.left, 'left'),
        node: validSide(dock.node ?? dock.right, 'right'),
        hardware: validSide(dock.hardware, 'right'),
      };
      const floating = saved.floating || {};
      const autoHide = saved.autoHide || {};
      state.panelFloating = { methods: Boolean(floating.methods ?? floating.left), node: Boolean(floating.node), hardware: Boolean(floating.hardware) };
      state.panelAutoHide = { methods: Boolean(autoHide.methods ?? autoHide.left), node: Boolean(autoHide.node), hardware: Boolean(autoHide.hardware ?? autoHide.right) };
      state.panelBounds = saved.bounds && typeof saved.bounds === 'object' ? saved.bounds : {};
      state.panelWidths = { left: Number(saved.widths?.left) || 330, right: Number(saved.widths?.right) || 360 };
    } catch (_) {
      state.panelState = { methods: true, node: true, hardware: true };
      state.panelDock = { methods: 'left', node: 'right', hardware: 'right' };
      state.panelFloating = { methods: false, node: false, hardware: false };
      state.panelAutoHide = { methods: false, node: false, hardware: false };
      state.panelWidths = { left: 330, right: 360 };
    }
  }

  function persistPanelState() {
    try {
      localStorage.setItem('botech.flow.panels', JSON.stringify({
        ...state.panelState, dock: state.panelDock, floating: state.panelFloating,
        autoHide: state.panelAutoHide, bounds: state.panelBounds,
        widths: state.panelWidths,
      }));
    } catch (_) { /* Layout preference storage is optional. */ }
  }

  function renderPanelVisibility() {
    Object.entries(TOOL_PANELS).forEach(([key, config]) => {
      const rail = document.getElementById(config.rail);
      const top = document.getElementById(config.toggle);
      const edge = document.getElementById(config.edge);
      const side = state.panelDock[key] === 'left' ? 'left' : 'right';
      const dockArea = document.getElementById(side === 'left' ? 'leftDockArea' : 'rightDockArea');
      const dockTabs = document.getElementById(side === 'left' ? 'leftDockTabs' : 'rightDockTabs');
      if (rail.parentElement !== dockArea) dockArea.appendChild(rail);
      if (edge.parentElement !== dockTabs) dockTabs.appendChild(edge);

      const autoHidden = Boolean(state.panelAutoHide[key] && state.panelState[key]);
      const visible = Boolean(state.panelState[key] && (!autoHidden || state.panelPeek[key]));
      const floating = Boolean(state.panelFloating[key]);
      const docked = visible && !floating && !autoHidden;
      rail.classList.toggle('panel-offstage', !visible);
      rail.classList.toggle('panel-floating', visible && floating);
      rail.classList.toggle('panel-auto-peek', visible && autoHidden && state.panelPeek[key]);
      rail.classList.toggle('panel-dock-left', side === 'left');
      rail.classList.toggle('panel-dock-right', side === 'right');
      rail.setAttribute('aria-hidden', String(!visible));
      rail.inert = !visible;

      top.setAttribute('aria-expanded', String(visible));
      top.title = (visible ? '隐藏' : '显示') + config.title;
      const floatButton = document.getElementById(config.floating);
      floatButton.innerHTML = floating ? PANEL_ICONS.dock : PANEL_ICONS.float;
      floatButton.title = floating ? '停靠到 ' + (side === 'left' ? '左' : '右') + '侧' : '浮动；也可拖动标题栏';
      floatButton.setAttribute('aria-label', floatButton.title);
      floatButton.setAttribute('aria-pressed', String(floating));

      const autoHideButton = document.getElementById(config.autoHide);
      const autoHideEnabled = Boolean(state.panelAutoHide[key]);
      autoHideButton.innerHTML = autoHideEnabled ? PANEL_ICONS.unpin : PANEL_ICONS.pin;
      autoHideButton.classList.toggle('is-active', autoHideEnabled);
      autoHideButton.setAttribute('aria-pressed', String(autoHideEnabled));
      autoHideButton.title = autoHideEnabled ? '固定显示面板' : '自动隐藏到屏幕边缘';
      autoHideButton.setAttribute('aria-label', autoHideButton.title);
      const closeButton = document.getElementById(config.close);
      closeButton.innerHTML = PANEL_ICONS.close;
      closeButton.title = '隐藏' + config.title;
      closeButton.setAttribute('aria-label', closeButton.title);

      edge.classList.toggle('is-active', visible);
      edge.setAttribute('aria-expanded', String(visible));
      edge.setAttribute('aria-hidden', 'false');
      edge.tabIndex = 0;
      edge.title = autoHideEnabled ? '悬停展开' + config.title : (visible ? '隐藏' : '显示') + config.title;

      const bounds = state.panelBounds[key] || {};
      if (visible && floating) {
        const width = Math.max(300, Math.min(620, Number(bounds.width) || config.width));
        const height = Math.max(260, Math.min(window.innerHeight - 70, Number(bounds.height) || Math.min(560, window.innerHeight - 118)));
        const defaultLeft = side === 'left' ? 18 : window.innerWidth - width - 18;
        const requestedLeft = Number.isFinite(Number(bounds.left)) ? Number(bounds.left) : defaultLeft;
        const requestedTop = Number.isFinite(Number(bounds.top)) ? Number(bounds.top) : 84;
        const maxLeft = Math.max(0, window.innerWidth - Math.min(120, width));
        const maxTop = Math.max(48, window.innerHeight - 90);
        rail.style.left = Math.max(0, Math.min(maxLeft, requestedLeft)) + 'px';
        rail.style.top = Math.max(48, Math.min(maxTop, requestedTop)) + 'px';
        rail.style.width = width + 'px';
        rail.style.height = height + 'px';
      } else {
        rail.style.left = '';
        rail.style.top = '';
        rail.style.width = '';
        rail.style.height = '';
      }
      rail.dataset.docked = String(docked);
    });

    const countDocked = side => Object.keys(TOOL_PANELS).filter(key =>
      state.panelState[key] && !state.panelFloating[key] && !state.panelAutoHide[key] && state.panelDock[key] === side
    ).length;
    const leftCount = countDocked('left');
    const rightCount = countDocked('right');
    const leftWidth = leftCount ? Math.max(240, Number(state.panelWidths.left) || 330) : 0;
    const rightWidth = rightCount ? Math.max(260, Number(state.panelWidths.right) || 360) : 0;
    $('.workbench').style.gridTemplateColumns = '32px ' + leftWidth + 'px minmax(300px,1fr) ' + rightWidth + 'px 32px';
    $('#leftDockArea').classList.toggle('dock-area-empty', leftCount === 0);
    $('#rightDockArea').classList.toggle('dock-area-empty', rightCount === 0);
    requestAnimationFrame(() => { if (state.workspace) renderFlow(); });
  }

  function setPanelVisible(key, visible) {
    if (visible) {
      state.panelAutoHide[key] = false;
      state.panelPeek[key] = false;
    }
    state.panelState[key] = Boolean(visible);
    persistPanelState();
    renderPanelVisibility();
  }

  function beginDockResize(event) {
    const grip = event.currentTarget;
    if (event.button !== 0) return;
    event.preventDefault();
    const side = grip.dataset.dockSide;
    state.panelResize = { side, startX: event.clientX, startWidth: Number(state.panelWidths[side]) || (side === 'left' ? 330 : 360), grip };
    grip.classList.add('is-dragging');
    $('.workbench').classList.add('is-resizing-dock');
    grip.setPointerCapture?.(event.pointerId);
  }

  function moveDockResize(event) {
    const resize = state.panelResize;
    if (!resize) return;
    const otherSide = resize.side === 'left' ? 'right' : 'left';
    const hasOtherDocked = Object.keys(TOOL_PANELS).some(key => state.panelState[key] && !state.panelFloating[key]
      && !state.panelAutoHide[key] && state.panelDock[key] === otherSide);
    const otherWidth = hasOtherDocked ? Number(state.panelWidths[otherSide]) || 360 : 0;
    const direction = resize.side === 'left' ? 1 : -1;
    const available = $('.workbench').clientWidth - 64 - otherWidth - 300;
    const maximum = Math.max(240, Math.min(720, available));
    state.panelWidths[resize.side] = Math.max(240, Math.min(maximum, resize.startWidth + direction * (event.clientX - resize.startX)));
    const leftActive = Object.keys(TOOL_PANELS).some(key => state.panelState[key] && !state.panelFloating[key] && !state.panelAutoHide[key] && state.panelDock[key] === 'left');
    const rightActive = Object.keys(TOOL_PANELS).some(key => state.panelState[key] && !state.panelFloating[key] && !state.panelAutoHide[key] && state.panelDock[key] === 'right');
    $('.workbench').style.gridTemplateColumns = `32px ${leftActive ? state.panelWidths.left : 0}px minmax(300px,1fr) ${rightActive ? state.panelWidths.right : 0}px 32px`;
  }

  function finishDockResize() {
    if (!state.panelResize) return;
    state.panelResize.grip.classList.remove('is-dragging');
    state.panelResize = null;
    $('.workbench').classList.remove('is-resizing-dock');
    persistPanelState();
  }

  function resizeDockByKeyboard(event) {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const side = event.currentTarget.dataset.dockSide;
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const amount = event.shiftKey ? 32 : 12;
    const otherSide = side === 'left' ? 'right' : 'left';
    const otherWidth = Object.keys(TOOL_PANELS).some(key => state.panelState[key] && !state.panelFloating[key] && !state.panelAutoHide[key] && state.panelDock[key] === otherSide)
      ? Number(state.panelWidths[otherSide]) || 360 : 0;
    const maximum = Math.max(240, Math.min(720, $('.workbench').clientWidth - 364 - otherWidth));
    state.panelWidths[side] = Math.max(240, Math.min(maximum, (Number(state.panelWidths[side]) || 330) + direction * amount));
    renderPanelVisibility(); persistPanelState();
  }

  function togglePanelAutoHide(key) {
    const enabled = !state.panelAutoHide[key];
    state.panelAutoHide[key] = enabled;
    state.panelPeek[key] = false;
    state.panelState[key] = true;
    state.panelFloating[key] = false;
    persistPanelState();
    renderPanelVisibility();
  }

  function revealPanelEdge(key) {
    if (state.panelAutoHide[key]) {
      state.panelState[key] = true;
      state.panelPeek[key] = true;
      renderPanelVisibility();
    } else setPanelVisible(key, true);
  }

  function scheduleAutoHidePanel(key, event) {
    if (!state.panelAutoHide[key]) return;
    clearPanelAutoHideTimer(key);
    const x = event.clientX, y = event.clientY;
    state.panelHideTimers[key] = setTimeout(() => {
      delete state.panelHideTimers[key];
      if (!state.panelAutoHide[key]) return;
      const hovered = document.elementFromPoint(x, y);
      const rail = document.getElementById(TOOL_PANELS[key].rail);
      const edge = document.getElementById(TOOL_PANELS[key].edge);
      if (!rail.contains(hovered) && !edge.contains(hovered)) {
        state.panelPeek[key] = false;
        renderPanelVisibility();
      }
    }, 140);
  }

  function clearPanelAutoHideTimer(key) {
    const timer = state.panelHideTimers[key];
    if (timer) clearTimeout(timer);
    delete state.panelHideTimers[key];
  }

  function dockPanel(key, edge) {
    state.panelDock[key] = edge;
    state.panelFloating[key] = false;
    state.panelAutoHide[key] = false;
    state.panelPeek[key] = false;
    state.panelState[key] = true;
    persistPanelState();
    renderPanelVisibility();
  }

  function togglePanelFloating(key) {
    if (state.panelFloating[key]) {
      dockPanel(key, state.panelDock[key]);
      return;
    }
    state.panelState[key] = true;
    state.panelAutoHide[key] = false;
    state.panelPeek[key] = false;
    state.panelFloating[key] = true;
    const width = TOOL_PANELS[key].width;
    state.panelBounds[key] = {
      left: state.panelDock[key] === 'left' ? 18 : Math.max(18, window.innerWidth - width - 18),
      top: 84,
      width,
      height: Math.max(280, Math.min(560, window.innerHeight - 118)),
    };
    persistPanelState();
    renderPanelVisibility();
  }

  function beginPanelDrag(key, event) {
    if (event.button !== 0 || !event.target.closest('.tool-window-heading, .method-heading')) return;
    if (event.target.closest('button, input, select, textarea, a, [contenteditable="true"]')) return;
    const rail = document.getElementById(TOOL_PANELS[key].rail);
    const rect = rail.getBoundingClientRect();
    state.panelDrag = {
      key, pointerX: event.clientX, pointerY: event.clientY, left: rect.left, top: rect.top,
      width: rect.width, height: rect.height, originTarget: event.target, moved: false,
    };
  }

  function movePanelDrag(event) {
    const drag = state.panelDrag;
    if (!drag) return;
    const moved = Math.abs(event.clientX - drag.pointerX) + Math.abs(event.clientY - drag.pointerY) > 6;
    if (!moved) return;
    drag.moved = true;
    const key = drag.key;
    if (!state.panelFloating[key]) {
      state.panelFloating[key] = true;
      state.panelAutoHide[key] = false;
      state.panelPeek[key] = false;
      state.panelState[key] = true;
      state.panelBounds[key] = { left: drag.left, top: drag.top, width: drag.width, height: drag.height };
      renderPanelVisibility();
    }
    const rail = document.getElementById(TOOL_PANELS[key].rail);
    const left = Math.max(0, Math.min(window.innerWidth - 100, drag.left + event.clientX - drag.pointerX));
    const top = Math.max(46, Math.min(window.innerHeight - 70, drag.top + event.clientY - drag.pointerY));
    rail.style.left = left + 'px';
    rail.style.top = top + 'px';
    state.panelBounds[key] = { left, top, width: rail.offsetWidth, height: rail.offsetHeight };
    event.preventDefault();
  }

  function finishPanelDrag(event) {
    const drag = state.panelDrag;
    if (!drag) {
      let resized = false;
      Object.keys(TOOL_PANELS).forEach(key => {
        if (!state.panelFloating[key]) return;
        const rect = document.getElementById(TOOL_PANELS[key].rail).getBoundingClientRect();
        state.panelBounds[key] = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        resized = true;
      });
      if (resized) persistPanelState();
      return;
    }
    state.panelDrag = null;
    if (drag.moved && drag.originTarget.closest('.panel-heading-actions')) {
      state.suppressPanelClick = true;
      setTimeout(() => { state.suppressPanelClick = false; }, 0);
    }
    if (drag.moved && event.clientX < 80) dockPanel(drag.key, 'left');
    else if (drag.moved && event.clientX > window.innerWidth - 80) dockPanel(drag.key, 'right');
    else if (drag.moved) {
      persistPanelState();
      renderPanelVisibility();
    }
  }
  function renderFlow() {
    const flow = currentFlow();
    const task = currentTask();
    const inheritedAutoRunOnly = taskUsesInheritedAutoRun(task, flow);
    const canvasEmpty = $('#canvasEmpty');
    const flowCanvas = $('#flowCanvas');
    if (flow) {
      loadLayout(flow);
      $('#flowTitle').textContent = task ? task.Name : flow.StationId;
      $('#flowMeta').textContent = `${task ? `${task.Namespace}.${task.ClassName}` : flow.FlowId} · ${inheritedAutoRunOnly ? '继承父类 AutoRun' : `${flow.Nodes.length} 个节点 · 入口 ${flow.EntryNodeId || '未设置'}`}`;
    } else {
      $('#flowTitle').textContent = '未选择 Task';
      $('#flowMeta').textContent = task && inheritedAutoRunOnly ? '继承父类 AutoRun' : '新建 Task 后绘制 AutoRun 流程';
    }
    if (canvasEmpty) {
      canvasEmpty.classList.toggle('hidden', !inheritedAutoRunOnly && Boolean(flow && flow.Nodes.length));
      const title = canvasEmpty.querySelector('strong');
      const detail = canvasEmpty.querySelector('small');
      if (title) title.textContent = inheritedAutoRunOnly ? '此 Task 继承父类 AutoRun' : '在这里绘制工站流程';
      if (detail) detail.textContent = inheritedAutoRunOnly
        ? `运行流程由 ${task?.BaseType || '父类'} 提供；拖入流程节点后可单独定义当前 Task 的流程`
        : '从顶部拖入形状，或从左侧拖入方法';
    }
    flowCanvas?.classList.toggle('inherited-auto-empty', inheritedAutoRunOnly);
    $('#nodeMetric').textContent = `${inheritedAutoRunOnly ? 0 : flow ? flow.Nodes.length : 0} 个节点`;
    $('#edgeMetric').textContent = `${inheritedAutoRunOnly ? 0 : flow ? flow.Transitions.length : 0} 条分支`;
    canvasEditor.render();
    renderInspector();
  }

  function redrawEdgesOnly() { canvasEditor.renderEdges(); }

  function renderStatusCodeEditor(root, values, onChange) {
    if (!root) return;
    const statuses = window.EquipmentFlowMethodStatuses.normalizeResultStatusCodes(values);
    const render = current => {
      root.innerHTML = `<div class="status-code-list">${current.map(code => `<span class="status-code-chip${code === 0 ? ' status-code-required' : ''}">${esc(code)}${code === 0
        ? '<small title="数值状态码必须包含 0">必需</small>'
        : `<button class="status-code-remove" type="button" data-remove-status="${esc(code)}" aria-label="删除状态码 ${esc(code)}" title="删除状态码">×</button>`}</span>`).join('')}</div>
        <div class="status-code-add"><input type="number" step="1" data-new-status inputmode="numeric" aria-label="新增状态码" placeholder="新增整数状态码"><button type="button" data-add-status>＋ 添加</button></div>`;
      root.querySelectorAll('[data-remove-status]').forEach(button => button.addEventListener('click', () => {
        try {
          const next = window.EquipmentFlowMethodStatuses.removeResultStatusCode(current, button.dataset.removeStatus);
          const accepted = onChange ? onChange(next) : next;
          render(window.EquipmentFlowMethodStatuses.normalizeResultStatusCodes(accepted || next));
        } catch (error) { setStatus(error.message, 'error'); }
      }));
      const input = root.querySelector('[data-new-status]');
      const add = () => {
        try {
          const token = input.value.trim();
          if (!token) { setStatus('请输入整数状态码。', 'warning'); input.focus(); return; }
          const next = window.EquipmentFlowMethodStatuses.addResultStatusCode(current, token);
          if (next.length === current.length) { setStatus(`状态码 ${token} 已存在。`, 'warning'); input.select(); return; }
          const accepted = onChange ? onChange(next) : next;
          if (root.isConnected) render(window.EquipmentFlowMethodStatuses.normalizeResultStatusCodes(accepted || next));
        } catch (error) { setStatus(error.message, 'error'); }
      };
      root.querySelector('[data-add-status]').addEventListener('click', add);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); add(); }
      });
    };
    render(statuses);
  }

  function applyMethodResultStatusCodes(method, values) {
    const statuses = window.EquipmentFlowMethodStatuses.validateResultStatusCodesChange(method, values, state.workspace);
    const source = String(method.SourceCode || window.EquipmentFlowTaskCodegen.methodSource(method));
    const sourceWithStatuses = window.EquipmentFlowCSharpCatalog.updateResultStatusCodes(source, method.MethodName, statuses);
    const parsed = parseMethodCodeEditor(sourceWithStatuses);
    Object.assign(method, {
      ResultStatusCodes: statuses,
      Outcomes: statuses.map(String),
      SourceCode: sourceWithStatuses,
      AttributeSource: parsed.AttributeSource || method.AttributeSource || '',
      BodyText: unindentMethodBody(parsed.BodyText),
      PreserveSource: true,
    });
    renderAll(); updateWorkspaceHeader(); persistProjectDraft();
    setStatus('状态码已同步到方法库和所有绑定节点。', 'normal');
    return statuses;
  }

  function renderInspector() {
    const root = $('#nodeEditor');
    const empty = $('#inspectorEmpty');
    const selectedEdge = canvasEditor.selectedEdge();
    if (selectedEdge && selectedEdge.edge) {
      renderEdgeInspector(selectedEdge, root, empty);
      return;
    }
    const node = selectedNode();
    if (!node) {
      root.classList.add('hidden');
      empty.classList.remove('hidden');
      empty.querySelector('strong').textContent = '选择一个节点';
      empty.querySelector('span').textContent = '在此编辑工艺方法、参数和状态分支';
      return;
    }
    empty.classList.add('hidden');
    root.classList.remove('hidden');
    const flow = currentFlow();
    const method = methodFor(node);
    const control = ['Start', 'End'].includes(node.NodeType);
    const executable = !control;
    const methods = applicableMethods(flow);
    const selectedMethod = methodFor(node);
    const methodOptions = methods.map(item => `<option value="${esc(methodLibrary.methodSelectionValue(item))}" ${selectedMethod === item ? 'selected' : ''}>${esc(item.MethodId)} · v${esc(item.SchemaVersion)} · ${esc(scopeLabel(item))}</option>`).join('');
    const resultCodes = method && method.ResultStatusCodes ? method.ResultStatusCodes : [];
    const pendingCodes = method && method.PendingStatusCodes ? method.PendingStatusCodes : [];
    const alarmCodes = method && method.AlarmStatusCodes ? method.AlarmStatusCodes : [];
    const statusHelp = method && method.ReturnType === 'bool' ? 'bool 判断返回 true / false；两个分支都需要连接。' : resultCodes.length
      ? `返回状态：${resultCodes.map(code => alarmCodes.includes(code) ? `${code} 报警` : String(code)).join('、')}${pendingCodes.length ? `；等待状态：${pendingCodes.join('、')}` : ''}。每个非等待状态都必须显式连接。`
      : '方法按当前机种和工站筛选；状态码由方法 int 返回值驱动后续分支。';
    const editableResultStatuses = method && method.ReturnType === 'int';
    const typeOptions = ['Start', 'Action', 'Condition', 'Wait', 'Alarm', 'End']
      .map(type => `<option value="${type}" ${node.NodeType === type ? 'selected' : ''}>${typeLabel(type)}</option>`).join('');
    root.innerHTML = `<div class="inspector-title-row"><span class="inspector-kind">${node.NodeType === 'Start' ? '▶' : node.NodeType === 'End' ? '■' : 'ƒ'}</span>
        <div class="inspector-heading"><strong>${esc(node.DisplayName || node.NodeId)}</strong><small>${esc(node.NodeId)} · ${typeLabel(node.NodeType)}</small></div>
        <button class="delete-node" id="deleteNode" title="删除节点">⌫</button></div>
      <div class="field"><label for="nodeName">节点名称${control ? '（固定）' : ''}</label><input id="nodeName" data-node-field="DisplayName" value="${esc(node.DisplayName)}" maxlength="256" ${control ? 'disabled' : ''}></div>
      <div class="field"><label for="nodeType">节点类型</label><select id="nodeType" data-node-field="NodeType">${typeOptions}</select></div>
      ${executable ? `<div class="field"><label for="methodId">绑定方法 ID</label><select id="methodId" data-node-field="MethodId"><option value="">选择已注册方法</option>${methodOptions}</select><span class="field-help">${esc(editableResultStatuses ? `状态码与方法库共享，修改后所有绑定节点同步更新。${statusHelp}` : statusHelp)}</span></div>
        ${editableResultStatuses ? `<div class="field node-status-field"><span>方法返回状态码</span><div id="nodeResultStatusEditor" class="status-code-editor" data-status-editor="node"></div><input id="nodeStatusCodesInput" type="hidden" value="${esc(window.EquipmentFlowMethodStatuses.normalizeResultStatusCodes(resultCodes).join(', '))}"><span class="field-help node-status-help">0 为必需状态；新增状态后，可在下方添加对应输出分支。</span></div>` : ''}
        <div class="field-row"><div class="field"><label for="pendingStatus">等待状态码</label><input id="pendingStatus" inputmode="numeric" data-node-field="PendingStatusCode" value="${esc(getNodeFieldValue(node, 'PendingStatusCode'))}" placeholder="可留空"></div>
          <div class="field"><label for="timeoutMs">超时毫秒</label><input id="timeoutMs" inputmode="numeric" data-node-field="TimeoutMilliseconds" value="${esc(getNodeFieldValue(node, 'TimeoutMilliseconds'))}" placeholder="可留空"></div></div>
        <div class="field"><label for="failurePolicy">失败处理</label><select id="failurePolicy" data-node-field="FailurePolicy"><option value="Fault" ${(node.FailurePolicy || 'Fault') === 'Fault' ? 'selected' : ''}>Fault · 停止并报警</option><option value="Transition" ${node.FailurePolicy === 'Transition' ? 'selected' : ''}>Transition · 走失败分支</option></select></div>
        <div class="property-divider"></div><div class="subsection-title">方法参数 <span>${method ? `${method.Parameters.length} 项` : '先选择方法'}</span></div>
        <div id="parameterFields">${renderParameterFields(node, method)}</div>`
        : `<div class="field-help">${node.NodeType === 'Start' ? '流程入口只连接后继节点，不绑定执行方法。' : '结束节点没有后继分支和方法绑定。'}</div>`}
      <div class="property-divider"></div>
      <div class="subsection-title">分支关系 <span>${flow.Transitions.filter(item => item.FromNodeId === node.NodeId || item.ToNodeId === node.NodeId).length} 条</span></div>
      <div id="transitionList">${renderTransitions(flow, node)}</div>
      ${node.NodeType !== 'End' ? '<button id="addTransition" class="small-action">＋ 添加输出分支</button>' : ''}`;

    root.querySelectorAll('[data-node-field]').forEach(control => {
      control.addEventListener('change', () => updateNodeField(control.dataset.nodeField, control.value, false, control));
    });
    root.querySelectorAll('[data-parameter]').forEach(control => {
      control.addEventListener('change', () => updateParameter(control.dataset.parameter, control.value));
    });
    root.querySelectorAll('[data-parameter-source]').forEach(control => {
      control.addEventListener('change', () => updateParameterSource(control.dataset.parameterSource, control.value));
    });
    root.querySelectorAll('[data-transition]').forEach(control => {
      control.addEventListener('change', () => updateTransition(control.dataset.transition, control.dataset.field, control.value));
    });
    root.querySelectorAll('[data-remove-transition]').forEach(button => button.addEventListener('click', () => removeTransition(Number(button.dataset.removeTransition))));
    const deleteButton = $('#deleteNode', root);
    if (deleteButton) deleteButton.addEventListener('click', deleteSelectedNode);
    const addTransitionButton = $('#addTransition', root);
    if (addTransitionButton) addTransitionButton.addEventListener('click', addTransition);
    const nodeStatusEditor = $('#nodeResultStatusEditor', root);
    if (nodeStatusEditor && method) renderStatusCodeEditor(nodeStatusEditor, resultCodes, next => {
      const updated = applyMethodResultStatusCodes(method, next);
      const hidden = $('#nodeStatusCodesInput', root);
      if (hidden) hidden.value = updated.join(', ');
      return updated;
    });
  }

  function renderParameterFields(node, method) {
    if (!method) return '<div class="empty-inline">尚未绑定已注册方法</div>';
    const inputSchemas = (method.Parameters || []).filter(schema => schema.Direction !== 'out');
    if (!inputSchemas.length) {
      const outputs = (method.Parameters || []).filter(schema => schema.Direction === 'out' || schema.Direction === 'ref');
      return `<div class="empty-inline">${outputs.length ? `此方法提供 ${outputs.map(item => esc(item.FlowName || item.Name)).join('、')} 等输出数据` : '此方法不需要额外参数，硬件由机种上下文提供'}</div>`;
    }
    return inputSchemas.map(schema => {
      const current = (node.Parameters || []).find(item => item.Name === schema.Name);
      const value = current && current.Value != null && String(current.Value).trim() !== ''
        ? current.Value : (schema.DefaultValue || '');
      let control;
      const choices = resourceChoices(schema.TypeName, schema.AllowedValues);
      if (choices.length) {
        const defaultChoice = value && !choices.includes(value)
          ? `<option value="${esc(value)}" selected>${esc(value)} · 默认值</option>` : '';
        control = `<select data-parameter="${esc(schema.Name)}"><option value="" ${value ? '' : 'selected'}>请选择</option>${defaultChoice}${choices.map(choice => `<option value="${esc(choice)}" ${value === choice ? 'selected' : ''}>${esc(choice)}</option>`).join('')}</select>`;
      } else {
        const number = ['int', 'short', 'long', 'double', 'float', 'decimal'].includes((schema.TypeName || '').toLowerCase());
        control = `<input data-parameter="${esc(schema.Name)}" value="${esc(value)}" ${number ? 'inputmode="decimal"' : ''} ${schema.Required ? 'required' : ''}>`;
      }
      const sources = availableOutputSources(currentFlow(), node, schema);
      const selectedSource = current && current.SourceNodeId && current.SourceParameterName
        ? sources.find(source => source.NodeId === current.SourceNodeId
          && [source.ParameterName, source.DisplayName].includes(current.SourceParameterName)) : null;
      const sourceValue = selectedSource ? JSON.stringify([selectedSource.NodeId, selectedSource.ParameterName]) : '';
      const sourceOptions = sources.map(source => {
        const optionValue = JSON.stringify([source.NodeId, source.ParameterName]);
        return `<option value="${esc(optionValue)}" ${sourceValue === optionValue ? 'selected' : ''}>${esc(source.NodeName)} · ${esc(source.DisplayName)}</option>`;
      }).join('');
      return `<div class="parameter-row"><div class="parameter-name"><span>${esc(schema.FlowName || schema.Name)}${schema.Required ? ' · 必填' : ''}</span><span class="parameter-type">${esc(schema.TypeName)}</span></div>${control}${sources.length ? `<label class="data-source-label">或从其他节点接入<select data-parameter-source="${esc(schema.Name)}"><option value="">手动输入 / 未绑定</option>${sourceOptions}</select></label>` : ''}</div>`;
    }).join('');
  }

  function renderEdgeInspector(selection, root, empty) {
    const { edge, index } = selection;
    const flow = currentFlow();
    empty.classList.add('hidden'); root.classList.remove('hidden');
    const options = selected => flow.Nodes.map(node => `<option value="${esc(node.NodeId)}" ${node.NodeId === selected ? 'selected' : ''}>${esc(node.DisplayName || node.NodeId)}</option>`).join('');
    root.innerHTML = `<div class="inspector-title-row"><span class="inspector-kind">⌁</span><div class="inspector-heading"><strong>流程连线</strong><small>${esc(edge.FromNodeId)} → ${esc(edge.ToNodeId)}</small></div><button id="deleteEdge" class="delete-node" title="删除连线">⌫</button></div>
      <label class="field"><span>起点</span><select data-edge-field="FromNodeId">${options(edge.FromNodeId)}</select></label>
      <label class="field"><span>返回状态 / 分支</span><input data-edge-field="Outcome" value="${esc(edge.Outcome)}"></label>
      <label class="field"><span>终点</span><select data-edge-field="ToNodeId">${options(edge.ToNodeId)}</select></label>
      <label class="field"><span>优先级</span><input data-edge-field="Priority" inputmode="numeric" value="${esc(edge.Priority)}"></label>
      <p class="field-help">拖动端点重新连接；拖动连线中间的控制点修改折线位置。bool 分支使用 true / false，int 分支使用声明的状态码。</p>`;
    root.querySelectorAll('[data-edge-field]').forEach(control => control.addEventListener('change', () => {
      if (control.dataset.edgeField === 'Priority' && !/^-?\d+$/.test(control.value.trim())) {
        setStatus('优先级必须为整数。', 'error'); return;
      }
      updateTransition(index, control.dataset.edgeField, control.value);
    }));
    $('#deleteEdge', root).addEventListener('click', () => canvasEditor.deleteSelection());
  }

  function availableOutputSources(flow, targetNode, inputSchema) {
    if (!flow) return [];
    return flow.Nodes.filter(node => node.NodeId !== targetNode.NodeId
      && canReachNode(flow, node.NodeId, targetNode.NodeId)).flatMap(node => {
      const method = methodFor(node);
      return (method && method.CanBind !== false ? method.Parameters : []).filter(output => ['out', 'ref'].includes(output.Direction)
        && output.TypeName === inputSchema.TypeName).map(output => ({
        NodeId: node.NodeId, NodeName: node.DisplayName || node.NodeId,
        ParameterName: output.Name,
        DisplayName: output.FlowName || output.Name,
      }));
    });
  }

  function canReachNode(flow, fromNodeId, targetNodeId) {
    const visited = new Set();
    const pending = [fromNodeId];
    while (pending.length) {
      const nodeId = pending.pop();
      if (nodeId === targetNodeId) return true;
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      flow.Transitions.filter(edge => edge.FromNodeId === nodeId).forEach(edge => pending.push(edge.ToNodeId));
    }
    return false;
  }

  function resourceChoices(typeName, allowedValues) {
    if (allowedValues && allowedValues.length) return allowedValues;
    const normalizedType = (typeName || '').trim();
    const typeParts = normalizedType.split(':', 2);
    const kind = ({ axis: 'Axis', maxis: 'Axis', input: 'Input', inno: 'Input', output: 'Output', outno: 'Output', nozzle: 'Nozzle', nozzlegroup: 'NozzleGroup' })[typeParts[0].toLowerCase()];
    if (!kind || !state.workspace) return [];
    if (kind === 'NozzleGroup') {
      const factoryTypes = (state.workspace.HardwareFactories || [])
        .filter(item => (!typeParts[1] || item.NozzleType === typeParts[1])
          && (!item.MachineName || item.MachineName === state.workspace.MachineName)
          && (!item.StationId || item.StationId === state.stationId))
        .map(item => item.NozzleType);
      return [...new Set([...factoryTypes, ...(state.workspace.Hardware || [])
        .filter(item => item.ResourceType === 'Nozzle' && (!typeParts[1] || item.GroupName === typeParts[1]))
        .map(item => item.GroupName)])];
    }
    const aliases = { Axis: ['Axis', 'mAxis', 'AxisChannel'], Input: ['Input', 'InNo'], Output: ['Output', 'OutNo'], Nozzle: ['Nozzle'] };
    return [...(state.workspace.Hardware || []), ...(state.workspace.HardwareCatalogResources || [])].filter(item => aliases[kind].includes(item.ResourceType)
      && (kind !== 'Nozzle' || typeParts.length === 1 || item.GroupName === typeParts[1]))
      .map(item => kind === 'Nozzle'
        ? (typeParts.length > 1 ? String(item.SlotId) : `${item.GroupName}:${item.SlotId}`)
        : item.Name);
  }

  function renderTransitions(flow, node) {
    const incoming = flow.Transitions.map((item, index) => ({ item, index }))
      .filter(pair => pair.item.ToNodeId === node.NodeId);
    const outgoing = flow.Transitions.map((item, index) => ({ item, index }))
      .filter(pair => pair.item.FromNodeId === node.NodeId);
    const incomingMarkup = incoming.length ? incoming.map(({ item }) => {
      const source = flow.Nodes.find(candidate => candidate.NodeId === item.FromNodeId);
      return `<div class="transition-card transition-input-card"><div class="transition-row"><span class="branch-value">${esc(item.Outcome || '（未填写）')}</span><span class="branch-source">${esc(source && (source.DisplayName || source.NodeId) || item.FromNodeId)}</span></div>
        <div class="transition-priority">输入分支 · 优先级 ${esc(item.Priority)}</div></div>`;
    }).join('') : `<div class="empty-inline">${node.NodeType === 'Start' ? '流程入口没有输入分支' : '暂无输入分支'}</div>`;
    const outgoingMarkup = outgoing.length ? outgoing.map(({ item, index }) => `<div class="transition-card transition-output-card"><div class="transition-row">
      <input class="outcome-input" data-transition="${index}" data-field="Outcome" value="${esc(item.Outcome)}" aria-label="输出分支结果">
      <select data-transition="${index}" data-field="ToNodeId" aria-label="输出分支连接目标">${flow.Nodes.filter(target => target.NodeType !== 'Start').map(target => `<option value="${esc(target.NodeId)}" ${target.NodeId === item.ToNodeId ? 'selected' : ''}>${esc(target.DisplayName || target.NodeId)}</option>`).join('')}</select>
      <button class="remove-transition" data-remove-transition="${index}" title="删除输出分支">×</button></div>
      <div class="transition-priority">输出分支 · 优先级 ${esc(item.Priority)} · 连接后画布自动显示连线</div></div>`).join('')
      : '<div class="empty-inline">暂无输出分支；添加后会自动生成画布连线</div>';
    return `<section class="transition-group"><div class="transition-group-title">输入分支 <span>${incoming.length}</span></div>${incomingMarkup}</section>
      <section class="transition-group"><div class="transition-group-title">输出分支 <span>${outgoing.length}</span></div>${outgoingMarkup}</section>`;
  }

  function updateNodeField(field, value, redraw = false, control = null) {
    const node = selectedNode();
    const flow = currentFlow();
    if (!node || !flow) return;
    if (field === 'DisplayName' && ['Start', 'End'].includes(node.NodeType)) {
      node.DisplayName = node.NodeType === 'Start' ? '开始' : '结束';
      return;
    }
    canvasEditor.recordBefore();
    if (field === 'MethodId') {
      const method = methodLibrary.resolveMethodSelection(applicableMethods(flow), value);
      node.MethodId = method ? method.MethodId : '';
      node.MethodSchemaVersion = method ? method.SchemaVersion : 0;
      node.MethodMachineName = method ? method.MachineName || '' : '';
      node.MethodStationId = method ? method.StationId || '' : '';
      if (method) node.NodeType = methodLibrary.isAlarmMethod(method) ? 'Alarm' : method.ReturnType === 'bool' ? 'Condition' : 'Action';
      if (method && method.ReturnType === 'bool') node.PendingStatusCode = null;
      const old = new Map((node.Parameters || []).map(item => [item.Name, item]));
      node.Parameters = method ? method.Parameters.filter(schema => schema.Direction !== 'out').map(schema => ({
        Name: schema.Name,
        TypeName: schema.TypeName,
        Value: old.has(schema.Name) && String(old.get(schema.Name).Value || '').trim() !== ''
          ? old.get(schema.Name).Value : (schema.DefaultValue || ''),
        SourceNodeId: old.has(schema.Name) ? old.get(schema.Name).SourceNodeId || '' : '',
        SourceParameterName: old.has(schema.Name) ? old.get(schema.Name).SourceParameterName || '' : '',
      })) : [];
    } else if (field === 'NodeType') {
      node.NodeType = value;
      if (['Start', 'End'].includes(value)) {
        node.DisplayName = value === 'Start' ? '开始' : '结束';
        node.MethodId = '';
        node.MethodSchemaVersion = 0;
        node.MethodMachineName = '';
        node.MethodStationId = '';
        node.Parameters = [];
        clearInvalidNodeFields(node.NodeId);
      }
      if (value === 'Start') flow.EntryNodeId = node.NodeId;
    } else if (field === 'PendingStatusCode' || field === 'TimeoutMilliseconds') {
      const draftKey = nodeDraftKey(flow, node.NodeId, field);
      if (value.trim() === '') {
        node[field] = null;
        state.invalidFields.delete(draftKey);
        state.invalidDrafts.delete(draftKey);
        if (control) control.classList.remove('invalid');
      } else {
        if (!/^-?\d+$/.test(value.trim())) {
          state.invalidFields.add(draftKey);
          state.invalidDrafts.set(draftKey, value);
          if (control) control.classList.add('invalid');
          setStatus('状态码和超时必须是整数', 'error');
          return;
        }
        const parsed = Number(value.trim());
        if (!Number.isSafeInteger(parsed)
          || (field === 'TimeoutMilliseconds' && parsed <= 0)) {
          state.invalidFields.add(draftKey);
          state.invalidDrafts.set(draftKey, value);
          if (control) control.classList.add('invalid');
          setStatus(field === 'TimeoutMilliseconds' ? '超时必须为正整数' : '状态码超出整数范围', 'error');
          return;
        }
        node[field] = parsed;
        state.invalidFields.delete(draftKey);
        state.invalidDrafts.delete(draftKey);
        if (control) control.classList.remove('invalid');
      }
    } else {
      node[field] = value;
    }
    window.EquipmentFlowCanvas.synchronizeEntryNode(flow,
      field === 'NodeType' && value === 'Start' ? node.NodeId : '');
    saveLayout(flow);
    if (redraw) { canvasEditor.render(); return; }
    renderFlow();
    renderInspector();
  }

  function getNodeFieldValue(node, field) {
    const key = nodeDraftKey(currentFlow(), node.NodeId, field);
    return state.invalidDrafts.has(key) ? state.invalidDrafts.get(key) : node[field];
  }

  function clearInvalidNodeFields(nodeId) {
    clearFlowDrafts(state.invalidFields, state.invalidDrafts, currentFlow(), nodeId);
  }

  function updateParameter(name, value) {
    const node = selectedNode();
    const flow = currentFlow();
    const schema = methodFor(node)?.Parameters.find(item => item.Name === name);
    if (!flow || !node || !schema) return;
    canvasEditor.recordBefore();
    let parameter = node.Parameters.find(item => item.Name === name);
    if (!parameter) {
      parameter = { Name: name, TypeName: schema.TypeName, Value: '' };
      node.Parameters.push(parameter);
    }
    parameter.TypeName = schema.TypeName;
    const hadSource = Boolean(parameter.SourceNodeId || parameter.SourceParameterName);
    parameterBindings.setManualValue(parameter, value);
    if (hadSource) {
      const sourceControl = $$('[data-parameter-source]').find(control => control.dataset.parameterSource === name);
      if (sourceControl) sourceControl.value = '';
      redrawEdgesOnly();
    }
    saveLayout(flow);
  }

  function updateParameterSource(name, encodedSource) {
    const node = selectedNode();
    const flow = currentFlow();
    const schema = methodFor(node)?.Parameters.find(item => item.Name === name);
    if (!flow || !node || !schema) return;
    canvasEditor.recordBefore();
    let parameter = node.Parameters.find(item => item.Name === name);
    if (!parameter) {
      parameter = { Name: name, TypeName: schema.TypeName, Value: '' };
      node.Parameters.push(parameter);
    }
    if (encodedSource) {
      const [sourceNodeId, sourceParameterName] = JSON.parse(encodedSource);
      const sourceNode = flow.Nodes.find(item => item.NodeId === sourceNodeId);
      const sourceSchema = methodFor(sourceNode)?.Parameters.find(item => ['out', 'ref'].includes(item.Direction)
        && (item.Name === sourceParameterName || item.FlowName === sourceParameterName));
      if (!sourceSchema || sourceSchema.TypeName !== schema.TypeName) {
        setStatus(`数据类型不匹配：${sourceParameterName} 不能接入 ${name}`, 'error');
        renderInspector();
        return;
      }
      parameterBindings.setOutputSource(parameter, sourceNodeId, sourceParameterName);
      const valueControl = $$('[data-parameter]').find(control => control.dataset.parameter === name);
      if (valueControl) valueControl.value = '';
    } else {
      parameterBindings.clearOutputSource(parameter);
    }
    saveLayout(flow);
    renderFlow();
    renderInspector();
    setStatus(encodedSource ? `已绑定数据 ${parameter.SourceParameterName} → ${parameter.Name}` : `已清除 ${parameter.Name} 的数据来源`, 'normal');
  }

  function updateTransition(index, field, value) {
    const flow = currentFlow();
    if (!flow || !flow.Transitions[index]) return;
    canvasEditor.recordBefore();
    flow.Transitions[index][field] = field === 'Priority' ? Number.parseInt(value, 10) || 0 : value;
    saveLayout(flow);
    renderFlow();
    renderInspector();
  }

  function removeTransition(index) {
    const flow = currentFlow();
    if (!flow) return;
    canvasEditor.recordBefore();
    flow.Transitions.splice(index, 1);
    saveLayout(flow);
    renderFlow();
    renderInspector();
  }

  function addTransition() {
    const flow = currentFlow();
    const node = selectedNode();
    if (!flow || !node || node.NodeType === 'End') return;
    const outgoing = flow.Transitions.filter(item => item.FromNodeId === node.NodeId);
    const next = flow.Nodes.find(item => item.NodeId !== node.NodeId && item.NodeType === 'End')
      || flow.Nodes.find(item => item.NodeId !== node.NodeId && item.NodeType !== 'Start');
    if (!next) {
      setStatus('先添加一个后继节点，再创建分支', 'warning');
      return;
    }
    const used = new Set(outgoing.map(item => item.Outcome));
    const method = methodFor(node);
    const statuses = window.EquipmentFlowCanvas.outcomesFor(method, node);
    const pending = new Set(method && method.PendingStatusCodes ? method.PendingStatusCodes.map(String) : []);
    const nextRegisteredOutcome = statuses.map(String).find(value => !pending.has(value) && !used.has(value));
    if (statuses.length && !nextRegisteredOutcome) {
      setStatus('此方法已为全部返回状态添加分支', 'warning');
      return;
    }
    const outcome = nextRegisteredOutcome || (used.has('*') ? String(outgoing.length) : '*');
    const alarmCodes = new Set(method && method.AlarmStatusCodes ? method.AlarmStatusCodes.map(String) : []);
    const alarmNode = flow.Nodes.find(item => item.NodeType === 'Alarm');
    const target = alarmCodes.has(outcome) && alarmNode ? alarmNode : next;
    canvasEditor.recordBefore();
    flow.Transitions.push({ FromNodeId: node.NodeId, Outcome: outcome, ToNodeId: target.NodeId, Priority: outgoing.length + 1 });
    saveLayout(flow);
    renderFlow();
    renderInspector();
  }

  function assertApplicableMethod(method) {
    const flow = currentFlow();
    if (!flow) throw new Error('请先新建或导入 Task。');
    if (!method || method.CanBind === false) throw new Error(method && method.ContractIssue || '此方法不可绑定。');
    if (method.TaskId && method.TaskId !== flow.StationId) throw new Error(`方法 ${method.MethodName || method.MethodId} 属于其他 Task。`);
    if ((method.MachineName && method.MachineName !== state.workspace.MachineName)
      || (method.StationId && method.StationId !== flow.StationId))
      throw new Error(`方法 ${method.MethodName || method.MethodId} 不适用于当前 Task。`);
    return flow;
  }

  function insertionPoint(point) {
    const p = point || canvasEditor.centerPoint();
    return { x: Math.max(20, Math.round(p.x)), y: Math.max(20, Math.round(p.y)) };
  }

  function addMethodNode(method, dropPoint = null) {
    let flow;
    try { flow = assertApplicableMethod(method); }
    catch (error) { setStatus(error.message, 'warning'); return; }
    canvasEditor.recordBefore();
    const nodeId = nextNodeId(flow);
    flow.Nodes.push({ NodeId: nodeId,
      NodeType: methodLibrary.isAlarmMethod(method) ? 'Alarm' : method.ReturnType === 'bool' ? 'Condition' : 'Action',
      DisplayName: method.DisplayName || method.MethodId, MethodId: method.MethodId,
      MethodSchemaVersion: method.SchemaVersion, MethodMachineName: method.MachineName || '', MethodStationId: method.StationId || '',
      PendingStatusCode: method.PendingStatusCodes && method.PendingStatusCodes.length === 1 ? method.PendingStatusCodes[0] : null,
      TimeoutMilliseconds: null, FailurePolicy: 'Fault',
      Parameters: (method.Parameters || []).filter(schema => schema.Direction !== 'out').map(schema => ({ Name: schema.Name, TypeName: schema.TypeName, Value: schema.DefaultValue || '' })),
    });
    state.layout[nodeId] = insertionPoint(dropPoint);
    state.selectedNodeId = nodeId;
    state.activeInspector = 'node';
    saveLayout(flow);
    renderAll();
    setStatus(`已添加 ${method.DisplayName || method.MethodId}；从端口拖动连接分支`, 'normal');
  }

  function addStartNode(point = null) { addControlNode('Start', point); }
  function addEndNode(point = null) { addControlNode('End', point); }

  function addControlNode(type, point = null) {
    const flow = currentFlow();
    if (!flow) { setStatus('请先新增工站或导入流程。', 'warning'); return; }
    canvasEditor.recordBefore();
    const nodeId = nextNodeId(flow);
    const names = { Start: '开始', End: '结束', Action: '运行步骤', Condition: '条件判断', Wait: '等待条件', Alarm: '报警处理' };
    flow.Nodes.push({ NodeId: nodeId, NodeType: type, DisplayName: names[type] || type, MethodId: '',
      MethodSchemaVersion: 0, PendingStatusCode: null, TimeoutMilliseconds: null, FailurePolicy: 'Fault', Parameters: [] });
    const hasValidEntry = flow.Nodes.some(node => node.NodeType === 'Start' && node.NodeId === flow.EntryNodeId);
    window.EquipmentFlowCanvas.synchronizeEntryNode(flow, type === 'Start' && !hasValidEntry ? nodeId : '');
    state.layout[nodeId] = insertionPoint(point);
    state.selectedNodeId = nodeId;
    state.activeInspector = 'node';
    saveLayout(flow); renderAll();
    setStatus(`已添加${names[type] || type}；可自由放置并拖线连接`, 'normal');
  }

  function nextNodeId(flow) {
    let index = flow.Nodes.length + 1;
    let candidate;
    do { candidate = `N${String(index++).padStart(3, '0')}`; }
    while (flow.Nodes.some(node => node.NodeId === candidate));
    return candidate;
  }

  function deleteSelectedNode() { canvasEditor.deleteSelection(); }

  // Draw.io import/export: translate the canvas model while preserving Task node and branch IDs.
  function exportDrawio(download = true) {
    const flow = currentFlow();
    if (!flow) return;
    const xmlDocument = document.implementation.createDocument('', 'mxfile', null);
    const file = xmlDocument.documentElement;
    file.setAttribute('host', 'app.diagrams.net');
    file.setAttribute('compressed', 'false');
    file.setAttribute('pages', '1');
    const diagram = xmlDocument.createElement('diagram');
    diagram.setAttribute('id', safeId(flow.FlowId || flow.StationId));
    diagram.setAttribute('name', currentTask()?.ClassName || flow.FlowId || 'TaskFlow');
    file.appendChild(diagram);
    const model = xmlDocument.createElement('mxGraphModel');
    model.setAttribute('dx', '0');
    model.setAttribute('dy', '0');
    model.setAttribute('grid', '1');
    model.setAttribute('gridSize', '10');
    model.setAttribute('guides', '1');
    model.setAttribute('connect', '1');
    model.setAttribute('arrows', '1');
    model.setAttribute('page', '1');
    model.setAttribute('pageWidth', '1169');
    model.setAttribute('pageHeight', '827');
    diagram.appendChild(model);
    const root = xmlDocument.createElement('root');
    model.appendChild(root);
    const rootCell = xmlDocument.createElement('mxCell');
    rootCell.setAttribute('id', '0');
    root.appendChild(rootCell);
    const layer = xmlDocument.createElement('mxCell');
    layer.setAttribute('id', '1');
    layer.setAttribute('parent', '0');
    root.appendChild(layer);

    flow.Nodes.forEach(node => {
      const point = state.layout[node.NodeId] || { x: 45, y: 68 };
      const object = xmlDocument.createElement('object');
      object.setAttribute('id', node.NodeId);
      object.setAttribute('label', node.DisplayName || node.NodeId);
      object.setAttribute('FlowNodeType', node.NodeType || 'Action');
      object.setAttribute('MethodId', node.MethodId || '');
      object.setAttribute('MethodSchemaVersion', String(node.MethodSchemaVersion || 0));
      if (Object.prototype.hasOwnProperty.call(node, 'MethodMachineName')
        || Object.prototype.hasOwnProperty.call(node, 'MethodStationId')) {
        object.setAttribute('MethodMachineName', node.MethodMachineName || '');
        object.setAttribute('MethodStationId', node.MethodStationId || '');
      }
      object.setAttribute('PendingStatusCode', node.PendingStatusCode == null ? '' : String(node.PendingStatusCode));
      object.setAttribute('TimeoutMs', node.TimeoutMilliseconds == null ? '' : String(node.TimeoutMilliseconds));
      object.setAttribute('FailurePolicy', node.FailurePolicy || '');
      object.setAttribute('ParametersJson', JSON.stringify(node.Parameters || []));
      const cell = xmlDocument.createElement('mxCell');
      const shape = ({ Start: 'ellipse', End: 'ellipse', Condition: 'rhombus', Alarm: 'hexagon',
        Wait: 'mxgraph.flowchart.delay' })[node.NodeType] || 'rectangle';
      const fill = node.NodeType === 'Start' ? '#d9f1eb' : node.NodeType === 'End' ? '#e0e7eb' : '#fff0d8';
      const stroke = node.NodeType === 'Start' ? '#4bc6ae' : node.NodeType === 'End' ? '#82939c' : '#e6a04c';
      cell.setAttribute('style', `shape=${shape};whiteSpace=wrap;html=1;fillColor=${fill};strokeColor=${stroke};fontColor=#24313a;`);
      cell.setAttribute('vertex', '1');
      cell.setAttribute('parent', '1');
      object.appendChild(cell);
      const geometry = xmlDocument.createElement('mxGeometry');
      geometry.setAttribute('x', String(Math.round(point.x)));
      geometry.setAttribute('y', String(Math.round(point.y)));
      const size = window.EquipmentFlowCanvas.nodeSize(node);
      geometry.setAttribute('width', String(size.width));
      geometry.setAttribute('height', String(size.height));
      geometry.setAttribute('as', 'geometry');
      cell.appendChild(geometry);
      root.appendChild(object);
    });

    const visibleRoutes = window.EquipmentFlowCanvas.transitionRoutes(flow, state.layout);
    flow.Transitions.forEach((transition, index) => {
      const edge = xmlDocument.createElement('mxCell');
      edge.setAttribute('id', `edge_${index + 1}`);
      edge.setAttribute('value', transition.Outcome || '*');
      edge.setAttribute('Outcome', transition.Outcome || '*');
      edge.setAttribute('Priority', String(transition.Priority == null ? index + 1 : transition.Priority));
      edge.setAttribute('edge', '1');
      edge.setAttribute('parent', '1');
      edge.setAttribute('source', transition.FromNodeId);
      edge.setAttribute('target', transition.ToNodeId);
      const portStyle = (side, value, prefix) => {
        const ratio = Number.isFinite(value) ? value : .5;
        const point = ({ n: [ratio, 0], s: [ratio, 1], e: [1, ratio], w: [0, ratio] })[side] || [ratio, 1];
        return `${prefix}X=${point[0]};${prefix}Y=${point[1]};${prefix}Perimeter=1;`;
      };
      edge.setAttribute('style', 'edgeStyle=orthogonalEdgeStyle;rounded=0;html=1;endArrow=block;endFill=1;strokeColor=#728590;fontColor=#35434b;'
        + portStyle(transition.CanvasSourcePort || 's', transition.CanvasSourceRatio, 'exit')
        + portStyle(transition.CanvasTargetPort || 'n', transition.CanvasTargetRatio, 'entry'));
      ['CanvasSourcePort', 'CanvasTargetPort', 'CanvasSourceRatio', 'CanvasTargetRatio', 'CanvasBendX', 'CanvasBendY',
        'CanvasRouteOrientation', 'CanvasMergeLaneX', 'CanvasMergeJoinY', 'CanvasMergeBranchY', 'CanvasWaypoints', 'CanvasMergeWaypoints',
        'CanvasMergeLaneAnchors'].forEach(key => {
        if (transition[key] != null) edge.setAttribute(key, typeof transition[key] === 'object'
          ? JSON.stringify(transition[key]) : String(transition[key]));
      });
      const geometry = xmlDocument.createElement('mxGeometry');
      geometry.setAttribute('relative', '1');
      geometry.setAttribute('as', 'geometry');
      const route = (visibleRoutes[index]?.points || window.EquipmentFlowCanvas.routePoints(transition, flow.Nodes, state.layout)).slice(1, -1);
      const waypoints = xmlDocument.createElement('Array');
      waypoints.setAttribute('as', 'points');
      route.forEach(point => {
        const waypoint = xmlDocument.createElement('mxPoint');
        waypoint.setAttribute('x', String(point.x)); waypoint.setAttribute('y', String(point.y));
        waypoints.appendChild(waypoint);
      });
      geometry.appendChild(waypoints);
      edge.setAttribute('FlowRoutePoints', JSON.stringify(route));
      edge.appendChild(geometry);
      root.appendChild(edge);
    });

    const xml = new XMLSerializer().serializeToString(xmlDocument);
    const name = `${safeFileName(currentTask()?.ClassName || 'Task')}.drawio`;
    if (download !== false) {
      downloadText(xml, name, 'application/xml;charset=utf-8');
      setStatus('Draw.io 文件已导出；在 Draw.io 修改后可重新导入', 'normal');
    }
    return xml;
  }

  async function importDrawio(file) {
    const flow = currentFlow();
    if (!flow || !file) return;
    try {
      const input = await file.text();
      const parsed = new DOMParser().parseFromString(input, 'application/xml');
      if (parsed.querySelector('parsererror')) throw new Error('Draw.io XML 格式无法解析。');
      let models = Array.from(parsed.getElementsByTagName('mxGraphModel'));
      if (!models.length) {
        const diagrams = Array.from(parsed.getElementsByTagName('diagram'));
      const taskName = currentTask()?.ClassName || flow.TaskName;
      const diagram = diagrams.find(item => item.getAttribute('name') === taskName)
          || diagrams.find(item => item.getAttribute('name') === flow.StationId)
          || diagrams.find(item => item.getAttribute('id') === flow.FlowId)
          || diagrams[0];
        if (!diagram) throw new Error('文件中没有可导入的流程图页面。');
        const compressed = (diagram.textContent || '').trim();
        if (!compressed) throw new Error('流程图页面内容为空。');
        const modelXml = compressed.startsWith('<mxGraphModel')
          ? compressed
          : await decompressDrawioPage(compressed);
        const modelDocument = new DOMParser().parseFromString(modelXml, 'application/xml');
        if (modelDocument.querySelector('parsererror')) throw new Error('Draw.io 页面 XML 解码失败。');
        models = Array.from(modelDocument.getElementsByTagName('mxGraphModel'));
      }
      const model = models.find(item => item.parentNode && item.parentNode.getAttribute('name') === taskName)
        || models[0];
      const graphRoot = model && model.getElementsByTagName('root')[0];
      if (!graphRoot) throw new Error('流程图缺少 mxGraphModel/root 节点。');

      const candidateCells = Array.from(graphRoot.children);
      const newNodes = [];
      const geometryByNode = {};
      candidateCells.forEach(element => {
        const cell = element.tagName === 'mxCell' ? element : element.getElementsByTagName('mxCell')[0];
        if (!cell || cell.getAttribute('vertex') !== '1') return;
        const id = element.getAttribute('id') || cell.getAttribute('id');
        if (!id || id === '0' || id === '1') return;
        const nodeType = getAttribute(element, cell, ['FlowNodeType', 'NodeType', 'Kind'])
          || inferNodeType(getAttribute(element, cell, ['label', 'value']) || cell.getAttribute('value'), cell.getAttribute('style'));
        const methodId = getAttribute(element, cell, ['MethodId']) || '';
        const schemaVersion = parseInt(getAttribute(element, cell, ['MethodSchemaVersion']) || '0', 10) || 0;
        const methodMachineName = getAttribute(element, cell, ['MethodMachineName']) || '';
        const methodStationId = getAttribute(element, cell, ['MethodStationId']) || '';
        const hasMethodScope = hasAttribute(element, cell, ['MethodMachineName', 'MethodStationId']);
        const selection = hasMethodScope
          ? methodLibrary.methodSelectionValue({ MethodId: methodId, SchemaVersion: schemaVersion,
            MachineName: methodMachineName, StationId: methodStationId })
          : JSON.stringify([methodId, schemaVersion]);
        const method = methodLibrary.resolveMethodSelection(applicableMethods(flow), selection);
        const parametersText = getAttribute(element, cell, ['ParametersJson']);
        let parameters = [];
        if (parametersText) {
          try { parameters = JSON.parse(parametersText); } catch (_) { parameters = []; }
        }
        if (!parameters.length && method) {
          parameters = method.Parameters.filter(item => item.Direction !== 'out')
            .map(item => ({ Name: item.Name, TypeName: item.TypeName, Value: item.DefaultValue || '' }));
        }
        const geometry = cell.getElementsByTagName('mxGeometry')[0];
        const displayName = getAttribute(element, cell, ['label', 'value']) || id;
        const importedNode = {
          NodeId: id,
          NodeType: nodeType,
          DisplayName: displayName,
          MethodId: methodId,
          MethodSchemaVersion: schemaVersion || (method ? method.SchemaVersion : 0),
          PendingStatusCode: parseOptionalInteger(getAttribute(element, cell, ['PendingStatusCode'])),
          TimeoutMilliseconds: parseOptionalInteger(getAttribute(element, cell, ['TimeoutMs', 'TimeoutMilliseconds'])),
          FailurePolicy: getAttribute(element, cell, ['FailurePolicy']) || (nodeType === 'Start' || nodeType === 'End' ? '' : 'Fault'),
          Parameters: Array.isArray(parameters) ? parameters : [],
        };
        if (hasMethodScope) {
          importedNode.MethodMachineName = methodMachineName;
          importedNode.MethodStationId = methodStationId;
        }
        newNodes.push(importedNode);
        const width = finiteAttribute(geometry, 'width'), height = finiteAttribute(geometry, 'height');
        if (width != null) importedNode.CanvasWidth = width;
        if (height != null) importedNode.CanvasHeight = height;
        const size = window.EquipmentFlowCanvas.nodeSize(importedNode);
        importedNode.CanvasWidth = size.width; importedNode.CanvasHeight = size.height;
        geometryByNode[id] = {
          x: finiteAttribute(geometry, 'x') ?? 45,
          y: finiteAttribute(geometry, 'y') ?? 68,
        };
      });
      if (!newNodes.length) throw new Error('没有识别到流程节点。请使用从本页面导出的 Draw.io 文件作为模板。');

      const nodeIds = new Set(newNodes.map(node => node.NodeId));
      const newTransitions = [];
      const importedRoutes = [];
      let restoredRoutes = 0;
      candidateCells.forEach((element, index) => {
        const cell = element.tagName === 'mxCell' ? element : element.getElementsByTagName('mxCell')[0];
        if (!cell || cell.getAttribute('edge') !== '1') return;
        const fromNodeId = cell.getAttribute('source');
        const toNodeId = cell.getAttribute('target');
        if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) return;
        const transition = {
          FromNodeId: fromNodeId,
          Outcome: getAttribute(element, cell, ['Outcome', 'value']) || '*',
          ToNodeId: toNodeId,
          Priority: parseOptionalInteger(getAttribute(element, cell, ['Priority'])) ?? newTransitions.length + 1,
        };
        for (const [prefix, end, fallback] of [['exit', 'Source', 's'], ['entry', 'Target', 'n']]) {
          const declaredSide = getAttribute(element, cell, [`Canvas${end}Port`]);
          const port = readDrawioPort(cell, prefix, declaredSide);
          transition[`Canvas${end}Port`] = port?.side || (['n', 'e', 's', 'w'].includes(declaredSide) ? declaredSide : fallback);
          transition[`Canvas${end}Ratio`] = port?.ratio ?? finiteAttribute(cell, `Canvas${end}Ratio`) ?? .5;
        }
        ['CanvasBendX', 'CanvasBendY'].forEach(key => {
          const value = finiteAttribute(cell, key);
          if (value != null) transition[key] = value;
        });
        ['CanvasMergeLaneX', 'CanvasMergeJoinY', 'CanvasMergeBranchY'].forEach(key => {
          const value = finiteAttribute(cell, key);
          if (value != null) transition[key] = value;
        });
        transition.CanvasRouteOrientation = getAttribute(element, cell, ['CanvasRouteOrientation']) || '';
        ['CanvasWaypoints', 'CanvasMergeWaypoints', 'CanvasMergeLaneAnchors'].forEach(key => {
          const value = getAttribute(element, cell, [key]);
          if (!value) return;
          try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) transition[key] = parsed;
          } catch (_) { /* Ignore malformed optional route metadata. */ }
        });
        const geometry = cell.getElementsByTagName('mxGeometry')[0];
        const points = geometry ? Array.from(geometry.getElementsByTagName('mxPoint')).map(point => ({
          x: finiteAttribute(point, 'x'), y: finiteAttribute(point, 'y'),
        })).filter(point => point.x != null && point.y != null) : [];
        let baseline = null;
        try { baseline = JSON.parse(getAttribute(element, cell, ['FlowRoutePoints']) || 'null'); } catch (_) { baseline = null; }
        const samePoints = Array.isArray(baseline) && baseline.length === points.length
          && baseline.every((point, pointIndex) => Number(point.x) === points[pointIndex].x && Number(point.y) === points[pointIndex].y);
        const changed = Boolean(points.length && !samePoints);
        if (changed) {
          // The first and last geometry points are the fixed source and target
          // leads. Keep every edited corner between them as a route waypoint.
          const body = points.slice(1, -1);
          if (body.length) {
            let previous = points[0];
            transition.CanvasWaypoints = body.map(point => {
              const orientation = Math.abs(previous.y - point.y) < .1 ? 'h'
                : Math.abs(previous.x - point.x) < .1 ? 'v' : 'v';
              previous = point;
              return { x: point.x, y: point.y, orientation };
            });
            const targetLead = points[points.length - 1];
            const last = body[body.length - 1];
            transition.CanvasRouteOrientation = Math.abs(last.y - targetLead.y) < .1 ? 'h'
              : Math.abs(last.x - targetLead.x) < .1 ? 'v' : 'v';
            delete transition.CanvasBendX; delete transition.CanvasBendY;
            restoredRoutes++;
          }
        }
        newTransitions.push(transition);
        importedRoutes.push({ transition, points, changed });
      });

      const transitionGroups = new Map();
      newTransitions.forEach(transition => {
        const key = String(transition.ToNodeId);
        if (!transitionGroups.has(key)) transitionGroups.set(key, []);
        transitionGroups.get(key).push(transition);
      });
      transitionGroups.forEach(group => {
        if (group.length < 2 || new Set(group.map(edge => edge.FromNodeId)).size < 2
          || !group.some(edge => importedRoutes.find(route => route.transition === edge)?.changed)) return;
        const groupIds = new Set(group);
        const geometryRoutes = importedRoutes.filter(route => groupIds.has(route.transition) && route.points.length > 2);
        const targetNode = newNodes.find(node => node.NodeId === group[0].ToNodeId);
        const targetPosition = geometryByNode[group[0].ToNodeId];
        const targetCenterX = targetNode && targetPosition
          ? targetPosition.x + window.EquipmentFlowCanvas.nodeSize(targetNode).width / 2 : 0;
        const counts = new Map();
        geometryRoutes.forEach(route => {
          const candidates = new Set();
          route.points.slice(1).forEach((point, index) => {
            const previous = route.points[index];
            if (Math.abs(point.x - previous.x) < .1 && Math.abs(point.y - previous.y) > 1) candidates.add(point.x);
          });
          candidates.forEach(x => counts.set(x, (counts.get(x) || 0) + 1));
        });
        const lane = [...counts.entries()].filter(([, count]) => count >= 2)
          .sort((a, b) => b[1] - a[1] || Math.abs(b[0] - targetCenterX) - Math.abs(a[0] - targetCenterX))[0]?.[0];
        if (!Number.isFinite(lane)) return;
        group.forEach(edge => { edge.CanvasMergeLaneX = lane; });
        geometryRoutes.filter(route => route.changed).forEach(route => {
          const laneEntry = route.points.findIndex((point, index) => index > 0 && Math.abs(point.x - lane) < .1
            && Math.abs(route.points[index - 1].x - lane) >= .1);
          if (laneEntry < 0) return;
          const body = route.points.slice(1, laneEntry);
          if (body.length) {
            let previous = route.points[0];
            route.transition.CanvasMergeWaypoints = body.map(point => {
              const orientation = Math.abs(previous.y - point.y) < .1 ? 'h'
                : Math.abs(previous.x - point.x) < .1 ? 'v' : 'v';
              previous = point;
              return { x: point.x, y: point.y, orientation };
            });
            route.transition.CanvasMergeBranchY = body[body.length - 1].y;
          } else route.transition.CanvasMergeBranchY = route.points[laneEntry].y;
          delete route.transition.CanvasWaypoints;
        });
      });

      canvasEditor.reset();
      flow.Nodes = newNodes;
      flow.Transitions = newTransitions;
      flow.EntryNodeId = (newNodes.find(node => node.NodeType === 'Start') || {}).NodeId || '';
      state.layout = geometryByNode;
      state.selectedNodeId = null;
      saveLayout(flow);
      renderAll();
      closeDiagnostics();
      setStatus(`已导入 ${file.name}；请校验方法绑定和状态分支${restoredRoutes ? `；已保留 ${restoredRoutes} 条调整后的完整折线路由` : ''}`, 'warning');
      return flow;
    } catch (error) {
      setStatus(`Draw.io 导入失败：${error.message}`, 'error');
      showResult({ Success: false, Message: error.message, Diagnostics: [error.message] }, false);
    }
  }

  async function decompressDrawioPage(base64) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前 WebView2 不支持压缩 Draw.io 文件；请在 Draw.io 中关闭压缩后重新保存。');
    }
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const decoded = new TextDecoder().decode(await new Response(stream).arrayBuffer());
    return decodeURIComponent(decoded);
  }

  function getAttribute(element, cell, names) {
    for (const name of names) {
      const value = element.getAttribute && element.getAttribute(name);
      if (value != null && value !== '') return value;
      const cellValue = cell && cell.getAttribute(name);
      if (cellValue != null && cellValue !== '') return cellValue;
    }
    return '';
  }

  function hasAttribute(element, cell, names) {
    return names.some(name => (element && element.hasAttribute && element.hasAttribute(name))
      || (cell && cell.hasAttribute && cell.hasAttribute(name)));
  }

  function finiteAttribute(element, name) {
    const value = element && element.getAttribute(name);
    if (value == null || String(value).trim() === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function readDrawioPort(cell, prefix, preferredSide) {
    const style = Object.fromEntries(String(cell.getAttribute('style') || '').split(';').map(part => part.split('=')));
    if (style[`${prefix}X`] == null || style[`${prefix}Y`] == null) return null;
    const x = Number(style[`${prefix}X`]), y = Number(style[`${prefix}Y`]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) return null;
    if ((preferredSide === 'w' && x === 0) || (preferredSide === 'e' && x === 1)) return { side: preferredSide, ratio: y };
    if ((preferredSide === 'n' && y === 0) || (preferredSide === 's' && y === 1)) return { side: preferredSide, ratio: x };
    if (y === 0 || y === 1) return { side: y === 0 ? 'n' : 's', ratio: x };
    if (x === 0 || x === 1) return { side: x === 0 ? 'w' : 'e', ratio: y };
    return null;
  }

  function inferNodeType(value, style = '') {
    const normalized = (value || '').trim().toLowerCase();
    if (normalized === 'start' || normalized === '入口' || normalized === '开始') return 'Start';
    if (normalized === 'end' || normalized === '结束' || normalized === '完成') return 'End';
    if (/(?:^|;)shape=rhombus(?:;|$)|(?:^|;)rhombus(?:;|$)/.test(style)) return 'Condition';
    if (/(?:^|;)shape=hexagon(?:;|$)/.test(style)) return 'Alarm';
    if (/(?:^|;)shape=mxgraph\.flowchart\.delay(?:;|$)/.test(style)) return 'Wait';
    return 'Action';
  }

  function parseOptionalInteger(value) {
    if (value == null || String(value).trim() === '') return null;
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) ? number : null;
  }

  function safeId(value) {
    return String(value || 'flow').replace(/[^a-zA-Z0-9_.-]/g, '_');
  }

  function safeFileName(value) {
    return String(value || 'TaskProject').replace(/[\\/:*?"<>|]/g, '_');
  }

  function downloadText(content, fileName, mimeType) {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // Hardware catalog: resource typing, Task bindings, factory declarations, and hardware partials.
  function hardwareCategory(type, name = '') {
    const source = (String(type || '') + ' ' + String(name || '')).toLowerCase();
    if (/maxis|axis|轴/u.test(source)) return 'axis';
    if (/cylind|cylinder|气缸/u.test(source)) return 'cylinder';
    if (/sorb|suck|suction|真空吸|吸附/u.test(source)) return 'vacuum';
    if (/inno|input|sensor|传感器|输入/u.test(source)) return 'sensor';
    if (/outno|output|输出/u.test(source)) return 'output';
    return 'other';
  }

  function hardwareTypeLabel(type, name = '') {
    return ({ axis: '轴', sensor: '传感器', cylinder: '气缸', vacuum: '真空吸', output: '输出', other: '其他硬件' })[hardwareCategory(type, name)];
  }

  function hardwareSlotCategory(type, name = '') {
    const source = `${String(type || '')} ${String(name || '')}`.toLowerCase();
    if (/maxis|axis|轴/u.test(source)) return 'axis';
    if (/outno|output|输出/u.test(source)) return 'output';
    if (/inno|input|sensor|传感器|输入/u.test(source)) return 'input';
    return 'other';
  }

  function hardwareCounts(resources, factories) {
    const count = type => resources.filter(item => type.includes(String(item.ResourceType).toLowerCase())).length;
    const known = factories.reduce((sum, factory) => sum + (Number.isFinite(factory.Count) ? factory.Count : 0), 0);
    const dynamic = factories.some(factory => factory.Count == null || factory.IsDynamic);
    return { nozzles: factories.length ? (dynamic ? known ? `${known} + 动态` : '动态' : String(known)) : '未声明',
      inputs: count(['inno', 'input']), axes: count(['maxis', 'axis', 'axischannel']), outputs: count(['outno', 'output']) };
  }

  const HARDWARE_TYPE_LABELS = { Nozzle: '吸嘴', Axis: '轴', Sensor: '传感器', Cylinder: '气缸', Temperature: '温度', Pressure: '压力', Vacuum: '真空吸' };
  const NOZZLE_COMPONENTS = ['Axis', 'Sensor', 'Cylinder', 'Temperature', 'Pressure', 'Vacuum'];
  const LEGACY_NOZZLE_SLOT_IDS = {
    Axis: { Axis: ['Axis'] },
    Sensor: { Input: ['SensorInput', 'Sensor'] },
    Cylinder: { MovingInput: ['CylinderMovingInput'], HomeInput: ['CylinderHomeInput'], MovingOutput: ['CylinderMovingOutput'], HomeOutput: ['CylinderHomeOutput'] },
    Temperature: { Input: ['TemperatureInput'] },
    Pressure: { Input: ['PressureInput'] },
    Vacuum: { Input: ['VacuumInput'], SuctionOutput: ['VacuumOutput'], BreakOutput: ['VacuumBreakOutput'] },
  };

  function hardwareSlotSpecs(type) {
    const specs = [];
    const add = (slotId, propertyName, displayName, category) => specs.push({ SlotId: slotId, PropertyName: propertyName, DisplayName: displayName, Category: category, Binding: null });
    const cylinder = prefix => {
      add(`${prefix}MovingInput`, `${prefix}MovingInput`, '动点到位输入', 'input');
      add(`${prefix}HomeInput`, `${prefix}HomeInput`, '原点到位输入', 'input');
      add(`${prefix}MovingOutput`, `${prefix}MovingOutput`, '动点输出', 'output');
      add(`${prefix}HomeOutput`, `${prefix}HomeOutput`, '原点输出', 'output');
    };
    if (type === 'Axis') add('Axis', 'Axis', '轴', 'axis');
    else if (type === 'Sensor') add('Input', 'Input', '传感器输入', 'input');
    else if (type === 'Cylinder') cylinder('');
    else if (type === 'Temperature') add('Input', 'Input', '温度输入', 'input');
    else if (type === 'Pressure') add('Input', 'Input', '压力输入', 'input');
    else if (type === 'Vacuum') {
      add('Input', 'Input', '真空到位输入', 'input');
      add('SuctionOutput', 'SuctionOutput', '真空吸输出', 'output');
      add('BreakOutput', 'BreakOutput', '真空破输出', 'output');
    }
    return specs;
  }

  function nozzlePartSlotSpecs(type, partId, name) {
    const specs = [];
    const add = (suffix, propertySuffix, displayName, category) => specs.push({
      SlotId: `${partId}.${suffix}`, ComponentId: partId, ComponentType: type,
      PropertyName: type === 'Axis' ? name : `${name}${propertySuffix}`,
      DisplayName: displayName, Category: category, Binding: null,
    });
    if (type === 'Axis') add('Axis', '', '吸嘴轴', 'axis');
    else if (type === 'Sensor') add('Input', 'Input', '传感器输入', 'input');
    else if (type === 'Cylinder') {
      add('MovingInput', 'MovingInput', '动点到位输入', 'input');
      add('HomeInput', 'HomeInput', '原点到位输入', 'input');
      add('MovingOutput', 'MovingOutput', '动点输出', 'output');
      add('HomeOutput', 'HomeOutput', '原点输出', 'output');
    } else if (type === 'Temperature') add('Input', 'Input', '温度输入', 'input');
    else if (type === 'Pressure') add('Input', 'Input', '压力输入', 'input');
    else if (type === 'Vacuum') {
      add('Input', 'Input', '真空到位输入', 'input');
      add('SuctionOutput', 'SuctionOutput', '真空吸输出', 'output');
      add('BreakOutput', 'BreakOutput', '真空破输出', 'output');
    }
    return specs;
  }

  function createNozzlePart(type, name = '') {
    const partId = `part_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    if (!name) {
      const base = type;
      name = base;
      for (let suffix = 2; hardwareDialogParts.some(part => String(part.Name || '').toLowerCase() === name.toLowerCase()); suffix++) name = `${base}${suffix}`;
    }
    return { PartId: partId, Type: type, Name: name, Slots: nozzlePartSlotSpecs(type, partId, name) };
  }

  function inferLegacyNozzleSlotType(slot) {
    const id = String(slot.SlotId || slot.PropertyName || '');
    if (id === 'Axis') return 'Axis';
    if (id === 'SensorInput') return 'Sensor';
    if (id.startsWith('Cylinder')) return 'Cylinder';
    if (id === 'TemperatureInput') return 'Temperature';
    if (id === 'PressureInput') return 'Pressure';
    if (id.startsWith('Vacuum')) return 'Vacuum';
    return '';
  }

  function nozzlePartsFromDefinition(definition) {
    const legacySlots = Array.isArray(definition.Slots) ? definition.Slots : [];
    const parts = Array.isArray(definition.Parts) ? JSON.parse(JSON.stringify(definition.Parts)) : [];
    parts.forEach(part => {
      if (!NOZZLE_COMPONENTS.includes(part.Type)) return;
      part.PartId ||= `part_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
      part.Name ||= part.Type;
      if (!Array.isArray(part.Slots) || !part.Slots.length)
        part.Slots = nozzlePartSlotSpecs(part.Type, part.PartId, part.Name);
    });
    const componentTypes = new Set((definition.Components || []).filter(type => NOZZLE_COMPONENTS.includes(type)));
    legacySlots.forEach(slot => {
      const inferred = inferLegacyNozzleSlotType(slot);
      if (inferred) componentTypes.add(inferred);
    });
    if (!parts.length) NOZZLE_COMPONENTS.filter(type => componentTypes.has(type))
      .forEach(type => parts.push(createNozzlePart(type, type)));
    // Older projects may contain Parts descriptors and authoritative Slots side by side.
    // Merge every legacy slot before opening the dialog so saving cannot discard bindings.
    legacySlots.forEach(previous => {
      let slot = parts.flatMap(part => part.Slots || []).find(item =>
        item.SlotId === previous.SlotId || item.PropertyName === previous.PropertyName);
      if (!slot) {
        const type = inferLegacyNozzleSlotType(previous)
          || (previous.Category === 'axis' ? 'Axis' : previous.Category === 'output' ? 'Vacuum' : 'Sensor');
        let part = parts.find(item => item.Type === type);
        if (!part) { part = createNozzlePart(type, type); parts.push(part); }
        const suffix = Object.entries(LEGACY_NOZZLE_SLOT_IDS[type] || {}).find(([, ids]) =>
          ids.includes(previous.SlotId) || ids.includes(previous.PropertyName))?.[0];
        slot = (part.Slots || []).find(item => item.SlotId.endsWith('.' + suffix));
        if (!slot) {
          slot = {
            ...JSON.parse(JSON.stringify(previous)),
            SlotId: `${part.PartId}.${suffix || String(previous.SlotId || previous.PropertyName)}`,
            ComponentId: part.PartId, ComponentType: type,
          };
          part.Slots ||= [];
          part.Slots.push(slot);
        }
      }
      slot.PropertyName = previous.PropertyName || slot.PropertyName;
      if (Object.prototype.hasOwnProperty.call(previous, 'Binding'))
        slot.Binding = previous.Binding ? JSON.parse(JSON.stringify(previous.Binding)) : null;
    });
    return parts;
  }

  function nozzlePartsForDefinition(definition) {
    if (Array.isArray(definition.Nozzles) && definition.Nozzles.length)
      return definition.Nozzles.flatMap(nozzle => nozzlePartsFromDefinition(nozzle));
    return nozzlePartsFromDefinition(definition);
  }

  function enumBindingResources() {
    const workbook = state.workspace?.EnumWorkbooks?.[0];
    if (!workbook) return [];
    const resources = [];
    (workbook.Sheets || []).forEach(sheet => {
      const category = ({ Axis: 'axis', Input: 'input', Output: 'output' })[sheet.Type];
      if (!category) return;
      (sheet.Rows || []).forEach(row => {
        if (!row.Name) return;
        resources.push({
          ResourceKey: `enum::${sheet.SheetId}::${row.Name}`,
          ResourceId: `${sheet.Name}.${row.Name}`,
          ResourceType: sheet.Name,
          Category: category,
          EnumTypeName: sheet.Name,
          MemberName: row.Name,
          Name: row.Name,
          Comment: row.Comment || '',
          Value: row.Value == null ? '' : row.Value,
          GroupName: sheet.Name,
          SourceFile: workbook.FileName || '工程枚举',
          SheetId: sheet.SheetId,
        });
      });
    });
    return resources;
  }

  function hardwareBindingResources() {
    const imported = (state.workspace?.HardwareCatalogResources || []).map(resource => ({
      ...resource, Category: hardwareSlotCategory(resource.ResourceType, resource.Name || resource.ResourceId),
      EnumTypeName: resource.GroupName || String(resource.ResourceType || ''), MemberName: resource.Name,
    }));
    return [...imported, ...enumBindingResources()];
  }

  function selectedNozzleFilters() {
    return Array.from($('#hardwareNozzleFilters').querySelectorAll('input[type="checkbox"]:checked')).map(input => input.value);
  }

  function addNozzleComponent(type) {
    if (!NOZZLE_COMPONENTS.includes(type)) return;
    const currentFilters = new Set(selectedNozzleFilters());
    if (currentFilters.size && !currentFilters.has(type)) {
      const filter = $('#hardwareNozzleFilters').querySelector(`input[value="${type}"]`);
      if (filter) filter.checked = true;
    }
    hardwareDialogParts.push(createNozzlePart(type));
    renderHardwareDialog();
  }

  function createDialogNozzle(name = '') {
    let next = 1;
    while (!name && hardwareDialogNozzles.some(nozzle => String(nozzle.Name).toLowerCase() === `nozzle${next}`.toLowerCase())) next++;
    return {
      NozzleId: `nozzle_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      Name: name || `Nozzle${next}`,
      Parts: [],
    };
  }

  function nozzleInstancesFromDefinition(definition) {
    if (Array.isArray(definition?.Nozzles) && definition.Nozzles.length) {
      return JSON.parse(JSON.stringify(definition.Nozzles)).map((nozzle, index) => ({
        ...nozzle,
        NozzleId: nozzle.NozzleId || `saved_nozzle_${index + 1}`,
        Name: nozzle.Name || `Nozzle${index + 1}`,
        Parts: nozzlePartsFromDefinition(nozzle),
      }));
    }
    const nozzle = createDialogNozzle('Nozzle1');
    nozzle.Parts = definition?.Type === 'Nozzle' ? nozzlePartsFromDefinition(definition) : [];
    return [nozzle];
  }

  function selectedDialogNozzle() {
    return hardwareDialogNozzles.find(nozzle => nozzle.NozzleId === selectedHardwareNozzleId) || hardwareDialogNozzles[0] || null;
  }

  function selectDialogNozzle(nozzleId) {
    const nozzle = hardwareDialogNozzles.find(item => item.NozzleId === nozzleId);
    if (!nozzle) return;
    selectedHardwareNozzleId = nozzle.NozzleId;
    hardwareDialogParts = nozzle.Parts;
    renderHardwareDialog();
  }

  function copyFirstNozzleConfiguration() {
    const source = hardwareDialogNozzles[0];
    const target = selectedDialogNozzle();
    if (!source || !target || source === target) return;
    target.Parts = (source.Parts || []).map(part => {
      const cloned = JSON.parse(JSON.stringify(part));
      const nextId = `part_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      cloned.PartId = nextId;
      cloned.Slots = (cloned.Slots || []).map(slot => ({
        ...slot,
        SlotId: `${nextId}.${String(slot.SlotId).split('.').pop()}`,
        ComponentId: nextId,
      }));
      return cloned;
    });
    hardwareDialogParts = target.Parts;
    renderHardwareDialog();
    setStatus(`已将 ${source.Name} 的组件和绑定复制到 ${target.Name}，后续修改互不影响。`, 'normal');
  }

  function renderHardwareNozzleSelector() {
    const list = $('#hardware-nozzle-list');
    const current = selectedDialogNozzle();
    list.innerHTML = hardwareDialogNozzles.map((nozzle, index) =>
      `<button type="button" class="hardware-nozzle-item${nozzle === current ? ' is-active' : ''}" data-select-hardware-nozzle="${esc(nozzle.NozzleId)}" aria-pressed="${nozzle === current}"><strong>${esc(nozzle.Name)}</strong><small>${index + 1} · ${(nozzle.Parts || []).length} 个部件</small></button>`
    ).join('');
    list.querySelectorAll('[data-select-hardware-nozzle]').forEach(button =>
      button.addEventListener('click', () => selectDialogNozzle(button.dataset.selectHardwareNozzle)));
    $('#hardware-selected-nozzle-label').textContent = current?.Name || '吸嘴';
    $('#hardware-copy-nozzle-config').disabled = !current || current === hardwareDialogNozzles[0];
    $('#hardware-remove-nozzle').disabled = hardwareDialogNozzles.length <= 1;
  }

  function renderHardwareVariables() {
    const list = $('#hardware-common-variables-list');
    const typeOptions = ['bool', 'int', 'string', 'long', 'float', 'double', 'decimal'];
    list.innerHTML = hardwareDialogVariables.map(variable =>
      `<article class="hardware-common-variable-row" data-hardware-variable="${esc(variable.VariableId)}">
        <label>名称<input type="text" data-variable-name value="${esc(variable.Name)}" placeholder="例如 Enable" maxlength="80"></label>
        <label>类型<select data-variable-type>${typeOptions.map(type => `<option value="${type}" ${variable.Type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label>
        <label>初始值<span class="hardware-variable-initial"><input type="checkbox" data-variable-has-initial ${variable.HasInitialValue ? 'checked' : ''} title="指定初始值"><input type="text" data-variable-initial value="${esc(variable.InitialValue || '')}" ${variable.HasInitialValue ? '' : 'disabled'} placeholder="可选"></span></label>
        <label>形式<select data-variable-kind><option value="field" ${variable.MemberKind === 'field' ? 'selected' : ''}>字段</option><option value="property" ${variable.MemberKind === 'property' ? 'selected' : ''}>属性</option></select></label>
        <button type="button" class="catalog-action" data-remove-variable title="删除变量">×</button>
      </article>`).join('');
    list.querySelectorAll('[data-hardware-variable]').forEach(row => {
      const variable = hardwareDialogVariables.find(item => item.VariableId === row.dataset.hardwareVariable);
      row.querySelector('[data-variable-name]').addEventListener('input', event => { variable.Name = event.target.value.trim(); });
      row.querySelector('[data-variable-type]').addEventListener('change', event => { variable.Type = event.target.value; });
      row.querySelector('[data-variable-kind]').addEventListener('change', event => { variable.MemberKind = event.target.value; });
      row.querySelector('[data-variable-has-initial]').addEventListener('change', event => {
        variable.HasInitialValue = event.target.checked;
        row.querySelector('[data-variable-initial]').disabled = !variable.HasInitialValue;
      });
      row.querySelector('[data-variable-initial]').addEventListener('input', event => { variable.InitialValue = event.target.value; });
      row.querySelector('[data-remove-variable]').addEventListener('click', () => {
        hardwareDialogVariables = hardwareDialogVariables.filter(item => item !== variable);
        renderHardwareVariables();
      });
    });
  }

  function openHardwareDialog(definition = null) {
    const task = currentTask();
    if (!task) { setStatus('请先新建或选择 Task，再添加硬件。', 'warning'); return; }
    editingHardwareId = definition?.HardwareId || '';
    $('#hardwareForm').reset();
    $('#hardwareDialogTitle').textContent = definition ? `编辑 ${definition.Name}` : '新建硬件';
    $('#saveHardwareButton').textContent = definition ? '保存修改' : '创建硬件';
    $('#hardwareTypeInput').value = definition?.Type || 'Nozzle';
    $('#hardwareNameInput').value = definition?.Name || '';
    $('#hardwareTypeInput').disabled = Boolean(definition);
    $('#hardwareNozzleScopeButton').disabled = Boolean(definition);
    $('#hardwareStandaloneScopeButton').disabled = Boolean(definition);
    hardwareDialogNozzles = nozzleInstancesFromDefinition(definition);
    selectedHardwareNozzleId = hardwareDialogNozzles[0].NozzleId;
    hardwareDialogParts = hardwareDialogNozzles[0].Parts;
    hardwareDialogVariables = JSON.parse(JSON.stringify(definition?.Variables || []));
    hardwareDialogVariables.forEach((variable, index) => {
      variable.VariableId ||= `variable_saved_${index}`;
      variable.MemberKind ||= 'field';
      variable.HasInitialValue = Boolean(variable.HasInitialValue);
    });
    $('#hardwareNozzleFilters').querySelectorAll('input').forEach(input => { input.checked = false; });
    hardwareDialogSlots = definition ? JSON.parse(JSON.stringify(definition.Slots || [])) : [];
    $('#hardwareDialogError').classList.add('hidden');
    renderHardwareDialog();
    openDialog('hardwareDialog');
    setTimeout(() => $('#hardwareNameInput').focus(), 0);
  }

  function renderHardwareDialog() {
    const type = $('#hardwareTypeInput').value;
    const isNozzle = type === 'Nozzle';
    $('#hardwareNozzleScopeButton').setAttribute('aria-pressed', String(isNozzle));
    $('#hardwareStandaloneScopeButton').setAttribute('aria-pressed', String(!isNozzle));
    $('#hardwareTypeField').classList.toggle('hidden', isNozzle);
    $('#hardware-nozzle-panel').classList.toggle('hidden', !isNozzle);
    $('#hardwareNameInput').placeholder = isNozzle ? '例如 Bend1Nozzle' : '例如 Bend1' + type;
    $('#hardwareNozzleComponents').classList.toggle('hidden', !isNozzle);
    $('#hardwareSlotFields').classList.toggle('hidden', isNozzle);
    if (isNozzle) {
      const nozzle = selectedDialogNozzle();
      hardwareDialogParts = nozzle?.Parts || [];
      renderHardwareNozzleSelector();
    }
    renderHardwareVariables();
    // Generated Task hardware properties are strongly typed against EnumName.cs.
    // Do not offer arbitrary imported enum source here because its namespace and
    // nesting are not guaranteed to match the generated using-static contract.
    const resources = enumBindingResources();
    const renderSlot = (slot, bindingAttribute) => {
      const choices = resources.filter(resource => resource.Category === slot.Category);
      const selectedKey = slot.Binding?.ResourceKey || '';
      const groups = Array.from(new Set(choices.map(resource => resource.EnumTypeName)));
      const options = groups.map(group => `<optgroup label="${esc(group)}">${choices.filter(resource => resource.EnumTypeName === group).map(resource => {
        const label = resource.Comment ? `${resource.MemberName} · ${resource.Comment}` : resource.MemberName;
        return `<option value="${esc(resource.ResourceKey)}" ${selectedKey === resource.ResourceKey ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('')}</optgroup>`).join('');
      const cylinderSlot = type === 'Cylinder' || slot.ComponentType === 'Cylinder';
      return `<label class="hardware-dialog-slot"><span><strong>${esc(slot.DisplayName)}</strong><small>${slot.Category === 'axis' ? '轴枚举' : slot.Category === 'input' ? '输入枚举' : '输出枚举'}${cylinderSlot ? ' · 气缸四点中至少绑定一点' : ''}</small></span><select ${bindingAttribute}="${esc(slot.SlotId)}"><option value="">未绑定</option>${options}</select></label>`;
    };
    if (isNozzle) {
      const filters = new Set(selectedNozzleFilters());
      $('#hardwarePartsList').innerHTML = hardwareDialogParts.map(part => `<article class="hardware-part-card" data-hardware-part="${esc(part.PartId)}" ${filters.size && !filters.has(part.Type) ? 'hidden' : ''}>
        <header class="hardware-part-heading"><span class="hardware-part-type">${esc(HARDWARE_TYPE_LABELS[part.Type] || part.Type)}</span><input class="hardware-part-name" type="text" maxlength="80" required value="${esc(part.Name)}" data-hardware-part-name="${esc(part.PartId)}" aria-label="部件名称"><button class="hardware-part-remove" type="button" data-remove-hardware-part="${esc(part.PartId)}" title="删除部件" aria-label="删除${esc(part.Name)}">×</button></header>
        <div class="hardware-part-slots">${(part.Slots || []).map(slot => renderSlot(slot, 'data-hardware-part-slot')).join('')}</div>
      </article>`).join('') || '<div class="empty-inline">还没有添加吸嘴部件。选择类型后点击“添加部件”。</div>';
      $('#hardwareSlotFields').innerHTML = '';
      $('#hardwarePartsList').querySelectorAll('[data-hardware-part-slot]').forEach(select => select.addEventListener('change', () => {
        const slot = hardwareDialogParts.flatMap(part => part.Slots || []).find(item => item.SlotId === select.dataset.hardwarePartSlot);
        const resource = resources.find(item => item.ResourceKey === select.value);
        if (slot) slot.Binding = resource ? { ResourceKey: resource.ResourceKey, ResourceId: resource.ResourceId, ResourceType: resource.ResourceType, EnumTypeName: resource.EnumTypeName, MemberName: resource.MemberName, SheetId: resource.SheetId || '' } : null;
      }));
      $('#hardwarePartsList').querySelectorAll('[data-hardware-part-name]').forEach(input => input.addEventListener('input', () => {
        const part = hardwareDialogParts.find(item => item.PartId === input.dataset.hardwarePartName);
        if (!part) return;
        part.Name = input.value.trim();
        (part.Slots || []).forEach(slot => {
          const suffix = slot.SlotId.slice(slot.SlotId.lastIndexOf('.') + 1);
          const definition = nozzlePartSlotSpecs(part.Type, part.PartId, part.Name).find(spec => spec.SlotId.endsWith(`.${suffix}`));
          if (definition) slot.PropertyName = definition.PropertyName;
        });
      }));
      $('#hardwarePartsList').querySelectorAll('[data-remove-hardware-part]').forEach(button => button.addEventListener('click', () => {
        hardwareDialogParts = hardwareDialogParts.filter(part => part.PartId !== button.dataset.removeHardwarePart);
        const nozzle = selectedDialogNozzle();
        if (nozzle) nozzle.Parts = hardwareDialogParts;
        renderHardwareDialog();
      }));
    } else {
      const specs = hardwareSlotSpecs(type);
      const previous = new Map(hardwareDialogSlots.map(slot => [slot.SlotId, slot.Binding || null]));
      hardwareDialogSlots = specs.map(spec => ({ ...spec, Binding: previous.get(spec.SlotId) || null }));
      const standaloneSlots = hardwareDialogSlots.map(slot => renderSlot(slot, 'data-hardware-dialog-slot')).join('');
      $('#hardwareSlotFields').innerHTML = '<div class="hardware-standalone-caption">Task 独立' + esc(HARDWARE_TYPE_LABELS[type]) + ' · 与吸嘴并列保存</div>' + standaloneSlots;
    }
    $('#hardwareSlotFields').querySelectorAll('[data-hardware-dialog-slot]').forEach(select => select.addEventListener('change', () => {
      const slot = hardwareDialogSlots.find(item => item.SlotId === select.dataset.hardwareDialogSlot);
      const resource = resources.find(item => item.ResourceKey === select.value);
      if (slot) slot.Binding = resource ? { ResourceKey: resource.ResourceKey, ResourceId: resource.ResourceId, ResourceType: resource.ResourceType, EnumTypeName: resource.EnumTypeName, MemberName: resource.MemberName, SheetId: resource.SheetId || '' } : null;
    }));
  }

  function saveHardwareFromDialog(event) {
    event.preventDefault();
    const task = currentTask(); if (!task) return;
    const name = $('#hardwareNameInput').value.trim();
    const type = $('#hardwareTypeInput').value;
    const editing = state.workspace.HardwareDefinitions.find(item => item.HardwareId === editingHardwareId);
    if (!window.EquipmentFlowTaskCodegen.validIdentifier(name)) { $('#hardwareDialogError').textContent = '类名必须是有效的 C# 标识符，且不能使用关键字。'; $('#hardwareDialogError').classList.remove('hidden'); return; }
    if (state.workspace.HardwareDefinitions.some(item => item.TaskId === task.TaskId && item !== editing && item.Name.toLowerCase() === name.toLowerCase())) {
      $('#hardwareDialogError').textContent = `当前 Task 已存在硬件类 ${name}。`; $('#hardwareDialogError').classList.remove('hidden'); return;
    }
    const nozzles = type === 'Nozzle'
      ? JSON.parse(JSON.stringify(hardwareDialogNozzles)).map(nozzle => ({
        ...nozzle, Slots: (nozzle.Parts || []).flatMap(part => part.Slots || []),
      }))
      : [];
    const parts = nozzles.flatMap(nozzle => nozzle.Parts || []);
    const componentSlots = parts.flatMap(part => part.Slots || []);
    if (type === 'Nozzle') {
      if (!nozzles.length) { $('#hardwareDialogError').textContent = '吸嘴组合至少需要一个吸嘴。'; $('#hardwareDialogError').classList.remove('hidden'); return; }
      const invalidPart = parts.find(part => !window.EquipmentFlowTaskCodegen.validIdentifier(String(part.Name || '').trim()));
      if (invalidPart) { $('#hardwareDialogError').textContent = `部件名称「${invalidPart.Name || '空名称'}」必须是有效的 C# 标识符。`; $('#hardwareDialogError').classList.remove('hidden'); return; }
      const duplicatePartName = nozzles.flatMap(nozzle => (nozzle.Parts || []).filter((part, index) =>
        (nozzle.Parts || []).some((other, otherIndex) => otherIndex !== index && String(other.Name || '').trim().toLowerCase() === String(part.Name || '').trim().toLowerCase())));
      if (duplicatePartName.length) { $('#hardwareDialogError').textContent = `同一个吸嘴中存在重复的部件名称 ${duplicatePartName[0].Name}。`; $('#hardwareDialogError').classList.remove('hidden'); return; }
      const unboundCylinder = parts.find(part => part.Type === 'Cylinder' && !(part.Slots || []).some(slot => slot.Binding));
      if (unboundCylinder) { $('#hardwareDialogError').textContent = `气缸 ${unboundCylinder.Name} 的 4 个 IO 槽位至少要绑定一个输入或输出。`; $('#hardwareDialogError').classList.remove('hidden'); return; }
    } else if (type === 'Cylinder' && !hardwareDialogSlots.some(slot => slot.Binding)) {
      $('#hardwareDialogError').textContent = '气缸的 4 个 IO 槽位至少要绑定一个输入或输出。'; $('#hardwareDialogError').classList.remove('hidden'); return;
    }
    const definition = editing || { HardwareId: `hardware_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}` };
    const slots = type === 'Nozzle' ? componentSlots : hardwareDialogSlots;
    const classMemberConflict = slots.find(slot => String(slot.PropertyName || '').toLowerCase() === name.toLowerCase());
    if (classMemberConflict) {
      $('#hardwareDialogError').textContent = '硬件属性 ' + classMemberConflict.PropertyName + ' 不能与类名相同，请修改类名或部件名称。';
      $('#hardwareDialogError').classList.remove('hidden');
      return;
    }
    const variables = JSON.parse(JSON.stringify(hardwareDialogVariables));
    const invalidVariable = variables.find(variable => !window.EquipmentFlowTaskCodegen.validIdentifier(variable.Name || ''));
    if (invalidVariable) { $('#hardwareDialogError').textContent = '变量名称必须是有效的 C# 标识符。'; $('#hardwareDialogError').classList.remove('hidden'); return; }
    const memberNames = new Set(componentSlots.concat(type === 'Nozzle' ? [] : hardwareDialogSlots).map(slot => String(slot.PropertyName || '').toLowerCase()));
    memberNames.add(name.toLowerCase());
    const duplicateVariable = variables.find(variable => {
      const key = variable.Name.toLowerCase();
      if (memberNames.has(key)) return true;
      memberNames.add(key);
      return false;
    });
    if (duplicateVariable) { $('#hardwareDialogError').textContent = '变量名称 ' + duplicateVariable.Name + ' 与已有成员或类名重复。'; $('#hardwareDialogError').classList.remove('hidden'); return; }
    const components = type === 'Nozzle' ? Array.from(new Set(parts.map(part => part.Type))) : [];
    Object.assign(definition, {
      TaskId: task.TaskId, Name: name, Type: type, Components: components,
      Nozzles: nozzles, Parts: nozzles[0]?.Parts || [], Variables: variables,
      Slots: JSON.parse(JSON.stringify(slots)),
    });
    if (!editing) state.workspace.HardwareDefinitions.push(definition);
    editingHardwareId = '';
    closeDialog('hardwareDialog'); renderAll(); updateWorkspaceHeader(); persistProjectDraft();
    setStatus(`${editing ? '已更新' : '已新增'} ${HARDWARE_TYPE_LABELS[type]}：${name}；保存项目源码时会生成 ${task.ClassName}_Hardware.cs。`, 'normal');
  }

  function deleteHardwareDefinition(hardwareId) {
    const definition = state.workspace.HardwareDefinitions.find(item => item.HardwareId === hardwareId);
    if (!definition) return;
    if (!window.confirm(`确定删除硬件类「${definition.Name}」吗？`)) return;
    state.workspace.HardwareDefinitions = state.workspace.HardwareDefinitions.filter(item => item !== definition);
    renderHardware(); persistProjectDraft(); setStatus(`已删除硬件类 ${definition.Name}`, 'normal');
  }

  function renderHardwareDefinitions(root, definitions, resources) {
    const nozzles = definitions.filter(item => item.Type === 'Nozzle');
    if (nozzles.length) {
      const group = document.createElement('details'); group.className = 'hardware-enum-tree'; group.open = true;
      group.innerHTML = `<summary><span class="hardware-enum-icon">⌖</span><span class="tree-summary-copy"><strong>吸嘴</strong><small>${nozzles.length} 个吸嘴类</small></span></summary>`;
      const body = document.createElement('div'); body.className = 'catalog-tree-children';
      nozzles.forEach(definition => body.appendChild(renderHardwareDefinition(definition, resources)));
      group.appendChild(body); root.appendChild(group);
    }
    ['Axis', 'Sensor', 'Cylinder', 'Temperature', 'Pressure', 'Vacuum'].forEach(type => {
      const items = definitions.filter(item => item.Type === type);
      if (!items.length) return;
      const group = document.createElement('details'); group.className = 'hardware-enum-tree'; group.open = true;
      group.innerHTML = `<summary><span class="hardware-enum-icon">≡</span><span class="tree-summary-copy"><strong>${HARDWARE_TYPE_LABELS[type]}</strong><small>${items.length} 个类</small></span></summary>`;
      const body = document.createElement('div'); body.className = 'catalog-tree-children';
      items.forEach(definition => body.appendChild(renderHardwareDefinition(definition, resources)));
      group.appendChild(body); root.appendChild(group);
    });
  }

  function renderHardwareDefinition(definition, resources) {
    const tree = document.createElement('details'); tree.className = 'hardware-definition-tree'; tree.open = true;
    const componentCounts = definition.Type === 'Nozzle' ? nozzlePartsForDefinition(definition).reduce((counts, part) => {
      counts[part.Type] = (counts[part.Type] || 0) + 1;
      return counts;
    }, {}) : {};
    const components = NOZZLE_COMPONENTS.filter(type => componentCounts[type]).map(type => `${HARDWARE_TYPE_LABELS[type]}${componentCounts[type] > 1 ? ` ×${componentCounts[type]}` : ''}`).join('、');
    const nozzleCount = definition.Type === 'Nozzle' ? (definition.Nozzles?.length || 1) : 0;
    tree.innerHTML = `<summary><span class="tree-class-icon">C</span><span class="tree-summary-copy"><strong>${esc(definition.Name)}</strong><small>${definition.Type === 'Nozzle' ? `${nozzleCount} 个吸嘴 · ${esc(components || '无子硬件')}` : `${esc(HARDWARE_TYPE_LABELS[definition.Type] || '硬件')}类 · ${(definition.Slots || []).length} 个绑定槽位`}</small></span><span class="hardware-definition-actions"><button type="button" data-hardware-edit>编辑</button><button type="button" data-hardware-delete>删除</button></span></summary>`;
    const body = document.createElement('div'); body.className = 'catalog-tree-children hardware-slot-list';
    (definition.Slots || []).forEach(slot => {
      const row = document.createElement('div'); row.className = 'hardware-slot-row hardware-definition-slot';
      const nozzle = (definition.Nozzles || []).find(item => (item.Slots || []).some(nested => nested.SlotId === slot.SlotId));
      const part = (nozzle?.Parts || []).find(item => (item.Slots || []).some(nested => nested.SlotId === slot.SlotId));
      const ownerLabel = nozzle ? `${nozzle.Name}${part ? ' / ' + part.Name : ''} · ` : '';
      row.dataset.hardwareId = definition.HardwareId; row.dataset.slotId = slot.SlotId;
      const binding = slot.Binding || null;
      const choices = resources.filter(resource => resource.Category === slot.Category);
      const optionGroups = Array.from(new Set(choices.map(resource => resource.EnumTypeName || resource.ResourceType)));
      const options = optionGroups.map(group => `<optgroup label="${esc(group)}">${choices.filter(resource => (resource.EnumTypeName || resource.ResourceType) === group).map(resource => {
        const key = resource.ResourceKey;
        const label = resource.Comment ? `${resource.MemberName || resource.Name} · ${resource.Comment}` : (resource.MemberName || resource.Name);
        return `<option value="${esc(key)}" ${binding?.ResourceKey === key ? 'selected' : ''}>${esc(label)}</option>`;
      }).join('')}</optgroup>`).join('');
      const boundResource = choices.find(resource => resource.ResourceKey === binding?.ResourceKey);
      row.innerHTML = `<span class="slot-port"></span><span class="hardware-slot-copy"><strong>${esc(ownerLabel + slot.DisplayName)}</strong><small>${slot.Category === 'axis' ? '轴' : slot.Category === 'input' ? '输入' : '输出'} · ${esc(slot.SlotId)}</small></span><select data-hardware-binding aria-label="绑定${esc(ownerLabel + slot.DisplayName)}"><option value="">${choices.length ? '未绑定' : '没有可用枚举'}</option>${options}</select>${boundResource ? `<span class="hardware-slot-bound">${esc(boundResource.MemberName || boundResource.Name)}</span>` : ''}`;
      row.addEventListener('change', event => {
        if (!event.target.matches('[data-hardware-binding]')) return;
        setHardwareDefinitionBinding(definition.HardwareId, slot.SlotId, event.target.value, resources);
      });
      row.addEventListener('dragover', event => {
        const candidate = resources.find(resource => resource.ResourceKey === state.activeHardwareResourceKey);
        if (!candidate || candidate.Category !== slot.Category) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; row.classList.add('drop-compatible');
      });
      row.addEventListener('dragleave', () => row.classList.remove('drop-compatible'));
      row.addEventListener('drop', event => {
        event.preventDefault(); event.stopPropagation(); row.classList.remove('drop-compatible');
        const key = event.dataTransfer.getData('application/x-equipment-hardware-resource') || state.activeHardwareResourceKey;
        setHardwareDefinitionBinding(definition.HardwareId, slot.SlotId, key, resources);
      });
      body.appendChild(row);
    });
    tree.appendChild(body);
    tree.querySelector('[data-hardware-edit]').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); openHardwareDialog(definition); });
    tree.querySelector('[data-hardware-delete]').addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); deleteHardwareDefinition(definition.HardwareId); });
    tree.querySelector('summary').addEventListener('contextmenu', event => {
      event.preventDefault(); event.stopPropagation();
      showContextMenu(event.clientX, event.clientY, [
        { label: '复制硬件类名', action: () => copyText(definition.Name) },
        { label: '编辑硬件', action: () => openHardwareDialog(definition) },
        { label: '删除硬件', action: () => deleteHardwareDefinition(definition.HardwareId) },
      ]);
    });
    return tree;
  }

  function setHardwareDefinitionBinding(hardwareId, slotId, resourceKey, resources = hardwareBindingResources()) {
    const definition = state.workspace.HardwareDefinitions.find(item => item.HardwareId === hardwareId);
    const slot = definition?.Slots?.find(item => item.SlotId === slotId);
    if (!slot) return;
    const resource = resources.find(item => item.ResourceKey === resourceKey);
    if (resource && resource.Category !== slot.Category) { setStatus('硬件枚举类型不匹配。', 'error'); return; }
    slot.Binding = resource ? { ResourceKey: resource.ResourceKey, ResourceId: resource.ResourceId, ResourceType: resource.ResourceType, EnumTypeName: resource.EnumTypeName || resource.ResourceType, MemberName: resource.MemberName || resource.Name, SheetId: resource.SheetId || '' } : null;
    (definition.Nozzles || []).forEach(nozzle => {
      const nested = (nozzle.Slots || []).find(item => item.SlotId === slotId);
      if (nested) nested.Binding = slot.Binding ? { ...slot.Binding } : null;
      (nozzle.Parts || []).forEach(part => {
        const partSlot = (part.Slots || []).find(item => item.SlotId === slotId);
        if (partSlot) partSlot.Binding = slot.Binding ? { ...slot.Binding } : null;
      });
    });
    (definition.Parts || []).forEach(part => {
      const partSlot = (part.Slots || []).find(item => item.SlotId === slotId);
      if (partSlot) partSlot.Binding = slot.Binding ? { ...slot.Binding } : null;
    });
    renderHardware(); persistProjectDraft();
    setStatus(resource ? `已绑定 ${definition.Name}.${slot.PropertyName} → ${resource.EnumTypeName}.${resource.MemberName || resource.Name}` : `已清除 ${definition.Name}.${slot.PropertyName} 的绑定`, 'normal');
  }

  function renderHardwareEnumResources(root, resources) {
    const enums = resources.filter(resource => resource.ResourceKey.startsWith('enum::'));
    if (!enums.length) return;
    const group = document.createElement('details'); group.className = 'hardware-enum-tree';
    group.innerHTML = `<summary><span class="hardware-enum-icon">≡</span><span class="tree-summary-copy"><strong>工程枚举资源</strong><small>${enums.length} 个可绑定值</small></span></summary>`;
    const body = document.createElement('div'); body.className = 'catalog-tree-children hardware-resource-list';
    const grouped = new Map();
    enums.forEach(resource => { const key = resource.EnumTypeName; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(resource); });
    grouped.forEach((items, enumName) => {
      const enumGroup = document.createElement('details'); enumGroup.className = 'hardware-enum-tree';
      enumGroup.innerHTML = `<summary><span class="hardware-enum-icon">≡</span><span class="tree-summary-copy"><strong>${esc(enumName)}</strong><small>${items.length} 个资源</small></span></summary>`;
      const members = document.createElement('div'); members.className = 'catalog-tree-children hardware-resource-list';
      items.forEach(resource => {
        const row = document.createElement('div'); row.className = 'hardware-resource-row'; row.draggable = true; row.dataset.resourceKey = resource.ResourceKey;
        row.innerHTML = `<span class="hardware-type-dot"></span><span class="hardware-kind-label">${resource.Category === 'axis' ? '轴' : resource.Category === 'input' ? '输入' : '输出'}</span><span class="hardware-name" title="${esc(resource.ResourceId)}">${esc(resource.MemberName)}</span>${resource.Comment ? `<small class="hardware-resource-comment">${esc(resource.Comment)}</small>` : ''}`;
        row.addEventListener('dragstart', event => {
          state.activeHardwareResourceKey = resource.ResourceKey;
          event.dataTransfer.effectAllowed = 'copy'; event.dataTransfer.setData('application/x-equipment-hardware-resource', resource.ResourceKey);
        });
        row.addEventListener('dragend', () => { state.activeHardwareResourceKey = ''; $$('.drop-compatible').forEach(item => item.classList.remove('drop-compatible')); });
        members.appendChild(row);
      });
      enumGroup.appendChild(members); body.appendChild(enumGroup);
    });
    group.appendChild(body); root.appendChild(group);
  }

  // Remove project-side data for one imported file and clear references to its resources.
  function removeImportedHardwareFile(fileName) {
    const file = (state.workspace.HardwareFiles || []).find(item => item.fileName === fileName);
    if (!file) return;
    if (!window.confirm(`确定从当前工程移除硬件文件“${fileName}”吗？该文件中的资源、工厂和槽位会从工程中移除，磁盘上的原文件不会删除。`)) return;

    const removedResources = (state.workspace.HardwareCatalogResources || []).filter(item => item.SourceFile === fileName);
    const removedKeys = new Set(removedResources.map(item => item.ResourceKey).filter(Boolean));
    const removedIds = new Set(removedResources.map(item => item.ResourceId).filter(Boolean));
    const remainingResources = (state.workspace.HardwareCatalogResources || []).filter(item => item.SourceFile !== fileName);
    const remainingIds = new Set(remainingResources.map(item => item.ResourceId).filter(Boolean));
    const referencesRemovedResource = binding => {
      const key = String(binding?.ResourceKey || '');
      const resourceId = String(binding?.ResourceId || '');
      if (key && (removedKeys.has(key) || key.startsWith(`${fileName}::`))) return true;
      return !key && resourceId && removedIds.has(resourceId) && !remainingIds.has(resourceId);
    };
    const clearImportedSlotBinding = slot => {
      if (!slot || !referencesRemovedResource({ ResourceKey: slot.BoundResourceKey, ResourceId: slot.BoundResourceId })) return;
      slot.BoundResourceId = '';
      slot.BoundResourceKey = '';
    };
    const clearDefinitionSlots = slots => (slots || []).forEach(slot => {
      if (referencesRemovedResource(slot.Binding)) slot.Binding = null;
    });

    state.workspace.HardwareFiles = (state.workspace.HardwareFiles || []).filter(item => item.fileName !== fileName);
    state.workspace.HardwareCatalogResources = remainingResources;
    state.workspace.HardwareFactories = (state.workspace.HardwareFactories || []).filter(item => item.SourceFile !== fileName);
    state.workspace.HardwareSlots = (state.workspace.HardwareSlots || [])
      .filter(slot => slot.SourceFile !== fileName)
      .map(slot => { clearImportedSlotBinding(slot); return slot; });
    (state.workspace.HardwareDefinitions || []).forEach(definition => {
      clearDefinitionSlots(definition.Slots);
      clearDefinitionSlots(definition.Parts?.flatMap(part => part.Slots || []));
      (definition.Nozzles || []).forEach(nozzle => {
        clearDefinitionSlots(nozzle.Slots);
        clearDefinitionSlots((nozzle.Parts || []).flatMap(part => part.Slots || []));
      });
    });
    state.workspace.HardwareBindings = window.EquipmentFlowHardwareLibrary.createBindings(state.workspace.HardwareSlots);
    renderHardware();
    persistProjectDraft();
    setStatus(`已从当前工程移除硬件文件 ${fileName}；相关失效绑定已清除。`, 'normal');
  }

  function renderHardware() {
    if (!state.workspace) return;
    const resources = hardwareBindingResources();
    const catalogResources = state.workspace.HardwareCatalogResources || [];
    const factories = state.workspace.HardwareFactories || [];
    const files = state.workspace.HardwareFiles || [];
    const slots = state.workspace.HardwareSlots || [];
    const task = currentTask();
    const definitions = (state.workspace.HardwareDefinitions || []).filter(item => !task || item.TaskId === task.TaskId);
    const counts = hardwareCounts(catalogResources, factories);
    const enumResources = enumBindingResources();
    const componentCount = type => definitions.reduce((sum, item) => {
      if (item.Type === type) return sum + 1;
      if (item.Type !== 'Nozzle') return sum;
      return sum + nozzlePartsForDefinition(item).filter(part => part.Type === type).length;
    }, 0);
    const nozzleInstances = definitions.filter(item => item.Type === 'Nozzle')
      .reduce((count, item) => count + (item.Nozzles?.length || 1), 0);
    $('#hardwareSummary').innerHTML = [[nozzleInstances || counts.nozzles, '吸嘴'],
      [componentCount('Axis') || counts.axes, '轴'],
      [componentCount('Sensor') || counts.inputs, '传感器'], [componentCount('Cylinder'), '气缸'],
      [componentCount('Temperature'), '温度'], [componentCount('Pressure'), '压力'], [componentCount('Vacuum'), '真空吸']]
      .map(([count, label]) => `<div class="hardware-count" title="${esc(label)}：${esc(count)}"><span>${label}</span><strong>${esc(count)}</strong></div>`).join('');
    $('#hardwareFileCount').textContent = `${files.length} 文件 · ${definitions.length} 类`;
    $('#hardwareFileCount').title = `${files.length} 个导入文件 · ${definitions.length} 个硬件类`;
    $('#hardwareList').innerHTML = '';
    $('#hardwareBindingsList').innerHTML = '';
    const root = $('#hardwareCatalogFiles');
    root.innerHTML = '';
    renderHardwareDefinitions(root, definitions, enumResources);
    renderHardwareEnumResources(root, enumResources);
    if (!files.length && !definitions.length && !enumResources.length) root.innerHTML = '<div class="empty-inline">先选择 Task；可新建吸嘴、传感器、气缸、温度、压力或真空吸，再从工程枚举表绑定资源。</div>';
    files.forEach(file => {
      const fileResources = resources.filter(item => item.SourceFile === file.fileName);
      const fileFactories = factories.filter(item => item.SourceFile === file.fileName);
      const fileSlots = slots.filter(item => item.SourceFile === file.fileName);
      const stats = hardwareCounts(fileResources, fileFactories);
      const tree = document.createElement('details');
      tree.className = 'hardware-file-tree'; tree.open = true;
      tree.innerHTML = `<summary><span class="tree-file-icon">CS</span><span class="tree-summary-copy"><strong>${esc(file.fileName)}</strong><small>${esc(stats.nozzles)} 吸嘴 · ${stats.inputs} 输入 / 传感器 · ${stats.axes} 轴 · ${stats.outputs} 输出</small></span></summary>`;
      const children = document.createElement('div'); children.className = 'catalog-tree-children';
      (file.classes || []).forEach(type => {
        const classSlots = fileSlots.filter(item => item.OwnerClass === type.name);
        const classFactories = fileFactories.filter(item => item.OwnerClass === type.name);
        const classTree = document.createElement('details'); classTree.className = 'hardware-class-tree'; classTree.open = true;
        classTree.innerHTML = `<summary><span class="tree-class-icon">C</span><span class="tree-summary-copy"><strong>${esc(type.name)}</strong><small>${classSlots.length} 个槽位${classFactories.length ? ` · ${classFactories.length} 个工厂` : classSlots.length ? '' : ' · 未声明绑定槽位'}</small></span></summary>`;
        const body = document.createElement('div'); body.className = 'catalog-tree-children hardware-slot-list';
        classFactories.forEach(factory => {
          const row = document.createElement('div'); row.className = 'hardware-factory-row';
          row.innerHTML = `<strong>${esc(factory.DisplayName || factory.NozzleType)}</strong><span>${factory.Count == null ? '动态 / 未解析' : `${factory.Count} 个吸嘴`}</span><small>${esc(factory.NozzleType)} · ${esc(factory.FactoryId)}</small><small>${factory.InstanceIds.length ? `实例 ID：${esc(factory.InstanceIds.join('、'))}` : '数量由机种加载后的工厂配置确定'}</small>`;
          body.appendChild(row);
        });
        classSlots.forEach(slot => body.appendChild(renderHardwareSlot(slot, resources)));
        classTree.appendChild(body); children.appendChild(classTree);
      });
      (file.enums || []).forEach(type => {
        const items = fileResources.filter(item => item.GroupName === type.name);
        const enumTree = document.createElement('details'); enumTree.className = 'hardware-enum-tree';
        enumTree.innerHTML = `<summary><span class="hardware-enum-icon">≡</span><span class="tree-summary-copy"><strong>${esc(type.name)}</strong><small>${items.length} 个资源</small></span></summary>`;
        enumTree.querySelector('.tree-summary-copy strong').textContent = hardwareTypeLabel(type.name, type.name) + ' (' + type.name + ')';
        const categoryCounts = ['cylinder', 'vacuum', 'sensor', 'axis'].map(category => [category, items.filter(item => hardwareCategory(item.ResourceType, item.Name || item.ResourceId) === category).length]).filter(([, count]) => count);
        const groupSummary = categoryCounts.map(([category, count]) => hardwareTypeLabel(category) + ' ' + count).join(' · ');
        enumTree.querySelector('.tree-summary-copy small').textContent = items.length + ' 个资源' + (groupSummary ? ' · ' + groupSummary : '');
        const body = document.createElement('div'); body.className = 'catalog-tree-children hardware-resource-list';
        items.forEach(resource => {
          const row = document.createElement('div'); row.className = 'hardware-resource-row'; row.draggable = true; row.dataset.resourceKey = resource.ResourceKey;
          row.innerHTML = `<span class="hardware-type-dot"></span><span class="hardware-name" title="${esc(resource.ResourceId)}">${esc(resource.Name)}</span><span class="hardware-index">=${esc(resource.Value)}</span>`;
          const kind = document.createElement('span');
          kind.className = 'hardware-kind-label';
          kind.textContent = hardwareTypeLabel(resource.ResourceType, resource.Name || resource.ResourceId);
          row.insertBefore(kind, row.querySelector('.hardware-name'));
          row.addEventListener('dragstart', event => {
            state.activeHardwareResourceKey = resource.ResourceKey;
            event.dataTransfer.effectAllowed = 'copy';
            event.dataTransfer.setData('application/x-equipment-hardware-resource', resource.ResourceKey);
          });
          row.addEventListener('dragend', () => { state.activeHardwareResourceKey = ''; $$('.drop-compatible').forEach(item => item.classList.remove('drop-compatible')); });
          body.appendChild(row);
        });
        enumTree.appendChild(body); children.appendChild(enumTree);
      });
      tree.appendChild(children);
      const fileCategoryCount = category => fileResources.filter(item => hardwareCategory(item.ResourceType, item.Name || item.ResourceId) === category).length;
      tree.querySelector('.tree-summary-copy small').textContent = stats.nozzles + ' 吸嘴 · ' + fileCategoryCount('axis') + ' 轴 · '
        + fileCategoryCount('sensor') + ' 传感器 · ' + fileCategoryCount('cylinder') + ' 气缸 · ' + fileCategoryCount('vacuum') + ' 真空吸';
      tree.querySelector('summary').addEventListener('contextmenu', event => {
        event.preventDefault(); event.stopPropagation();
        showContextMenu(event.clientX, event.clientY, [
          { label: '复制文件名', action: () => copyText(file.fileName) },
          { label: '从工程移除', action: () => removeImportedHardwareFile(file.fileName) },
        ]);
      });
      root.appendChild(tree);
    });
  }

  function renderHardwareSlot(slot, resources) {
    const row = document.createElement('div'); row.className = 'hardware-slot-row'; row.dataset.slotKey = slot.SlotKey || slot.SlotId;
    const resource = resources.find(item => item.ResourceId === slot.BoundResourceId && (!slot.BoundResourceKey || item.ResourceKey === slot.BoundResourceKey));
    row.innerHTML = `<span class="slot-port"></span><span class="hardware-slot-copy"><strong>${esc(slot.DisplayName || slot.MemberName)}</strong><small>${esc(slot.SlotId)} · ${esc(slot.ResourceType)}</small></span><span class="hardware-slot-bound">${resource ? esc(resource.Name) : '拖入资源'}</span>${resource ? '<button class="unbind-hardware" type="button" title="清除绑定">×</button>' : ''}`;
    row.querySelector('.hardware-slot-copy small').textContent = slot.SlotId + ' · ' + hardwareTypeLabel(slot.ResourceType, slot.MemberName);
    row.addEventListener('dragover', event => {
      const candidate = resources.find(item => item.ResourceKey === state.activeHardwareResourceKey);
      if (!candidate || !window.EquipmentFlowHardwareLibrary.canBind(slot, candidate)) return;
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; row.classList.add('drop-compatible');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-compatible'));
    row.addEventListener('drop', event => {
      event.preventDefault(); event.stopPropagation(); row.classList.remove('drop-compatible');
      const key = event.dataTransfer.getData('application/x-equipment-hardware-resource') || state.activeHardwareResourceKey;
      state.activeHardwareResourceKey = '';
      try {
        state.workspace.HardwareSlots = window.EquipmentFlowHardwareLibrary.bindResourceToSlot(state.workspace.HardwareSlots, resources, slot.SlotKey || slot.SlotId, key);
        state.workspace.HardwareBindings = window.EquipmentFlowHardwareLibrary.createBindings(state.workspace.HardwareSlots);
        renderHardware(); closeDiagnostics(); persistProjectDraft(); setStatus(`已绑定 ${slot.SlotId} → ${key.split('::').pop()}`, 'normal');
      } catch (error) { setStatus(error.message, 'error'); }
    });
    row.querySelector('.unbind-hardware')?.addEventListener('click', event => {
      event.stopPropagation();
      state.workspace.HardwareSlots = window.EquipmentFlowHardwareLibrary.unbindResource(state.workspace.HardwareSlots, slot.SlotKey || slot.SlotId);
      state.workspace.HardwareBindings = window.EquipmentFlowHardwareLibrary.createBindings(state.workspace.HardwareSlots);
      renderHardware(); persistProjectDraft(); setStatus(`已清除 ${slot.SlotId} 的绑定`, 'normal');
    });
    return row;
  }

  function typeLabel(type) {
    return ({ Start: '流程入口', Action: '动作', Condition: '条件', Wait: '等待', Alarm: '报警', End: '结束' })[type] || type || '节点';
  }

  function updateInspectorTab() {
    renderInspector();
  }

  function openDialog(id) {
    const dialog = $(`#${id}`);
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
  }

  function closeDialog(id) {
    const dialog = $(`#${id}`);
    if (!dialog) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  // Task lifecycle and method editor: create/import Tasks, edit method contracts, and save source.
  function createNewTask() {
    $('#newTaskName').value = '';
    state.pendingTaskTemplate = null;
    state.pendingTaskCopySourceId = '';
    $('#taskDialogTitle').textContent = '新建 Task';
    $('#createTaskButton').textContent = '创建 Task';
    openDialog('taskDialog');
    setTimeout(() => $('#newTaskName').focus(), 0);
  }

  function cloneTaskJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function taskOwnsMethod(method, taskId) {
    return method && (method.TaskId === taskId || (!method.TaskId && method.StationId === taskId));
  }

  function taskCopyCounts(taskId) {
    const flow = state.workspace.Flows.find(item => item.StationId === taskId);
    return {
      methods: (state.workspace.Methods || []).filter(method => taskOwnsMethod(method, taskId)).length,
      nodes: (flow?.Nodes || []).length,
      transitions: (flow?.Transitions || []).length,
      hardware: (state.workspace.HardwareDefinitions || []).filter(item => item.TaskId === taskId).length,
    };
  }

  function copyTaskSuggestedName(task) {
    const base = `${task.ClassName}_Copy`;
    let candidate = base;
    let index = 2;
    while (state.workspace.Tasks.some(item => item.ClassName.toLowerCase() === candidate.toLowerCase()))
      candidate = `${base}${index++}`;
    return candidate;
  }

  function copyTaskAsNew() {
    const source = currentTask();
    if (!source) return;
    state.pendingTaskTemplate = null;
    state.pendingTaskCopySourceId = source.TaskId;
    $('#taskDialogTitle').textContent = `复制 ${source.ClassName} 为新 Task`;
    $('#createTaskButton').textContent = '创建副本';
    $('#newTaskName').value = copyTaskSuggestedName(source);
    openDialog('taskDialog');
    setTimeout(() => $('#newTaskName').focus(), 0);
  }

  function updateCopyTaskTargetSummary() {
    const dialog = $('#copyTaskTargetDialog');
    const source = state.workspace.Tasks.find(item => item.TaskId === dialog.dataset.sourceTaskId);
    const target = state.workspace.Tasks.find(item => item.TaskId === $('#copyTaskTargetSelect').value);
    const summary = $('#copyTaskTargetSummary');
    if (!source || !target) { summary.textContent = '请选择一个不同于来源的目标 Task。'; return; }
    const sourceCounts = taskCopyCounts(source.TaskId);
    const targetCounts = taskCopyCounts(target.TaskId);
    summary.textContent = `来源 ${source.ClassName}：${sourceCounts.methods} 个方法、${sourceCounts.nodes} 个流程节点、${sourceCounts.hardware} 个硬件类\n目标 ${target.ClassName} 当前：${targetCounts.methods} 个方法、${targetCounts.nodes} 个流程节点、${targetCounts.hardware} 个硬件类`;
  }

  function openCopyTaskIntoExisting() {
    const source = currentTask();
    if (!source) return;
    const targets = state.workspace.Tasks.filter(task => task.TaskId !== source.TaskId);
    if (!targets.length) { setStatus('当前工程只有一个 Task，请先新建一个目标 Task。', 'error'); return; }
    $('#copyTaskTargetDialog').dataset.sourceTaskId = source.TaskId;
    $('#copyTaskTargetSource').textContent = `来源：${source.ClassName}`;
    $('#copyTaskTargetSelect').innerHTML = targets.map(task =>
      `<option value="${esc(task.TaskId)}">${esc(task.ClassName)}</option>`).join('');
    updateCopyTaskTargetSummary();
    openDialog('copyTaskTargetDialog');
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function replaceTaskIdentifier(source, oldName, newName) {
    const text = String(source || '');
    if (!oldName || oldName === newName) return text;
    const identifier = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegExp(oldName)}(?=$|[^\\p{L}\\p{N}_])`, 'gu');
    return text.replace(identifier, (_match, prefix) => prefix + newName);
  }

  function replaceTaskNamespace(source, oldNamespace, newNamespace) {
    const text = String(source || '');
    if (!oldNamespace || oldNamespace === newNamespace) return text;
    const declaration = new RegExp(`(\\bnamespace\\s+)${escapeRegExp(oldNamespace)}(?=\\s*[;{])`, 'g');
    return text.replace(declaration, (_match, prefix) => prefix + newNamespace);
  }

  function renameTaskFileName(fileName, oldName, newName) {
    const value = String(fileName || '');
    if (!oldName || oldName === newName) return value;
    const separator = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
    const prefix = value.slice(0, separator + 1);
    const leaf = value.slice(separator + 1);
    const matcher = new RegExp(`^${escapeRegExp(oldName)}(?=\\.|_)`, 'i');
    return prefix + leaf.replace(matcher, newName);
  }

  function csharpStringLiteralValue(literal) {
    try {
      if (literal.startsWith('@"')) return literal.slice(2, -1).replace(/""/g, '"');
      return JSON.parse(literal);
    } catch (_) { return literal.slice(1, -1); }
  }

  function rewriteCopiedMethodMetadata(method, sourceTaskId, destinationTaskId, destinationMethodId) {
    const rewrite = value => String(value || '')
      .replace(/(\[\s*(?:[\w.]+\s*\.\s*)?(?:FlowMethod|FlowMethodId)\s*\(\s*)"(?:\\.|[^"\\])*"/g,
        (_match, prefix) => prefix + JSON.stringify(destinationMethodId))
      .replace(/(\bStationId\s*=\s*)(@?"(?:\\.|[^"\\])*"|@"(?:[^"]|"")*")/g,
        (match, prefix, literal) => csharpStringLiteralValue(literal) === sourceTaskId
          ? prefix + JSON.stringify(destinationTaskId) : match);
    const previousAttributes = String(method.AttributeSource || '');
    const nextAttributes = rewrite(previousAttributes);
    method.AttributeSource = nextAttributes;
    if (typeof method.SourceCode === 'string' && method.SourceCode) {
      const attributeIndex = previousAttributes ? method.SourceCode.indexOf(previousAttributes) : -1;
      method.SourceCode = attributeIndex >= 0
        ? method.SourceCode.slice(0, attributeIndex) + nextAttributes + method.SourceCode.slice(attributeIndex + previousAttributes.length)
        : rewrite(method.SourceCode);
    }
    method.MethodId = destinationMethodId;
    if (method.StationId === sourceTaskId) method.StationId = destinationTaskId;
    method.TaskId = destinationTaskId;
    return method;
  }

  function validateCopiedTaskConfiguration(sourceTask, targetTask, destinationNamespace) {
    const targetClassName = targetTask.ClassName;
    const selfNames = new Set([targetClassName, `${destinationNamespace || 'BoTech'}.${targetClassName}`]);
    if (selfNames.has(String(sourceTask.BaseType || '').trim()))
      throw new Error(`无法复制：来源 Task 的继承类型会让目标 ${targetClassName} 继承自身。`);
    const baseTask = projectTaskForBaseType(sourceTask.BaseType);
    if (baseTask && (baseTask.TaskId === targetTask.TaskId || taskBaseChainContains(baseTask, targetTask.TaskId)))
      throw new Error(`无法复制：来源 Task 的继承关系会让 ${targetClassName} 形成循环继承。`);
    if (sourceTask.ClassModifier === 'sealed') {
      const descendants = new Set([targetTask.TaskId]);
      let changed = true;
      while (changed) {
        changed = false;
        (state.workspace.Tasks || []).forEach(task => {
          const parent = projectTaskForBaseType(task.BaseType);
          if (parent && descendants.has(parent.TaskId) && !descendants.has(task.TaskId)) {
            descendants.add(task.TaskId);
            changed = true;
          }
        });
      }
      const child = (state.workspace.Tasks || []).find(task => task.TaskId !== targetTask.TaskId && descendants.has(task.TaskId));
      if (child) throw new Error(`无法复制：${child.ClassName} 继承目标 Task，不能将目标改为 sealed。`);
    }
  }

  function createCopiedTaskId(className) {
    let taskId = '';
    do { taskId = `${className}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`; }
    while (state.workspace.Tasks.some(task => task.TaskId === taskId));
    return taskId;
  }

  function copyTaskContents(sourceTask, targetTask, isNewTask = false) {
    if (!sourceTask || !targetTask || sourceTask.TaskId === targetTask.TaskId)
      throw new Error('请选择一个与来源不同的目标 Task。');
    if (isNewTask && !window.EquipmentFlowTaskCodegen.validIdentifier(targetTask.ClassName))
      throw new Error('新 Task 名称必须是有效的 C# 类名。');
    if (isNewTask && state.workspace.Tasks.some(task => task.ClassName.toLowerCase() === targetTask.ClassName.toLowerCase()))
      throw new Error(`Task 类名 ${targetTask.ClassName} 已存在。`);
    const destinationNamespace = isNewTask ? sourceTask.Namespace : targetTask.Namespace;
    validateCopiedTaskConfiguration(sourceTask, targetTask, destinationNamespace);

    const sourceFlow = state.workspace.Flows.find(flow => flow.StationId === sourceTask.TaskId) || null;
    const previousTargetFlow = state.workspace.Flows.find(flow => flow.StationId === targetTask.TaskId) || null;
    if (sourceFlow && sourceTask.TaskId === state.stationId) saveLayout(sourceFlow);
    const sourceLayout = cloneTaskJson((state.workspace.CanvasLayouts || {})[sourceTask.TaskId]
      || (sourceTask.TaskId === state.stationId ? state.layout : {})) || {};
    const oldClassName = sourceTask.ClassName;
    const newClassName = targetTask.ClassName;
    const destinationTaskId = targetTask.TaskId;
    const previousMethodRecords = (state.workspace.Methods || []).filter(method => taskOwnsMethod(method, sourceTask.TaskId));
    const methodIdMap = new Map();
    const usedMethodIds = new Set();
    const copiedMethods = previousMethodRecords.map(sourceMethod => {
      const method = cloneTaskJson(sourceMethod);
      const previousId = String(method.MethodId || '');
      let methodId = previousId ? `${newClassName}.${csharpMethodSignatureKey(method)}` : '';
      if (methodId) {
        const base = methodId;
        let suffix = 2;
        while (usedMethodIds.has(methodId)) methodId = `${base}.${suffix++}`;
        usedMethodIds.add(methodId);
        if (!methodIdMap.has(previousId)) methodIdMap.set(previousId, methodId);
      }
      rewriteCopiedMethodMetadata(method, sourceTask.TaskId, destinationTaskId, methodId);
      method.ImportedFileName = renameTaskFileName(method.ImportedFileName || `${oldClassName}_Methods.cs`, oldClassName, newClassName);
      if (!method.ImportedClassName || method.ImportedClassName === oldClassName) method.ImportedClassName = newClassName;
      if (!method.ImportedClassNamespace || method.ImportedClassNamespace === sourceTask.Namespace) method.ImportedClassNamespace = destinationNamespace;
      return method;
    });

    const copiedTask = cloneTaskJson(sourceTask);
    const outputDirectory = isNewTask
      ? (state.taskOutputDirectories.get(sourceTask.TaskId) || projectTaskOutputDirectory())
      : (state.taskOutputDirectories.get(targetTask.TaskId) || projectTaskOutputDirectory());
    const outputPath = outputDirectory?.native && outputDirectory.path
      ? outputDirectory.path
      : (isNewTask ? '' : String(targetTask.OutputDirectoryPath || ''));
    const outputName = outputDirectory?.name || outputDirectory?.legacyHandle?.name
      || (isNewTask ? '' : String(targetTask.OutputDirectoryName || ''));
    Object.assign(copiedTask, {
      TaskId: destinationTaskId,
      ClassName: newClassName,
      Name: isNewTask ? newClassName : (targetTask.Name || targetTask.ClassName),
      Namespace: destinationNamespace || 'BoTech',
      OutputDirectoryPath: outputPath,
      OutputDirectoryName: outputName,
    });
    const templatePathMap = new Map();
    copiedTask.TemplateFiles = (copiedTask.TemplateFiles || []).map(file => {
      const nextPath = renameTaskFileName(file.Path, oldClassName, newClassName);
      if (file.Path) templatePathMap.set(file.Path, nextPath);
      return { ...file, Path: nextPath,
        Source: replaceTaskNamespace(replaceTaskIdentifier(file.Source, oldClassName, newClassName), sourceTask.Namespace, copiedTask.Namespace) };
    });
    copiedTask.TemplatePrimaryPath = templatePathMap.get(copiedTask.TemplatePrimaryPath)
      || renameTaskFileName(copiedTask.TemplatePrimaryPath, oldClassName, newClassName);
    copiedTask.PrimarySource = replaceTaskNamespace(replaceTaskIdentifier(copiedTask.PrimarySource, oldClassName, newClassName), sourceTask.Namespace, copiedTask.Namespace);

    let copiedFlow = null;
    if (sourceFlow) {
      copiedFlow = cloneTaskJson(sourceFlow);
      copiedFlow.FlowId = `${newClassName}_AutoRun`;
      copiedFlow.StationId = destinationTaskId;
      copiedFlow.TaskName = newClassName;
      copiedFlow.Nodes = (copiedFlow.Nodes || []).map(node => {
        const copy = { ...node };
        if (copy.MethodId) {
          const sourceMethodIndex = previousMethodRecords.findIndex(method => method.MethodId === copy.MethodId
            && (copy.MethodSchemaVersion == null || Number(method.SchemaVersion) === Number(copy.MethodSchemaVersion))
            && (copy.MethodMachineName == null || String(method.MachineName || '') === String(copy.MethodMachineName || ''))
            && (copy.MethodStationId == null || !copy.MethodStationId || method.StationId === copy.MethodStationId || method.StationId === sourceTask.TaskId));
          if (sourceMethodIndex >= 0 && copiedMethods[sourceMethodIndex]?.MethodId)
            copy.MethodId = copiedMethods[sourceMethodIndex].MethodId;
        }
        if (copy.MethodStationId === sourceTask.TaskId) copy.MethodStationId = destinationTaskId;
        return copy;
      });
      copiedFlow.Transitions = (copiedFlow.Transitions || []).map(edge => ({ ...edge }));
    } else if (isNewTask) {
      copiedFlow = createTaskFlow(copiedTask);
    }

    const copiedHardware = (state.workspace.HardwareDefinitions || [])
      .filter(item => item.TaskId === sourceTask.TaskId)
      .map(item => ({ ...cloneTaskJson(item), HardwareId: `hardware_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, TaskId: destinationTaskId }));
    const copiedMethodFiles = (state.workspace.MethodFiles || [])
      .filter(file => file.taskId === sourceTask.TaskId)
      .map(file => {
        const copy = cloneTaskJson(file);
        copy.taskId = destinationTaskId;
        copy.fileName = renameTaskFileName(copy.fileName, oldClassName, newClassName);
        copy.classes = (copy.classes || []).map(type => {
          const clonedType = cloneTaskJson(type);
          if (clonedType.name === oldClassName) {
            clonedType.name = newClassName;
            if (clonedType.namespace === sourceTask.Namespace) clonedType.namespace = copiedTask.Namespace;
            clonedType.fullName = `${clonedType.namespace || copiedTask.Namespace}.${newClassName}`;
          }
          clonedType.methods = (clonedType.methods || []).map(method => ({
            ...method,
            MethodId: methodIdMap.get(method.MethodId) || method.MethodId,
            StationId: method.StationId === sourceTask.TaskId ? destinationTaskId : method.StationId,
          }));
          return clonedType;
        });
        return copy;
      });

    if (previousTargetFlow) {
      clearFlowDrafts(state.invalidFields, state.invalidDrafts, previousTargetFlow);
      try { localStorage.removeItem(`botech.task.layout.${targetTask.TaskId}.${previousTargetFlow.FlowId}`); } catch (_) { /* Layout cache is optional. */ }
    }
    const replaceBy = (items, predicate, replacement) => {
      const index = items.findIndex(predicate);
      if (index >= 0) items[index] = replacement;
      else items.push(replacement);
    };
    replaceBy(state.workspace.Tasks, task => task.TaskId === destinationTaskId, copiedTask);
    replaceBy(state.workspace.Stations, station => station.StationId === destinationTaskId,
      { StationId: destinationTaskId, DisplayName: copiedTask.Name });
    state.workspace.Methods = (state.workspace.Methods || []).filter(method => !taskOwnsMethod(method, destinationTaskId)).concat(copiedMethods);
    state.workspace.MethodFiles = (state.workspace.MethodFiles || []).filter(file => file.taskId !== destinationTaskId).concat(copiedMethodFiles);
    state.workspace.HardwareDefinitions = (state.workspace.HardwareDefinitions || []).filter(item => item.TaskId !== destinationTaskId).concat(copiedHardware);
    state.workspace.Flows = (state.workspace.Flows || []).filter(flow => flow.StationId !== destinationTaskId);
    if (copiedFlow) state.workspace.Flows.push(copiedFlow);
    state.workspace.CanvasLayouts = state.workspace.CanvasLayouts || {};
    if (copiedFlow) {
      state.workspace.CanvasLayouts[destinationTaskId] = sourceLayout;
      try { localStorage.setItem(`botech.task.layout.${destinationTaskId}.${copiedFlow.FlowId}`, JSON.stringify(sourceLayout)); } catch (_) { /* Layout cache is optional. */ }
    } else delete state.workspace.CanvasLayouts[destinationTaskId];
    state.workspace.DataBindings = collectDataBindings();

    if (outputDirectory) state.taskOutputDirectories.set(destinationTaskId, outputDirectory);
    state.stationId = destinationTaskId;
    state.selectedNodeId = copiedFlow?.EntryNodeId || null;
    state.layout = sourceLayout;
    selectedMethodIds.clear();
    methodSelectionAnchor = '';
    canvasEditor.reset(); renderAll(); updateWorkspaceHeader();
    persistProjectDraft();
    setStatus(isNewTask
      ? `已将 ${sourceTask.ClassName} 的配置、方法、流程和硬件复制为 ${copiedTask.ClassName}。`
      : `已将 ${sourceTask.ClassName} 的配置、方法、流程和硬件复制到 ${copiedTask.ClassName}。`, 'normal');
    return copiedTask;
  }

  function addTaskModel(name, template = null) {
    const task = window.EquipmentFlowTaskCodegen.createBlankTask(name);
    const outputDirectory = projectTaskOutputDirectory();
    if (outputDirectory) {
      task.OutputDirectoryPath = outputDirectory.native && outputDirectory.path ? outputDirectory.path : '';
      task.OutputDirectoryName = outputDirectory.name || outputDirectory.legacyHandle?.name || '';
    }
    if (state.workspace.Tasks.some(item => item.ClassName.toLowerCase() === task.ClassName.toLowerCase()))
      throw new Error(`Task 类名 ${task.ClassName} 已存在。`);
    if (template) {
      task.Namespace = template.Template.Namespace;
      task.BaseType = String(template.Template.BaseType || '').trim();
      task.SourceBaseType = task.BaseType;
      task.CreatedFromTemplate = true;
      task.TemplateFileName = template.FileName;
      task.TemplatePrimaryPath = template.PrimarySource;
      const templateClassName = template.Template.ClassName;
      const renamedTemplateSource = source => {
        if (!templateClassName || templateClassName === task.ClassName) return String(source || '');
        const identifier = new RegExp(`(^|[^\\p{L}\\p{N}_])${templateClassName}(?=$|[^\\p{L}\\p{N}_])`, 'gu');
        return String(source || '').replace(identifier, (_match, prefix) => prefix + task.ClassName);
      };
      const templateFiles = template.Files.map(file => ({ ...file, Source: renamedTemplateSource(file.Source) }));
      task.TemplateFiles = templateFiles.map(file => ({ Path: file.Path, Role: file.Role || '', Source: file.Source }));
      task.PrimarySource = (templateFiles.find(file => file.Path === template.PrimarySource) || {}).Source || '';
      const primaryInfo = templateFiles.find(file => file.Path === template.PrimarySource);
      const primaryClasses = primaryInfo ? window.EquipmentFlowCSharpCatalog.parseSource(primaryInfo.Source, primaryInfo.Path).classes : [];
      const taskClass = primaryClasses.find(item => item.name === task.ClassName && item.namespace === task.Namespace);
      task.AccessModifier = taskClass?.AccessModifier === 'internal' ? 'internal' : 'public';
      task.ClassModifier = (taskClass?.Modifiers || []).find(item => ['abstract', 'sealed'].includes(item)) || '';
      task.MethodCategories = template.MethodCategories.map((item, index) => ({ ...item, Order: index }));
      const templateMethods = template.Methods.map((method, index) => {
        const signatureKey = (method.Parameters || []).map(parameter => `${parameter.Direction}:${parameter.TypeName}`).join(',');
        return {
          ...method,
          TaskId: task.TaskId,
          MethodId: method.MethodId || `${task.ClassName}.${method.MethodName}(${signatureKey})`,
          MachineName: '', StationId: '',
          DisplayName: method.DisplayName || method.MethodName,
          SchemaVersion: Number(method.SchemaVersion) || 1,
          CanBind: true,
          ContractIssue: '',
          ResultStatusCodes: method.ResultStatusCodes || [],
          PendingStatusCodes: method.PendingStatusCodes || [],
          AlarmStatusCodes: method.AlarmStatusCodes || [],
          Outcomes: method.ReturnType === 'bool' ? ['true', 'false'] : (method.ResultStatusCodes || []).map(String),
          Parameters: (method.Parameters || []).map(parameter => ({ ...parameter })),
          BodyText: method.BodyText || '',
          AccessModifier: method.AccessModifier || 'private',
          PreserveSource: true,
          ImportedFileName: `${task.ClassName}_Methods.cs`,
          ImportedClassName: task.ClassName,
        };
      });
      state.workspace.Methods.push(...templateMethods);
    }
    const flow = createTaskFlow(task);
    state.workspace.Tasks.push(task);
    if (outputDirectory) state.taskOutputDirectories.set(task.TaskId, outputDirectory);
    state.workspace.Stations.push({ StationId: task.TaskId, DisplayName: task.Name });
    state.workspace.Flows.push(flow);
    state.stationId = task.TaskId;
    state.selectedNodeId = null; state.layout = {};
    canvasEditor.reset(); renderAll(); updateWorkspaceHeader();
    persistProjectDraft();
    closeDialog('taskDialog'); closeTaskTemplateDialog();
    setStatus(`已创建 Task ${task.ClassName}，同步建立 Task 主文件与方法 partial`, 'normal');
    return task;
  }

  function deleteCurrentTask() {
    const task = currentTask();
    if (!task) return;
    if (!window.confirm(`确定删除 Task「${task.Name}」及其流程、方法、硬件定义和暂存编辑内容吗？`)) return;
    state.workspace.Tasks = state.workspace.Tasks.filter(item => item.TaskId !== task.TaskId);
    state.workspace.Stations = state.workspace.Stations.filter(item => item.StationId !== task.TaskId);
    state.workspace.Flows = state.workspace.Flows.filter(item => item.StationId !== task.TaskId);
    state.workspace.Methods = state.workspace.Methods.filter(item => item.TaskId !== task.TaskId);
    state.workspace.HardwareDefinitions = (state.workspace.HardwareDefinitions || []).filter(item => item.TaskId !== task.TaskId);
    state.workspace.MethodFiles = state.workspace.MethodFiles.filter(item => item.taskId !== task.TaskId);
    delete state.workspace.CanvasLayouts[task.TaskId];
    delete state.taskSaveStates[task.TaskId];
    state.taskOutputDirectories.delete(task.TaskId);
    removeStoredFileHandle(`task-output:${task.TaskId}`).catch(() => {});
    state.stationId = state.workspace.Tasks[0] ? state.workspace.Tasks[0].TaskId : '';
    state.selectedNodeId = null; state.layout = {};
    canvasEditor.reset(); renderAll(); updateWorkspaceHeader(); persistProjectDraft({ allTasksDirty: true });
    setStatus(`已删除 Task ${task.ClassName}`, 'normal');
  }

  function switchStation(taskId) {
    const before = currentFlow();
    const wasSuppressing = state.suppressProjectDirty;
    state.suppressProjectDirty = true;
    try {
      if (before) saveLayout(before);
      state.stationId = taskId; state.selectedNodeId = null; state.layout = {};
      canvasEditor.reset(); renderAll(); updateWorkspaceHeader();
      persistProjectDraft();
    } finally {
      state.suppressProjectDirty = wasSuppressing;
    }
    updateProjectSaveStatus();
    setStatus(`已切换到 Task ${currentTask()?.ClassName || ''}`, 'normal');
  }

  function applyTaskTemplateToProject() {
    const template = state.workspace && state.workspace.TaskTemplate;
    if (!template) return;
    state.pendingTaskTemplate = template;
    state.pendingTaskCopySourceId = '';
    $('#newTaskName').value = template.Template.ClassName || '';
    $('#taskDialogTitle').textContent = '按模板新建 Task';
    $('#createTaskButton').textContent = '创建 Task';
    closeTaskTemplateDialog();
    openDialog('taskDialog');
    setTimeout(() => $('#newTaskName').focus(), 0);
  }

  function refreshMethodParameterOrder() {
    const rows = Array.from($('#methodParameterRows').querySelectorAll('.method-parameter-row'));
    rows.forEach((row, index) => {
      const up = row.querySelector('[data-parameter-move="up"]');
      const down = row.querySelector('[data-parameter-move="down"]');
      if (up) up.disabled = index === 0;
      if (down) down.disabled = index === rows.length - 1;
    });
  }

  function addMethodParameterRow(parameter = {}) {
    const row = document.createElement('div');
    row.className = 'method-parameter-row';
    row.innerHTML = `<div class="method-parameter-fields">
      <input class="method-parameter-name" type="text" maxlength="80" placeholder="参数名" value="${esc(parameter.Name || '')}" aria-label="参数名称">
      <input class="method-parameter-type" type="text" maxlength="120" placeholder="类型，例如 int" value="${esc(parameter.TypeName || '')}" aria-label="参数类型">
      <select class="method-parameter-direction" aria-label="参数方向">
        <option value="value">输入（值传递）</option><option value="in">in 只读输入</option><option value="ref">ref 输入/输出</option><option value="out">out 输出</option>
      </select>
      <input class="method-parameter-default" type="text" maxlength="240" placeholder="默认值（常量 / default(T)）" value="${esc(parameter.DefaultValue || '')}" aria-label="参数默认值">
      <label class="method-parameter-params"><input type="checkbox" aria-label="params 参数" ${parameter.IsParams ? 'checked' : ''}> params</label>
      </div><div class="method-parameter-controls">
        <button class="method-parameter-move" data-parameter-move="up" type="button" aria-label="参数上移" title="上移">↑</button>
        <button class="method-parameter-move" data-parameter-move="down" type="button" aria-label="参数下移" title="下移">↓</button>
        <button class="method-parameter-remove" type="button" aria-label="移除参数" title="移除参数">×</button>
      </div>`;
    const direction = ['value', 'in', 'ref', 'out'].includes(parameter.Direction) ? parameter.Direction : 'value';
    row.querySelector('.method-parameter-direction').value = direction;
    row.querySelector('[data-parameter-move="up"]').addEventListener('click', () => {
      const previous = row.previousElementSibling;
      if (previous) row.parentElement.insertBefore(row, previous);
      refreshMethodParameterOrder();
    });
    row.querySelector('[data-parameter-move="down"]').addEventListener('click', () => {
      const next = row.nextElementSibling;
      if (next) row.parentElement.insertBefore(next, row);
      refreshMethodParameterOrder();
    });
    row.querySelector('.method-parameter-remove').addEventListener('click', () => {
      row.remove();
      refreshMethodParameterOrder();
    });
    $('#methodParameterRows').appendChild(row);
    refreshMethodParameterOrder();
  }

  function methodParametersFromForm() {
    return Array.from($('#methodParameterRows').querySelectorAll('.method-parameter-row')).map(row => {
      const direction = row.querySelector('.method-parameter-direction').value;
      const type = row.querySelector('.method-parameter-type').value.trim() || 'object';
      const parameterName = row.querySelector('.method-parameter-name').value.trim() || 'value';
      const defaultValue = row.querySelector('.method-parameter-default').value.trim();
      const isParams = row.querySelector('.method-parameter-params input').checked;
      return {
        Name: parameterName,
        TypeName: type,
        Direction: direction,
        DefaultValue: defaultValue,
        IsParams: isParams,
        FlowName: row.querySelector('.method-parameter-name').value.trim() || 'value',
        Required: direction !== 'out' && !defaultValue && !isParams,
      };
    });
  }

  function methodReturnTypeFromForm() {
    const selection = $('#methodReturnTypeInput').value;
    return selection === '__custom__' ? $('#methodReturnTypeCustomInput').value.trim() : selection;
  }

  function setMethodReturnTypeForm(returnType) {
    const select = $('#methodReturnTypeInput');
    const customInput = $('#methodReturnTypeCustomInput');
    const knownOption = Array.from(select.options).some(option => option.value === returnType && option.value !== '__custom__');
    select.value = knownOption ? returnType : '__custom__';
    customInput.value = knownOption ? '' : returnType;
    customInput.classList.toggle('hidden', knownOption);
    updateMethodDialogControls();
  }

  function updateMethodDialogControls() {
    const custom = $('#methodReturnTypeInput').value === '__custom__';
    $('#methodReturnTypeCustomInput').classList.toggle('hidden', !custom);
    $('#methodStatusCodesInput').closest('.field').classList.toggle('hidden', methodReturnTypeFromForm() !== 'int');
  }

  function findMethodBodyBoundary(source, methodName, searchFrom = 0) {
    const escapedName = String(methodName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const namePattern = new RegExp(`(?<![\\p{L}\\p{N}_])@?${escapedName}(?=\\s*\\()`, 'gu');
    namePattern.lastIndex = Math.max(0, searchFrom);
    const match = namePattern.exec(source);
    if (!match) throw new Error(`无法在代码中定位方法 ${methodName} 的声明。`);
    const nameStart = match.index + (match[0].startsWith('@') ? 1 : 0);
    const nameEnd = namePattern.lastIndex;
    let index = nameEnd;
    while (/\s/u.test(source[index] || '')) index += 1;
    if (source[index] !== '(') throw new Error(`方法 ${methodName} 的参数列表不完整。`);
    let parameterDepth = 0;
    while (index < source.length) {
      const char = source[index];
      if (char === '/' && source[index + 1] === '/') {
        const lineEnd = source.indexOf('\n', index + 2);
        index = lineEnd < 0 ? source.length : lineEnd + 1;
        continue;
      }
      if (char === '/' && source[index + 1] === '*') {
        const commentEnd = source.indexOf('*/', index + 2);
        if (commentEnd < 0) throw new Error('方法签名中的块注释未闭合。');
        index = commentEnd + 2;
        continue;
      }
      if (char === '"') {
        const verbatim = source[index - 1] === '@' || source.slice(Math.max(0, index - 2), index) === '@$';
        const quoteCount = source.startsWith('"""', index) ? 3 : 1;
        let cursor = index + quoteCount;
        let closed = false;
        while (cursor < source.length) {
          if (quoteCount === 3 && source.startsWith('"""', cursor)) { cursor += 3; closed = true; break; }
          if (quoteCount === 1 && !verbatim && source[cursor] === '\\') { cursor += 2; continue; }
          if (quoteCount === 1 && verbatim && source[cursor] === '"' && source[cursor + 1] === '"') { cursor += 2; continue; }
          if (quoteCount === 1 && source[cursor] === '"') { cursor += 1; closed = true; break; }
          cursor += 1;
        }
        if (!closed) throw new Error('方法签名中的字符串未闭合。');
        index = cursor;
        continue;
      }
      if (char === "'") {
        index += 1;
        while (index < source.length) {
          if (source[index] === '\\') { index += 2; continue; }
          if (source[index++] === "'") break;
        }
        continue;
      }
      if (char === '(') parameterDepth += 1;
      else if (char === ')') {
        parameterDepth -= 1;
        if (parameterDepth === 0) {
          index += 1;
          continue;
        }
      } else if (parameterDepth === 0 && char === '{') return { index, kind: 'block', nameStart, nameEnd };
      else if (parameterDepth === 0 && char === '=' && source[index + 1] === '>') return { index, kind: 'expression', nameStart, nameEnd };
      else if (parameterDepth === 0 && char === ';') return { index, kind: 'declaration', nameStart, nameEnd };
      index += 1;
    }
    throw new Error(`无法定位方法 ${methodName} 的函数体。`);
  }

  function generateMethodBodyTemplate() {
    const name = $('#methodNameInput').value.trim() || 'MethodName';
    const returnType = methodReturnTypeFromForm() || 'void';
    const parameters = methodParametersFromForm();
    const originalSource = $('#methodBodyInput').value;
    let parsedOriginal = null;
    if (originalSource.trim()) {
      try { parsedOriginal = parseMethodCodeEditor(originalSource); }
      catch (error) { methodDialogError(`无法只更新函数定义：${error.message}`); return; }
    }
    const draft = {
      MethodName: name,
      AccessModifier: $('#methodAccessInput').value || 'private',
      MethodModifier: $('#methodModifierInput').value || '',
      ReturnType: returnType,
      Parameters: parameters,
      DocumentationSummary: parsedOriginal ? '' : $('#methodSummaryInput').value.trim(),
      AttributeSource: parsedOriginal?.AttributeSource || state.editingMethod?.AttributeSource || '',
      BodyText: '',
    };
    const generatedDefinition = window.EquipmentFlowTaskCodegen.methodSource(draft);
    if (!parsedOriginal) {
      $('#methodBodyInput').value = generatedDefinition;
    } else {
      try {
        const wrappedPrefix = 'namespace __EquipmentFlowMethodEditor {\npublic partial class __EquipmentFlowMethodEditor\n{\n';
        const sourceStart = parsedOriginal.SourceStart - wrappedPrefix.length;
        if (!Number.isInteger(sourceStart) || sourceStart < 0 || sourceStart > originalSource.length) {
          throw new Error('无法定位原函数定义的起始位置。');
        }
        const oldBoundary = findMethodBodyBoundary(originalSource, parsedOriginal.MethodName, sourceStart);
        const newBoundary = findMethodBodyBoundary(generatedDefinition, name, 0);
        let preservedModifiers = originalSource.slice(sourceStart, oldBoundary.nameStart);
        const accessPattern = /\b(?:private\s+protected|protected\s+internal|public|private|protected|internal)\b/u;
        const attributeOffset = parsedOriginal.AttributeSource
          ? Math.max(0, preservedModifiers.indexOf(parsedOriginal.AttributeSource) + parsedOriginal.AttributeSource.length)
          : 0;
        const accessMatch = accessPattern.exec(preservedModifiers.slice(attributeOffset));
        if (!accessMatch) throw new Error('无法定位原函数的访问级别。');
        const accessIndex = attributeOffset + accessMatch.index;
        preservedModifiers = preservedModifiers.slice(0, accessIndex) + draft.AccessModifier
          + preservedModifiers.slice(accessIndex + accessMatch[0].length);
        const accessEnd = accessIndex + draft.AccessModifier.length;
        const modifierTail = preservedModifiers.slice(accessEnd)
          .replace(/\b(?:override|abstract|virtual)\b/g, '')
          .replace(/[ \t]{2,}/g, ' ');
        preservedModifiers = preservedModifiers.slice(0, accessEnd)
          + (draft.MethodModifier ? ` ${draft.MethodModifier}` : '')
          + modifierTail;
        const originalReturnType = String(parsedOriginal.ReturnType || '').trim();
        const returnTypeIndex = originalReturnType ? preservedModifiers.indexOf(originalReturnType, accessIndex + draft.AccessModifier.length) : -1;
        if (returnTypeIndex < 0) throw new Error('无法定位原函数的返回类型。');
        preservedModifiers = preservedModifiers.slice(0, returnTypeIndex) + returnType
          + preservedModifiers.slice(returnTypeIndex + originalReturnType.length);
        if (draft.MethodModifier.split(/\s+/).includes('abstract') && parsedOriginal.SourceForm !== 'declaration') {
          methodDialogError('abstract 方法不能包含函数体。请先将代码改为以分号结束的声明，再保存。');
          return;
        }
        if (parsedOriginal.SourceForm === 'declaration' && !draft.MethodModifier.split(/\s+/).includes('abstract')) {
          $('#methodBodyInput').value = originalSource.slice(0, sourceStart) + generatedDefinition;
          if (methodCodeEditor) methodCodeEditor.paint();
          if (methodCodeEditor) methodCodeEditor.focus();
          $('#methodDialogError').classList.add('hidden');
          setStatus(`已更新 ${name} 的函数定义。`, 'normal');
          return;
        }
        // Replace the declaration and keep the original block / expression body byte-for-byte.
        $('#methodBodyInput').value = originalSource.slice(0, sourceStart)
          + preservedModifiers
          + generatedDefinition.slice(newBoundary.nameStart, newBoundary.index)
          + originalSource.slice(oldBoundary.index);
      } catch (error) {
        methodDialogError(`无法只更新函数定义：${error.message}`);
        return;
      }
    }
    if (methodCodeEditor) methodCodeEditor.paint();
    if (methodCodeEditor) methodCodeEditor.focus();
    $('#methodDialogError').classList.add('hidden');
    setStatus(parsedOriginal ? `已更新 ${name} 的函数定义，原函数体保持不变。` : `已生成 ${name} 的函数定义，请在函数体内编写实现。`, 'normal');
  }

  function restoreMethodCodePanel(closeWindow = true) {
    const codeDialog = $('#methodCodeDialog');
    if (closeWindow && codeDialog.open) codeDialog.close();
    const panel = $('#methodCodePanel');
    const home = $('#methodCodePanelHome');
    if (panel.parentElement !== home) home.appendChild(panel);
    requestAnimationFrame(() => { if (methodCodeEditor) { methodCodeEditor.paint(); methodCodeEditor.layout(); } });
  }

  function openMethodCodeWindow() {
    const panel = $('#methodCodePanel');
    $('#methodCodeDialogBody').appendChild(panel);
    openDialog('methodCodeDialog');
    requestAnimationFrame(() => { if (methodCodeEditor) { methodCodeEditor.paint(); methodCodeEditor.layout(); methodCodeEditor.focus(); } });
  }

  function renderMethodCustomVariables() {
    const list = $('#methodCustomVariableRows');
    if (!list) return;
    const task = currentTask();
    const categories = currentTaskMethodCategories(task);
    const categoryOptions = categories.map(category => `<option value="${esc(category.Name)}">${esc(category.Name)}</option>`).join('');
    const typeOptions = ['bool', 'int', 'string', 'long', 'float', 'double', 'decimal'];
    list.innerHTML = methodCustomVariables.map(variable => `<article class="method-custom-variable-row" data-method-custom-variable="${esc(variable.VariableId)}">
      <div class="method-custom-variable-fields">
        <label>名称<input type="text" data-method-variable-name value="${esc(variable.Name)}" placeholder="例如 IsReady" maxlength="80"></label>
        <label>类型<select data-method-variable-type>${typeOptions.map(type => `<option value="${type}" ${variable.Type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label>
        <label>Region<select data-method-variable-region>${categoryOptions}</select></label>
        <label>形式<select data-method-variable-kind><option value="field" ${variable.MemberKind === 'field' ? 'selected' : ''}>字段</option><option value="property" ${variable.MemberKind === 'property' ? 'selected' : ''}>属性</option></select></label>
        <label>初始值<span class="method-variable-initial"><input type="checkbox" data-method-variable-has-initial ${variable.HasInitialValue ? 'checked' : ''} title="指定初始值"><input type="text" data-method-variable-initial value="${esc(variable.InitializerSource || variable.InitialValue || '')}" ${variable.HasInitialValue ? '' : 'disabled'} placeholder="可选"></span></label>
      </div>
      <button type="button" class="catalog-action" data-remove-method-variable title="删除变量">×</button>
    </article>`).join('');
    list.querySelectorAll('[data-method-custom-variable]').forEach(row => {
      const variable = methodCustomVariables.find(item => item.VariableId === row.dataset.methodCustomVariable);
      if (!variable) return;
      row.querySelector('[data-method-variable-name]').addEventListener('input', event => { variable.Name = event.target.value.trim(); });
      row.querySelector('[data-method-variable-type]').addEventListener('change', event => { variable.Type = event.target.value; });
      row.querySelector('[data-method-variable-region]').value = variable.RegionName;
      row.querySelector('[data-method-variable-region]').addEventListener('change', event => { variable.RegionName = event.target.value; });
      row.querySelector('[data-method-variable-kind]').addEventListener('change', event => { variable.MemberKind = event.target.value; });
      row.querySelector('[data-method-variable-has-initial]').addEventListener('change', event => {
        variable.HasInitialValue = event.target.checked;
        row.querySelector('[data-method-variable-initial]').disabled = !variable.HasInitialValue;
      });
      row.querySelector('[data-method-variable-initial]').addEventListener('input', event => {
        variable.InitialValue = event.target.value;
        variable.InitializerSource = '';
      });
      row.querySelector('[data-remove-method-variable]').addEventListener('click', () => {
        methodCustomVariables = methodCustomVariables.filter(item => item !== variable);
        renderMethodCustomVariables();
      });
    });
  }

  function addTaskVariable() {
    const task = currentTask();
    if (!task) return;
    const categories = currentTaskMethodCategories(task);
    const preferredRegion = $('#methodRegionFilter').value;
    let name = 'Variable1';
    for (let index = 2; methodCustomVariables.some(variable => variable.Name.toLowerCase() === name.toLowerCase()); index++)
      name = 'Variable' + index;
    methodCustomVariables.push({
      VariableId: `task_variable_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      Name: name, Type: 'bool', MemberKind: 'field', HasInitialValue: false, InitialValue: '',
      InitializerSource: '', AccessModifier: 'public', Modifiers: [],
      RegionName: categories.some(category => category.Name === preferredRegion) ? preferredRegion : categories[0]?.Name || 'Common',
    });
    renderMethodCustomVariables();
  }

  function taskVariablesSnapshot() {
    return JSON.stringify(methodCustomVariables);
  }

  function openTaskVariablesDialog() {
    const task = currentTask();
    if (!task) { setStatus('请先新建 Task。', 'warning'); return; }
    methodCustomVariables = JSON.parse(JSON.stringify(Array.isArray(task.MethodVariables) ? task.MethodVariables : []));
    const availableRegions = currentTaskMethodCategories(task).map(category => category.Name);
    const fallbackRegion = availableRegions[0] || 'Common';
    methodCustomVariables.forEach((variable, index) => {
      variable.VariableId ||= `task_variable_saved_${index}`;
      variable.Type ||= 'bool';
      variable.MemberKind ||= 'field';
      variable.HasInitialValue = Boolean(variable.HasInitialValue || variable.InitializerSource);
      variable.AccessModifier ||= 'public';
      variable.Modifiers ||= [];
      if (!availableRegions.includes(variable.RegionName)) variable.RegionName = fallbackRegion;
    });
    $('#taskVariablesDialogError').classList.add('hidden');
    $('#taskVariablesDialogError').textContent = '';
    renderMethodCustomVariables();
    openDialog('taskVariablesDialog');
    taskVariablesDialogBaseline = taskVariablesSnapshot();
  }

  function requestTaskVariablesDialogClose(force = false) {
    const dialog = $('#taskVariablesDialog');
    if (!dialog.open) return;
    if (!force && taskVariablesDialogBaseline && taskVariablesSnapshot() !== taskVariablesDialogBaseline
      && !window.confirm('Task 变量有未保存的修改，确定放弃吗？')) return;
    closeDialog('taskVariablesDialog');
    taskVariablesDialogBaseline = '';
  }

  function taskVariablesDialogError(message) {
    const element = $('#taskVariablesDialogError');
    element.textContent = message;
    element.classList.remove('hidden');
  }

  function saveTaskVariablesFromDialog(event) {
    event.preventDefault();
    const task = currentTask();
    if (!task) return;
    const categories = currentTaskMethodCategories(task).map(item => item.Name);
    const variables = methodCustomVariables.map(variable => ({
      ...variable,
      Name: String(variable.Name || '').trim(),
      Type: String(variable.Type || '').trim().toLowerCase(),
      RegionName: String(variable.RegionName || '').trim(),
      MemberKind: String(variable.MemberKind || 'field').trim().toLowerCase(),
    }));
    const memberNames = new Set(['autorun', task.ClassName.toLowerCase()]);
    (state.workspace.Methods || []).filter(method => taskOwnsMethod(method, task.TaskId)).forEach(method => {
      memberNames.add(String(method.MethodName || '').toLowerCase());
    });
    for (const variable of variables) {
      if (!window.EquipmentFlowTaskCodegen.validIdentifier(variable.Name)) {
        taskVariablesDialogError('变量名称必须是有效的 C# 标识符。'); return;
      }
      if (memberNames.has(variable.Name.toLowerCase())) {
        taskVariablesDialogError(`变量 ${variable.Name} 与当前 Task 的其他成员或方法重名。`); return;
      }
      memberNames.add(variable.Name.toLowerCase());
      if (!['bool', 'int', 'string', 'long', 'float', 'double', 'decimal'].includes(variable.Type)) {
        taskVariablesDialogError(`变量 ${variable.Name} 的类型不受支持。`); return;
      }
      if (!['field', 'property'].includes(variable.MemberKind)) {
        taskVariablesDialogError(`变量 ${variable.Name} 的形式无效。`); return;
      }
      if (!categories.includes(variable.RegionName)) {
        taskVariablesDialogError(`变量 ${variable.Name} 需要选择有效的 Region。`); return;
      }
    }
    try {
      const methods = (state.workspace.Methods || []).filter(method => taskOwnsMethod(method, task.TaskId));
      window.EquipmentFlowTaskCodegen.generateSingleSource('methods', { ...task, MethodVariables: variables }, null, methods);
    } catch (error) {
      taskVariablesDialogError(error.message || String(error)); return;
    }
    task.MethodVariables = variables;
    renderAll();
    updateWorkspaceHeader();
    persistProjectDraft();
    closeDialog('taskVariablesDialog');
    taskVariablesDialogBaseline = '';
    setStatus(`已保存 ${variables.length} 项 Task 变量定义；字段和属性与函数处于同一级别。`, 'normal');
  }

  function methodDialogSnapshot() {
    const parameters = Array.from($('#methodParameterRows').querySelectorAll('.method-parameter-row')).map(row => ({
      Name: row.querySelector('.method-parameter-name').value,
      TypeName: row.querySelector('.method-parameter-type').value,
      Direction: row.querySelector('.method-parameter-direction').value,
      DefaultValue: row.querySelector('.method-parameter-default').value,
      IsParams: row.querySelector('.method-parameter-params input').checked,
    }));
    return JSON.stringify({
      name: $('#methodNameInput').value,
      access: $('#methodAccessInput').value,
      modifier: $('#methodModifierInput').value,
      returnType: $('#methodReturnTypeInput').value,
      customReturnType: $('#methodReturnTypeCustomInput').value,
      category: $('#methodCategoryInput').value,
      statusCodes: $('#methodStatusCodesInput').value,
      summary: $('#methodSummaryInput').value,
      parameters,
      source: $('#methodBodyInput').value,
    });
  }

  function requestMethodDialogClose(force = false) {
    const dialog = $('#methodDialog');
    if (!dialog.open) return;
    if (!force && methodDialogBaseline && methodDialogSnapshot() !== methodDialogBaseline) {
      openDialog('methodClosePrompt');
      return;
    }
    closeDialog('methodDialog');
    state.editingMethod = null;
    methodDialogBaseline = '';
  }

  function openMethodDialog(method = null) {
    const task = currentTask();
    if (!task) { setStatus('请先新建 Task。', 'warning'); return; }
    state.editingMethod = method;
    $('#methodForm').reset();
    $('#methodParameterRows').innerHTML = '';
    $('#methodDialogError').classList.add('hidden');
    $('#methodDialogTitle').textContent = method ? `编辑 ${method.MethodName}` : '新增函数';
    $('#methodNameInput').value = method ? method.MethodName : '';
    $('#methodAccessInput').value = method ? method.AccessModifier || 'private' : 'private';
    let methodModifiers = method && Array.isArray(method.Modifiers)
      ? method.Modifiers.filter(value => ['override', 'abstract', 'virtual'].includes(value)) : [];
    if (method && !methodModifiers.length && method.SourceCode) {
      try { methodModifiers = parseMethodCodeEditor(method.SourceCode).Modifiers || []; } catch (_) { /* Keep the default when an older source cannot be parsed. */ }
    }
    const methodModifier = methodModifiers.includes('abstract') && methodModifiers.includes('override')
      ? 'abstract override'
      : ['override', 'abstract', 'virtual'].find(value => methodModifiers.includes(value)) || '';
    $('#methodModifierInput').value = method?.MethodModifier || methodModifier;
    setMethodReturnTypeForm(method ? method.ReturnType || 'void' : 'int');
    const initialStatuses = window.EquipmentFlowMethodStatuses.normalizeResultStatusCodes(method ? method.ResultStatusCodes || [] : [0, 1]);
    $('#methodStatusCodesInput').value = initialStatuses.join(', ');
    renderStatusCodeEditor($('#methodStatusEditor'), initialStatuses, next => {
      const accepted = window.EquipmentFlowMethodStatuses.validateResultStatusCodesChange(method || {}, next, state.workspace);
      $('#methodStatusCodesInput').value = accepted.join(', ');
      return accepted;
    });
    $('#methodSummaryInput').value = method ? method.DocumentationSummary || '' : '';
    refreshMethodCategorySelect(method ? method.Category || '' : (currentTaskMethodCategories(task)[0]?.Name || ''));
    $('#methodBodyInput').value = method ? window.EquipmentFlowTaskCodegen.methodSource(method) : '';
    let sourceParameters = [];
    if (method && method.SourceCode) {
      try { sourceParameters = parseMethodCodeEditor(method.SourceCode).Parameters || []; } catch (_) { sourceParameters = []; }
    }
    (method && method.Parameters || []).forEach(parameter => {
      const sourceParameter = sourceParameters.find(item => item.Name === parameter.Name);
      addMethodParameterRow({ ...parameter, ...(sourceParameter || {}),
        Direction: sourceParameter ? sourceParameter.Direction : (parameter.Direction === 'in' ? 'value' : parameter.Direction || 'value'),
        DefaultValue: sourceParameter ? sourceParameter.DefaultValue : parameter.DefaultValue || '' });
    });
    restoreMethodCodePanel();
    updateMethodDialogControls();
    if (methodCodeEditor) methodCodeEditor.paint();
    openDialog('methodDialog');
    methodDialogBaseline = methodDialogSnapshot();
    requestAnimationFrame(() => { if (methodCodeEditor) methodCodeEditor.layout(); });
    setTimeout(() => $('#methodNameInput').focus(), 0);
  }

  function openMethodRegionsDialog() {
    if (!currentTask()) return;
    renderMethodRegions(); openDialog('methodRegionsDialog');
  }

  function renderMethodRegions() {
    const task = currentTask();
    const list = $('#methodRegionList');
    if (!task) { list.innerHTML = '<div class="empty-inline">先选择 Task。</div>'; return; }
    const categories = currentTaskMethodCategories(task);
    list.innerHTML = categories.map((category, index) => {
      const count = (state.workspace.Methods || []).filter(method => method.TaskId === task.TaskId && method.Category === category.Name).length;
      return `<div class="method-region-row" data-region-index="${index}"><input class="method-region-name" value="${esc(category.Name)}" aria-label="Region 名稱"><span class="method-region-count">${count} 个方法${index === 0 ? ' · 默认' : ''}</span><div class="method-region-actions"><div class="method-region-order" aria-label="调整 ${esc(category.Name)} 排序"><button class="catalog-action method-region-move" data-region-move="up" type="button" aria-label="${esc(category.Name)} 上移" title="上移" ${index === 0 ? 'disabled' : ''}>↑</button><button class="catalog-action method-region-move" data-region-move="down" type="button" aria-label="${esc(category.Name)} 下移" title="下移" ${index === categories.length - 1 ? 'disabled' : ''}>↓</button></div><button class="catalog-action method-region-save" type="button">保存名称</button><button class="catalog-action method-region-delete" type="button" title="删除后该 Region 的方法移入默认 Region">删除</button></div></div>`;
    }).join('') || '<div class="empty-inline">当前 Task 尚无 Region。可从模板或方法 .cs 的 #region 导入。</div>';
    refreshMethodCategorySelect($('#methodCategoryInput').value);
    list.querySelectorAll('.method-region-move').forEach(button => button.addEventListener('click', () => {
      const row = button.closest('[data-region-index]');
      const category = categories[Number(row.dataset.regionIndex)];
      if (!category) return;
      const movable = categories.slice();
      const index = movable.indexOf(category);
      const nextIndex = index + (button.dataset.regionMove === 'up' ? -1 : 1);
      if (nextIndex < 0 || nextIndex >= movable.length) return;
      [movable[index], movable[nextIndex]] = [movable[nextIndex], movable[index]];
      movable.forEach((item, order) => { item.Order = order; });
      const selectedRegion = $('#methodCategoryInput').value;
      syncTaskMethodCategories(task);
      refreshMethodCategorySelect(selectedRegion);
      renderMethodRegions(); renderMethods(); persistProjectDraft();
      setStatus(`Region「${category.Name}」已${button.dataset.regionMove === 'up' ? '上移' : '下移'}。`, 'normal');
    }));
    list.querySelectorAll('.method-region-save').forEach(button => button.addEventListener('click', () => {
      const row = button.closest('[data-region-index]'), category = categories[Number(row.dataset.regionIndex)];
      const name = row.querySelector('.method-region-name').value.trim();
      if (!name || /[\r\n]|#(?:end)?region/i.test(name)) { setStatus('Region 名称不能为空，也不能包含换行或 #region 指令。', 'error'); return; }
      if (categories.some(item => item !== category && item.Name.toLowerCase() === name.toLowerCase())) { setStatus(`Region ${name} 已存在。`, 'error'); return; }
      const oldName = category.Name;
      category.Name = name; category.RegionName = name;
      state.workspace.Methods.filter(method => method.TaskId === task.TaskId).forEach(method => {
        if (String(method.Category || '').trim().toLowerCase() === oldName.toLowerCase()) method.Category = name;
      });
      (task.MethodVariables || []).forEach(variable => {
        if (String(variable.RegionName || '').trim().toLowerCase() === oldName.toLowerCase()) variable.RegionName = name;
      });
      if ($('#methodRegionFilter').value === oldName) $('#methodRegionFilter').value = name;
      syncTaskMethodCategories(task);
      refreshMethodCategorySelect(name); renderMethodRegions(); renderMethods(); persistProjectDraft();
      setStatus(`方法库 Region 已更新为 ${name}。枚举 Region 保持独立。`, 'normal');
    }));
    list.querySelectorAll('.method-region-delete').forEach(button => button.addEventListener('click', () => {
      const row = button.closest('[data-region-index]'), category = categories[Number(row.dataset.regionIndex)];
      const removedName = category.Name;
      task.MethodCategories = categories.filter(item => item !== category);
      if (!task.MethodCategories.length) task.MethodCategories.push({ Name: 'Common', RegionName: 'Common', Order: 0 });
      task.MethodCategories.forEach((item, index) => { item.Order = index; });
      const fallbackRegion = currentTaskMethodCategories(task)[0]?.Name || 'Common';
      (state.workspace.Methods || []).filter(method => method.TaskId === task.TaskId).forEach(method => {
        if (String(method.Category || '').trim().toLowerCase() === removedName.toLowerCase()) method.Category = fallbackRegion;
      });
      (task.MethodVariables || []).forEach(variable => {
        if (String(variable.RegionName || '').trim().toLowerCase() === removedName.toLowerCase()) variable.RegionName = fallbackRegion;
      });
      if ($('#methodRegionFilter').value === removedName) $('#methodRegionFilter').value = fallbackRegion;
      syncTaskMethodCategories(task);
      refreshMethodCategorySelect(); renderMethodRegions(); renderMethods(); persistProjectDraft();
      setStatus(`已删除 Region ${removedName}；所属方法和变量已移入 ${fallbackRegion}。`, 'normal');
    }));
  }

  function addMethodRegion() {
    const task = currentTask(); if (!task) return;
    const input = $('#newMethodRegionNameInput'), name = input.value.trim();
    if (!name || /[\r\n]|#(?:end)?region/i.test(name)) { setStatus('Region 名称不能为空，也不能包含换行或 #region 指令。', 'error'); return; }
    if (!addTaskMethodCategory(task, name)) { setStatus(`方法库 Region ${name} 已存在或名称无效。`, 'error'); return; }
    input.value = ''; renderMethodRegions(); renderMethods();
    refreshMethodCategorySelect(name);
    persistProjectDraft(); setStatus(`已添加方法库 Region：${name}`, 'normal');
  }

  function methodDialogError(message) {
    const element = $('#methodDialogError');
    element.textContent = message;
    element.classList.remove('hidden');
  }

  function parseMethodCodeEditor(source) {
    const wrapped = `namespace __EquipmentFlowMethodEditor {\npublic partial class __EquipmentFlowMethodEditor\n{\n${source}\n}\n}`;
    const parsed = window.EquipmentFlowCSharpCatalog.parseSource(wrapped, '__MethodEditor.cs');
    const methods = parsed.classes.flatMap(classType => classType.methods || []);
    if (methods.length !== 1) throw new Error('代码框中需要且只能包含一个完整 C# 方法。');
    return methods[0];
  }

  function normalizeCodeType(value) { return String(value || '').replace(/\s+/g, ''); }

  function unindentMethodBody(value) {
    const lines = String(value || '').replace(/\r\n/g, '\n').split('\n');
    const indents = lines.filter(line => line.trim()).map(line => (line.match(/^\s*/) || [''])[0].length);
    const commonIndent = indents.length ? Math.min(...indents) : 0;
    return lines.map(line => line.slice(Math.min(commonIndent, line.length))).join('\n').trim();
  }

  function saveMethodFromDialog(event) {
    event.preventDefault();
    const task = currentTask();
    if (!task) return;
    const name = $('#methodNameInput').value.trim();
    const returnType = methodReturnTypeFromForm();
    const methodModifier = $('#methodModifierInput').value || '';
    const category = $('#methodCategoryInput').value.trim();
    if (!window.EquipmentFlowTaskCodegen.validIdentifier(name)) { methodDialogError('方法名必须是有效的 C# 标识符，不能使用关键字。'); return; }
    if ((task.MethodVariables || []).some(variable => String(variable.Name || '').toLowerCase() === name.toLowerCase())) {
      methodDialogError(`函数名 ${name} 与 Task 变量重名，请修改其中一个名称。`); return;
    }
    if (!returnType || !/^(?:[\p{L}_][\p{L}\p{N}_]*(?:\s*<[^\r\n]+>)?(?:\[\])?\??|void)$/u.test(returnType)) { methodDialogError('返回类型格式不正确，请选择类型或填写自定义类型。'); return; }
    const hasAbstractTaskPartial = (state.workspace.MethodFiles || []).some(file => file.taskId === task.TaskId
      && (file.classes || []).some(classType => classType.name === task.ClassName
        && (classType.Modifiers || []).includes('abstract')));
    if (methodModifier.split(/\s+/).includes('abstract') && task.ClassModifier !== 'abstract' && !hasAbstractTaskPartial) {
      methodDialogError('abstract 方法要求当前 Task 类也设置为 abstract，请先在 Task 管理中修改类修饰符。'); return;
    }
    if (!category || /[\r\n]|#(?:end)?region/i.test(category)) { methodDialogError('方法分类不能为空，也不能包含换行或 #region 指令。'); return; }
    const parameters = methodParametersFromForm();
    const names = new Set();
    let optionalParameterSeen = false;
    for (const parameter of parameters) {
      if (!window.EquipmentFlowTaskCodegen.validIdentifier(parameter.Name) || !parameter.TypeName) { methodDialogError('每个参数都需要填写有效名称和类型。'); return; }
      if (names.has(parameter.Name)) { methodDialogError(`参数 ${parameter.Name} 重复。`); return; }
      names.add(parameter.Name);
      if (parameter.DefaultValue && ['ref', 'out'].includes(parameter.Direction)) {
        methodDialogError(`${parameter.Direction} 参数不能设置默认值。`); return;
      }
      if (parameter.IsParams && (parameter.Direction !== 'value' || parameter.DefaultValue)) {
        methodDialogError('params 参数只能按值传递，不能使用默认值或 in/ref/out。'); return;
      }
      if (parameter.IsParams && parameters.indexOf(parameter) !== parameters.length - 1) {
        methodDialogError('params 参数必须放在最后，请调整参数顺序。'); return;
      }
      if (parameter.DefaultValue || parameter.IsParams) optionalParameterSeen = true;
      else if (optionalParameterSeen) {
        methodDialogError('C# 要求必填参数排在可选参数前面，请调整参数顺序或补充默认值。'); return;
      }
    }
    let statuses = [];
    try {
      statuses = returnType === 'int'
        ? window.EquipmentFlowMethodStatuses.validateResultStatusCodesChange(state.editingMethod || {}, $('#methodStatusCodesInput').value, state.workspace)
        : [];
    } catch (error) { methodDialogError(error.message); return; }
    const signatureKey = csharpMethodSignatureKey({ MethodName: name, Parameters: parameters });
    const duplicate = state.workspace.Methods.find(item => item.TaskId === task.TaskId && item !== state.editingMethod
      && csharpMethodSignatureKey(item) === signatureKey);
    if (duplicate) { methodDialogError(`同一 Task 中已经存在相同签名：${duplicate.Signature || duplicate.MethodName}`); return; }
    let sourceCode = $('#methodBodyInput').value.replace(/\r\n/g, '\n').trim();
    let parsedSource = null;
    if (sourceCode) {
      try { parsedSource = parseMethodCodeEditor(sourceCode); }
      catch (error) { methodDialogError(`完整函数代码无法解析：${error.message}`); return; }
      const expectedParameters = parameters.map(parameter => [parameter.Direction, normalizeCodeType(parameter.TypeName), parameter.Name, normalizeCodeType(parameter.DefaultValue), Boolean(parameter.IsParams)]);
      const actualParameters = (parsedSource.Parameters || []).map(parameter => [parameter.Direction || 'value', normalizeCodeType(parameter.TypeName), parameter.Name, normalizeCodeType(parameter.DefaultValue), Boolean(parameter.IsParams)]);
      const expectedModifiers = methodModifier.split(/\s+/).filter(Boolean).sort();
      const actualModifiers = (parsedSource.Modifiers || []).filter(value => ['override', 'abstract', 'virtual'].includes(value)).sort();
      const signatureMatches = parsedSource.MethodName === name
        && normalizeCodeType(parsedSource.ReturnType) === normalizeCodeType(returnType)
        && parsedSource.AccessModifier === $('#methodAccessInput').value
        && JSON.stringify(actualModifiers) === JSON.stringify(expectedModifiers)
        && JSON.stringify(actualParameters) === JSON.stringify(expectedParameters);
      if (!signatureMatches) {
        methodDialogError('代码框中的函数签名与左侧属性不一致。请确认名称、访问级别、修饰符、返回类型和参数，再点击“生成模版”同步签名。');
        return;
      }
      if (methodModifier.split(/\s+/).includes('abstract') && parsedSource.SourceForm !== 'declaration') {
        methodDialogError('abstract 方法不能包含函数体，请将代码改为以分号结束的声明。');
        return;
      }
    } else {
      const outputs = parameters.filter(parameter => parameter.Direction === 'out')
        .map(parameter => `${parameter.Name} = default(${parameter.TypeName});`);
      if (returnType === 'int') outputs.push(`return ${statuses[0]};`);
      else if (returnType === 'bool') outputs.push('return false;');
      else if (returnType !== 'void') outputs.push(`return default(${returnType});`);
      const body = outputs.join('\n');
      sourceCode = window.EquipmentFlowTaskCodegen.methodSource({
        MethodName: name,
        AccessModifier: $('#methodAccessInput').value,
        MethodModifier: methodModifier,
        ReturnType: returnType,
        Parameters: parameters,
        DocumentationSummary: $('#methodSummaryInput').value.trim(),
        AttributeSource: state.editingMethod?.AttributeSource || '',
        BodyText: body,
      });
      try { parsedSource = parseMethodCodeEditor(sourceCode); }
      catch (error) { methodDialogError(`无法生成完整函数代码：${error.message}`); return; }
    }
    if (returnType === 'int') {
      try {
        sourceCode = window.EquipmentFlowCSharpCatalog.updateResultStatusCodes(sourceCode, name, statuses);
        parsedSource = parseMethodCodeEditor(sourceCode);
      } catch (error) { methodDialogError(`无法保存返回状态码：${error.message}`); return; }
    }
    const body = unindentMethodBody(parsedSource.BodyText);
    const method = state.editingMethod || {};
    Object.assign(method, {
      TaskId: task.TaskId,
      MethodId: method.MethodId || `${task.ClassName}.${name}(${parameters.map(parameter => `${parameter.Direction}:${parameter.TypeName}`).join(',')})`,
      MethodName: name, DisplayName: name,
      AccessModifier: $('#methodAccessInput').value,
      MethodModifier: methodModifier,
      Modifiers: parsedSource.Modifiers || [],
      ReturnType: returnType,
      DocumentationSummary: $('#methodSummaryInput').value.trim(),
      Category: category,
      SchemaVersion: Number(method.SchemaVersion) || 1,
      Parameters: parameters,
      ParameterModelVersion: 2,
      ResultStatusCodes: returnType === 'int' ? statuses : [],
      PendingStatusCodes: returnType === 'int' ? (method.PendingStatusCodes || []).slice() : [],
      AlarmStatusCodes: returnType === 'int' ? (method.AlarmStatusCodes || []).slice() : [],
      Outcomes: returnType === 'bool' ? ['true', 'false'] : returnType === 'int' ? statuses.map(String) : [],
      NodeType: returnType === 'bool' ? 'Condition' : 'Action',
      CanBind: true, ContractIssue: '',
      BodyText: body,
      SourceCode: sourceCode,
      PreserveSource: true,
      AttributeSource: parsedSource.AttributeSource || method.AttributeSource || '',
      Signature: `${returnType} ${name}(${parameters.map(parameter => `${parameter.IsParams ? 'params ' : ''}${['in', 'ref', 'out'].includes(parameter.Direction) ? `${parameter.Direction} ` : ''}${parameter.TypeName} ${parameter.Name}${parameter.DefaultValue ? ` = ${parameter.DefaultValue}` : ''}`).join(', ')})`,
      ImportedFileName: `${task.ClassName}_Methods.cs`, ImportedClassName: task.ClassName,
    });
    delete method.CustomVariables;
    if (!state.editingMethod) state.workspace.Methods.push(method);
    addTaskMethodCategory(task, category);
    state.workspace.Flows.filter(item => item.StationId === task.TaskId).forEach(taskFlow => taskFlow.Nodes.forEach(node => {
      if (node.MethodId !== method.MethodId) return;
      node.DisplayName = method.DisplayName;
      node.NodeType = method.ReturnType === 'bool' ? 'Condition' : 'Action';
    }));
    state.editingMethod = null;
    closeDialog('methodDialog');
    renderAll(); updateWorkspaceHeader(); persistProjectDraft();
    setStatus(`已保存 ${method.AccessModifier} ${method.Signature} 到 ${task.ClassName}_Methods.cs`, 'normal');
  }

  // Input helpers: device-specific context menus, copy/paste support, and editor presentation.
  function showContextMenu(x, y, items) {
    const menu = $('#deviceContextMenu');
    menu.innerHTML = '';
    items.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = item.label;
      button.disabled = Boolean(item.disabled);
      button.addEventListener('click', () => { hideContextMenu(); item.action(); });
      menu.appendChild(button);
    });
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))}px`;
    menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))}px`;
  }

  function deleteSelectedMethods() {
    const task = currentTask();
    if (!task || !selectedMethodIds.size) return;
    const selected = (state.workspace.Methods || []).filter(method => method.TaskId === task.TaskId && selectedMethodIds.has(method.MethodId));
    if (!selected.length) return;
    const preview = selected.slice(0, 4).map(method => method.MethodName).join('、');
    const suffix = selected.length > 4 ? ` 等 ${selected.length} 个方法` : '';
    if (!window.confirm(`确定删除 ${preview}${suffix} 吗？`)) return;
    const removedIds = new Set(selected.map(method => method.MethodId));
    state.workspace.Methods = state.workspace.Methods.filter(method => !removedIds.has(method.MethodId));
    selectedMethodIds.clear(); methodSelectionAnchor = '';
    renderAll(); persistProjectDraft();
    setStatus(`已删除 ${selected.length} 个方法。相关流程节点会显示未绑定方法，便于重新绑定。`, 'normal');
  }

  function hideContextMenu() {
    const menu = $('#deviceContextMenu');
    if (menu) menu.classList.add('hidden');
  }

  function textForContextCopy(event) {
    const target = event.target;
    if (target.closest('#methodCodeMonaco')) return methodCodeEditor ? methodCodeEditor.getSelectedText() : '';
    const field = target.closest('input:not([type="file"]), textarea');
    if (field) {
      try {
        const start = Number.isInteger(field.selectionStart) ? field.selectionStart : 0;
        const end = Number.isInteger(field.selectionEnd) ? field.selectionEnd : 0;
        return start !== end ? field.value.slice(start, end) : field.value;
      } catch (_) { return field.value || ''; }
    }
    const selection = String(window.getSelection ? window.getSelection() : '');
    if (selection) return selection;
    const copyable = target.closest('button, [role="button"], td, th, summary, label, strong, small, span, p, h1, h2, h3, li, .enum-sheet-tab, .hardware-resource-row, .hardware-factory-row, .hardware-slot-row, #hardwareCatalogFiles [data-copy-text]');
    return copyable ? (copyable.dataset.copyText || copyable.innerText || copyable.textContent || '').trim() : '';
  }

  async function copyText(text, successMessage = '已复制到剪贴板。') {
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text);
      else throw new Error('Clipboard API unavailable');
    } catch (_) {
      const helper = document.createElement('textarea');
      helper.value = text; helper.setAttribute('readonly', '');
      helper.style.position = 'fixed'; helper.style.opacity = '0';
      document.body.appendChild(helper); helper.select();
      const copied = document.execCommand('copy'); helper.remove();
      if (!copied) { setStatus('复制失败：浏览器未授予剪贴板权限。', 'error'); return; }
    }
    setStatus(successMessage, 'normal');
  }

  function canvasContextMenu(event) {
    event.preventDefault();
    const nodeElement = event.target.closest('[data-node-id]');
    const edgeElement = event.target.closest('[data-edge-index]');
    if (nodeElement) {
      const node = currentFlow()?.Nodes.find(item => item.NodeId === nodeElement.dataset.nodeId);
      if (!node) return;
      canvasEditor.selectNodeById(node.NodeId);
      const items = [
        { label: '复制节点', action: () => canvasEditor.copy() },
        ...(!['Start', 'End'].includes(node.NodeType) ? [{ label: '编辑节点名称', action: () => { const value = window.prompt('节点名称', node.DisplayName || node.NodeId); if (value != null && value.trim()) updateNodeField('DisplayName', value.trim(), true); } }] : []),
      ];
      const method = methodFor(node);
      if (method) items.push({ label: `编辑方法：${method.MethodName}`, action: () => openMethodDialog(method) });
      items.push({ label: '删除节点', action: deleteSelectedNode });
      showContextMenu(event.clientX, event.clientY, items);
      return;
    }
    if (edgeElement) {
      const index = Number(edgeElement.dataset.edgeIndex);
      canvasEditor.selectEdgeByIndex(index);
      const edge = currentFlow()?.Transitions[index];
      if (!edge) return;
      showContextMenu(event.clientX, event.clientY, [
        { label: '编辑分支状态', action: () => { const value = window.prompt('分支状态值（例如 0、1、true、false、*）', edge.Outcome); if (value != null && value.trim()) updateTransition(index, 'Outcome', value.trim()); } },
        { label: '删除连线', action: () => removeTransition(index) },
      ]);
      return;
    }
    hideContextMenu();
  }

  const canvasEditor = window.EquipmentFlowCanvas.create({
    getFlow: currentFlow, getLayout: () => state.layout, getSelected: () => state.selectedNodeId,
    setSelected: id => { state.selectedNodeId = id; state.activeInspector = 'node'; },
    methodFor, persist: () => saveLayout(currentFlow()),
    refresh: () => { updateWorkspaceHeader(); renderFlow(); },
    restore: snapshot => {
      const flow = currentFlow();
      if (!flow) return;
      const index = state.workspace.Flows.indexOf(flow);
      state.workspace.Flows[index] = snapshot.flow;
      state.layout = snapshot.layout; state.invalidFields.clear(); state.invalidDrafts.clear();
    },
    onNodeDoubleClick: node => {
      const method = methodFor(node);
      if (!method) return false;
      setWorkspaceView('flow');
      openMethodDialog(method);
      return true;
    },
    selectionChanged: () => { updateInspectorTab(); renderInspector(); },
    addShape: addControlNode, status: setStatus,
  });
  const METHOD_FONT_KEY = 'botech.task-editor.code-font';
  function applyMethodEditorFont(save = true) {
    const selector = $('#methodEditorFontSelect');
    const customInput = $('#methodCodeFontCustomInput');
    const custom = selector.value === '__custom__';
    customInput.classList.toggle('hidden', !custom);
    let family = custom ? customInput.value.trim() : selector.value;
    if (!/^[\p{L}\p{N}_ .-]{1,80}$/u.test(family || '')) family = 'Consolas';
    const size = Math.max(13, Math.min(18, Number($('#methodCodeFontSizeSelect').value) || 15));
    document.documentElement.style.setProperty('--method-code-font-family', `${JSON.stringify(family)}, Consolas, "Cascadia Code", monospace`);
    document.documentElement.style.setProperty('--method-code-font-size', `${size}px`);
    if (save) {
      try { localStorage.setItem(METHOD_FONT_KEY, JSON.stringify({ family, custom, size })); } catch (_) { /* Preference storage is optional. */ }
    }
    if (methodCodeEditor) methodCodeEditor.paint();
  }

  function restoreMethodEditorFont() {
    try {
      const saved = JSON.parse(localStorage.getItem(METHOD_FONT_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        const selector = $('#methodEditorFontSelect');
        const choices = Array.from(selector.options).map(option => option.value);
        if (saved.custom || !choices.includes(saved.family)) {
          selector.value = '__custom__';
          $('#methodCodeFontCustomInput').value = String(saved.family || 'Consolas');
        } else selector.value = saved.family;
        $('#methodCodeFontSizeSelect').value = String(Math.max(13, Math.min(18, Number(saved.size) || 15)));
      }
    } catch (_) { /* Invalid preference falls back to the editor defaults. */ }
    applyMethodEditorFont(false);
  }

  function methodCodeCompletions() {
    const task = currentTask();
    const methodItems = (state.workspace?.Methods || []).filter(method => !task || method.TaskId === task.TaskId).map(method => ({
      label: method.MethodName, insertText: method.MethodName,
      kind: 'method', detail: `${method.ReturnType || 'void'} · ${method.Signature || method.MethodName}`,
    }));
    const hardwareItems = (state.workspace?.HardwareCatalogResources || []).map(resource => ({
      label: resource.Name || resource.ResourceName || resource.MemberName,
      kind: 'hardware', detail: `${resource.Type || '硬件'} · ${resource.SourceFile || '已导入资源'}`,
    })).filter(item => item.label);
    let parameterItems = [];
    try {
      parameterItems = methodParametersFromForm().map(parameter => ({
        label: parameter.Name, insertText: parameter.Name, kind: 'parameter',
        detail: `${['in', 'ref', 'out'].includes(parameter.Direction) ? `${parameter.Direction} ` : ''}${parameter.TypeName} 参数`,
      })).filter(item => item.label);
    } catch (_) { /* Method dialog may not have a current parameter form. */ }
    const keywords = ['if', 'else', 'switch', 'case', 'return', 'for', 'foreach', 'while', 'do', 'try', 'catch', 'finally', 'throw',
      'true', 'false', 'null', 'default', 'this', 'new', 'var', 'is', 'as', 'await', 'async', 'int', 'bool', 'string', 'void', 'Task', 'out', 'ref', 'in'];
    return [...methodItems, ...hardwareItems, ...parameterItems,
      ...keywords.map(label => ({ label, kind: ['int', 'bool', 'string', 'void', 'Task'].includes(label) ? 'type' : 'keyword', detail: 'C# 关键字 / 类型' }))];
  }
  methodCodeEditor = window.EquipmentFlowCodeEditor.mount({
    textarea: $('#methodBodyInput'), container: $('#methodCodeMonaco'),
    getCompletions: methodCodeCompletions,
  });
  restoreMethodEditorFont();
  window.EquipmentFlowEditor = { createNewTask, deleteCurrentTask, saveProject, exportCurrentTaskSources, exportDrawio, importDrawio,
    getWorkspace: () => state.workspace, getCurrentTask: currentTask, getTaskTemplate: () => state.workspace && state.workspace.TaskTemplate, getCanvas: () => canvasEditor };
  $('#stationSelect').addEventListener('change', event => switchStation(event.target.value));
  $('#taskBaseTypeSelect').addEventListener('change', event => {
    const customBase = $('#taskBaseTypeCustom');
    const isCustom = event.target.value === CUSTOM_TASK_BASE;
    customBase.classList.toggle('hidden', !isCustom);
    customBase.disabled = !isCustom;
    if (isCustom) {
      const task = currentTask();
      if (!customBase.value && task) customBase.value = task.BaseType || '';
      customBase.focus();
      customBase.select();
      return;
    }
    saveTaskClassSetting('BaseType', event.target.value);
  });
  $('#taskBaseTypeCustom').addEventListener('change', event => saveTaskClassSetting('BaseType', event.target.value));
  $('#taskBaseTypeCustom').addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    saveTaskClassSetting('BaseType', event.target.value);
    event.target.blur();
  });
  $('#taskClassModifierSelect').addEventListener('change', event => saveTaskClassSetting('ClassModifier', event.target.value));
  $('#taskAccessModifierSelect').addEventListener('change', event => saveTaskClassSetting('AccessModifier', event.target.value));
  $('#newTaskButton').addEventListener('click', createNewTask);
  $('#newTaskMenuButton').addEventListener('click', createNewTask);
  $('#copyTaskAsNewButton').addEventListener('click', copyTaskAsNew);
  $('#copyTaskIntoExistingButton').addEventListener('click', openCopyTaskIntoExisting);
  $('#deleteTaskButton').addEventListener('click', deleteCurrentTask);
  $('#copyTaskTargetSelect').addEventListener('change', updateCopyTaskTargetSummary);
  $('#copyTaskTargetForm').addEventListener('submit', event => {
    event.preventDefault();
    const source = state.workspace.Tasks.find(task => task.TaskId === $('#copyTaskTargetDialog').dataset.sourceTaskId);
    const target = state.workspace.Tasks.find(task => task.TaskId === $('#copyTaskTargetSelect').value);
    if (!source || !target || source.TaskId === target.TaskId) {
      setStatus('来源或目标 Task 已变化，请重新选择。', 'error');
      closeDialog('copyTaskTargetDialog');
      return;
    }
    const counts = taskCopyCounts(source.TaskId);
    if (!window.confirm(`将 ${counts.methods} 个方法、${counts.nodes} 个流程节点和 ${counts.hardware} 个硬件类复制到 ${target.ClassName}，并替换目标对应内容。目标命名空间、类名、Task ID 和输出目录会保留。此操作不能自动撤销，是否继续？`)) return;
    try {
      copyTaskContents(source, target, false);
      closeDialog('copyTaskTargetDialog');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });
  $('#taskForm').addEventListener('submit', event => {
    event.preventDefault();
    try {
      const copySource = state.workspace.Tasks.find(task => task.TaskId === state.pendingTaskCopySourceId);
      if (copySource) {
        const className = $('#newTaskName').value.trim();
        const copiedTask = window.EquipmentFlowTaskCodegen.createBlankTask(className);
        copiedTask.TaskId = createCopiedTaskId(className);
        copyTaskContents(copySource, copiedTask, true);
        closeDialog('taskDialog');
      } else addTaskModel($('#newTaskName').value.trim(), state.pendingTaskTemplate);
      state.pendingTaskTemplate = null;
      state.pendingTaskCopySourceId = '';
    }
    catch (error) { setStatus(error.message, 'error'); $('#newTaskName').setCustomValidity(error.message); $('#newTaskName').reportValidity(); }
  });
  $('#taskDialog').addEventListener('close', () => {
    state.pendingTaskTemplate = null;
    state.pendingTaskCopySourceId = '';
    $('#createTaskButton').textContent = '创建 Task';
    $('#taskDialogTitle').textContent = '新建 Task';
  });
  $('#newTaskName').addEventListener('input', event => event.target.setCustomValidity(''));
  $$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.closeDialog === 'methodDialog') requestMethodDialogClose();
    else if (button.dataset.closeDialog === 'taskVariablesDialog') requestTaskVariablesDialogClose();
    else closeDialog(button.dataset.closeDialog);
  }));
  $('#generatedFileSuccessFolders').addEventListener('click', async event => {
    const button = event.target.closest('[data-open-generated-output-folder]');
    if (!button) return;
    const error = $('#generatedFileSuccessError');
    button.disabled = true;
    error.textContent = '';
    error.classList.add('hidden');
    try {
      await window.EquipmentFlowNativeOutput.openDirectory(button.dataset.outputDirectoryPath || '');
    } catch (exception) {
      error.textContent = `打开输出文件夹失败：${exception.message || exception}`;
      error.classList.remove('hidden');
    } finally { button.disabled = false; }
  });
  $('#openSavedProjectFolderButton').addEventListener('click', async () => {
    const dialog = $('#projectSaveSuccessDialog');
    const button = $('#openSavedProjectFolderButton');
    const error = $('#projectSaveSuccessError');
    button.disabled = true;
    error.textContent = '';
    error.classList.add('hidden');
    try {
      await window.EquipmentFlowNativeOutput.openDirectory(dialog.dataset.projectDirectoryPath || '');
      closeDialog('projectSaveSuccessDialog');
    } catch (exception) {
      error.textContent = `打开保存文件夹失败：${exception.message || exception}`;
      error.classList.remove('hidden');
    } finally { button.disabled = false; }
  });
  $('#changeSavedProjectPathButton').addEventListener('click', async () => {
    const button = $('#changeSavedProjectPathButton');
    const error = $('#projectSaveSuccessError');
    button.disabled = true;
    error.textContent = '';
    error.classList.add('hidden');
    try { await saveProjectAs(); }
    finally { button.disabled = false; }
  });
  $('#newMethodButton').addEventListener('click', () => openMethodDialog());
  $('#manageTaskVariablesButton').addEventListener('click', openTaskVariablesDialog);
  $('#methodForm').addEventListener('submit', saveMethodFromDialog);
  $('#methodQuickSaveButton').addEventListener('click', () => saveMethodFromDialog({ preventDefault() {} }));
  $('#methodDialog').addEventListener('cancel', event => { event.preventDefault(); requestMethodDialogClose(); });
  $('#methodDialog').addEventListener('close', () => {
    methodDialogBaseline = '';
    if ($('#methodCodeDialog').open) restoreMethodCodePanel();
  });
  $('#continueMethodEditingButton').addEventListener('click', () => closeDialog('methodClosePrompt'));
  $('#discardMethodChangesButton').addEventListener('click', () => {
    closeDialog('methodClosePrompt');
    requestMethodDialogClose(true);
  });
  $('#saveAndCloseMethodButton').addEventListener('click', () => {
    closeDialog('methodClosePrompt');
    saveMethodFromDialog({ preventDefault() {} });
  });
  $('#taskVariablesForm').addEventListener('submit', saveTaskVariablesFromDialog);
  $('#addTaskVariableButton').addEventListener('click', addTaskVariable);
  $('#taskVariablesDialog').addEventListener('cancel', event => { event.preventDefault(); requestTaskVariablesDialogClose(); });
  $('#taskVariablesDialog').addEventListener('close', () => { taskVariablesDialogBaseline = ''; });
  $('#addParameterButton').addEventListener('click', () => addMethodParameterRow());
  $('#generateMethodTemplateButton').addEventListener('click', generateMethodBodyTemplate);
  $('#methodReturnTypeInput').addEventListener('change', () => {
    updateMethodDialogControls();
    if ($('#methodReturnTypeInput').value === '__custom__') $('#methodReturnTypeCustomInput').focus();
  });
  $('#methodReturnTypeCustomInput').addEventListener('input', updateMethodDialogControls);
  $('#methodEditorFontSelect').addEventListener('change', () => {
    applyMethodEditorFont();
    if ($('#methodEditorFontSelect').value === '__custom__') $('#methodCodeFontCustomInput').focus();
  });
  $('#methodCodeFontCustomInput').addEventListener('input', () => applyMethodEditorFont());
  $('#methodCodeFontSizeSelect').addEventListener('change', () => applyMethodEditorFont());
  $('#expandMethodEditorButton').addEventListener('click', openMethodCodeWindow);
  $('#restoreMethodEditorButton').addEventListener('click', () => restoreMethodCodePanel());
  $('#methodCodeDialog').addEventListener('close', () => restoreMethodCodePanel(false));
  $('#manageMethodRegionsButton').addEventListener('click', openMethodRegionsDialog);
  $('#addMethodRegionButton').addEventListener('click', addMethodRegion);
  $('#newMethodRegionNameInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addMethodRegion(); } });
  $('#saveButton').addEventListener('click', saveProject);
  $('#saveAsProjectButton').addEventListener('click', saveProjectAs);
  // UI event wiring: connect toolbar, menus, canvas, panels, and editor dialogs to their actions.
  $('#downloadGenerateButton').addEventListener('click', exportAllTaskSources);
  $('#exportTaskSourcesMenuButton').addEventListener('click', exportCurrentTaskSources);
  $('#flowSourceButton')?.addEventListener('click', () => exportCurrentTaskSource('flow'));
  $('#methodsSourceButton')?.addEventListener('click', () => exportCurrentTaskSource('methods'));
  $('#hardwareSourceButton')?.addEventListener('click', () => exportCurrentTaskSource('hardware'));
  $('#chooseTaskOutputDirectoryButton').addEventListener('click', chooseTaskOutputDirectory);
  $('#openProjectButton').addEventListener('click', openProjectFromPicker);
  $('#flowWorkspaceMenuButton').addEventListener('click', () => setWorkspaceView('flow'));
  $('#enumWorkspaceMenuButton').addEventListener('click', () => window.EquipmentFlowEnumWorkbench.openWorkbook());
  $('#projectFile').addEventListener('change', async event => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try { await openProject(JSON.parse(await file.text())); }
    catch (error) { showResult({ Success: false, Message: error.message, Diagnostics: [error.message] }, false); }
    event.target.value = '';
  });
  $('#methodSearch').addEventListener('input', renderMethods);
  $('#methodModifierFilter').addEventListener('change', renderMethods);
  $('#methodRegionFilter').addEventListener('change', renderMethods);
  $('#validateButton').addEventListener('click', () => {
    closeDiagnostics();
    const diagnostics = collectProjectValidationDiagnostics();
    showResult({ Success: diagnostics.length === 0, Diagnostics: diagnostics.length ? diagnostics : ['全部 Task、方法、硬件和枚举数据均可生成。'] }, false);
  });
  $('#importMethodsButton').addEventListener('click', () => $('#methodLibraryFile').click());
  $('#methodLibraryFile').addEventListener('change', event => {
    const files = event.target.files && Array.from(event.target.files);
    if (files && files.length) importMethodLibrary(files).catch(error => {
      showResult({ Success: false, Message: error.message, Diagnostics: [error.message] }, false);
    });
    event.target.value = '';
  });
  $('#importTaskTemplateButton').addEventListener('click', () => $('#taskTemplateFile').click());
  $('#viewTaskTemplateButton').addEventListener('click', () => {
    if (!state.workspace || !state.workspace.TaskTemplate) return;
    renderTaskTemplatePreview(state.workspace.TaskTemplate);
    openTaskTemplateDialog();
  });
  $('#taskTemplateFile').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    if (file) importTaskTemplate(file).catch(error => showResult({ Success: false, Message: error.message, Diagnostics: [error.message] }, false));
    event.target.value = '';
  });
  $('#closeTaskTemplateDialog').addEventListener('click', closeTaskTemplateDialog);
  $('#hardwareImportButton').addEventListener('click', () => $('#hardwareLibraryFile').click());
  $('#hardwareCreateButton').addEventListener('click', () => openHardwareDialog());
  $('#hardwareNozzleScopeButton').addEventListener('click', () => {
    const input = $('#hardwareTypeInput');
    if (input.value === 'Nozzle') return;
    input.value = 'Nozzle';
    input.dispatchEvent(new Event('change'));
  });
  $('#hardwareStandaloneScopeButton').addEventListener('click', () => {
    const input = $('#hardwareTypeInput');
    if (input.value !== 'Nozzle') return;
    input.value = 'Axis';
    input.dispatchEvent(new Event('change'));
  });
  $('#hardwareTypeInput').addEventListener('change', () => { hardwareDialogSlots = []; renderHardwareDialog(); });
  $('#hardware-add-nozzle').addEventListener('click', () => {
    const nozzle = createDialogNozzle();
    hardwareDialogNozzles.push(nozzle);
    selectDialogNozzle(nozzle.NozzleId);
  });
  $('#hardware-copy-nozzle-config').addEventListener('click', copyFirstNozzleConfiguration);
  $('#hardware-remove-nozzle').addEventListener('click', () => {
    if (hardwareDialogNozzles.length <= 1) return;
    const selected = selectedDialogNozzle();
    hardwareDialogNozzles = hardwareDialogNozzles.filter(nozzle => nozzle !== selected);
    selectDialogNozzle(hardwareDialogNozzles[0].NozzleId);
  });
  $('#hardware-add-common-variable').addEventListener('click', () => {
    let name = 'Variable1';
    for (let index = 2; hardwareDialogVariables.some(variable => variable.Name.toLowerCase() === name.toLowerCase()); index++)
      name = 'Variable' + index;
    hardwareDialogVariables.push({
      VariableId: `variable_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      Name: name, Type: 'bool', MemberKind: 'field', HasInitialValue: false, InitialValue: '',
    });
    renderHardwareVariables();
  });
  $('#addHardwareComponentButton').addEventListener('click', () => addNozzleComponent($('#hardwareComponentTypeInput').value));
  $('#hardwareNozzleFilters').addEventListener('change', renderHardwareDialog);
  $('#hardwareForm').addEventListener('submit', saveHardwareFromDialog);
  $('#hardwareDialog').addEventListener('close', () => {
    editingHardwareId = '';
    hardwareDialogSlots = [];
    hardwareDialogParts = [];
    hardwareDialogNozzles = [];
    selectedHardwareNozzleId = '';
    hardwareDialogVariables = [];
  });
  $('#hardwareLibraryFile').addEventListener('change', event => {
    const files = event.target.files && Array.from(event.target.files);
    if (files && files.length) importHardwareLibrary(files).catch(error => {
      showResult({ Success: false, Message: error.message, Diagnostics: [error.message] }, false);
    });
    event.target.value = '';
  });
  $$('[data-shape]').forEach(button => {
    button.addEventListener('click', () => canvasEditor.setTool(`shape:${button.dataset.shape}`));
    button.addEventListener('dragstart', event => {
      event.dataTransfer.effectAllowed = 'copy';
      event.dataTransfer.setData('application/x-equipment-flow-shape', button.dataset.shape);
    });
  });
  Object.entries(TOOL_PANELS).forEach(([key, config]) => {
    const rail = document.getElementById(config.rail);
    const edge = document.getElementById(config.edge);
    document.getElementById(config.toggle).addEventListener('click', () => setPanelVisible(key, !state.panelState[key]));
    edge.addEventListener('click', () => {
      if (state.panelAutoHide[key]) revealPanelEdge(key);
      else setPanelVisible(key, !state.panelState[key]);
    });
    document.getElementById(config.floating).addEventListener('click', () => togglePanelFloating(key));
    document.getElementById(config.autoHide).addEventListener('click', () => togglePanelAutoHide(key));
    document.getElementById(config.close).addEventListener('click', () => setPanelVisible(key, false));
    rail.querySelector('.tool-window-heading, .method-heading').addEventListener('pointerdown', event => beginPanelDrag(key, event));
    const reveal = () => {
      clearPanelAutoHideTimer(key);
      if (state.panelAutoHide[key]) {
        state.panelState[key] = true;
        state.panelPeek[key] = true;
        renderPanelVisibility();
      }
    };
    rail.addEventListener('pointerenter', reveal);
    edge.addEventListener('pointerenter', reveal);
    rail.addEventListener('pointerleave', event => scheduleAutoHidePanel(key, event));
    edge.addEventListener('pointerleave', event => scheduleAutoHidePanel(key, event));
  });
  document.addEventListener('click', event => {
    if (!state.suppressPanelClick || !event.target.closest('.panel-heading-actions')) return;
    state.suppressPanelClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener('pointermove', movePanelDrag);
  document.addEventListener('pointerup', finishPanelDrag);
  document.addEventListener('pointercancel', finishPanelDrag);
  document.addEventListener('pointermove', moveDockResize);
  document.addEventListener('pointerup', finishDockResize);
  document.addEventListener('pointercancel', finishDockResize);
  [$('#leftDockResize'), $('#rightDockResize')].forEach(grip => {
    grip.addEventListener('pointerdown', beginDockResize);
    grip.addEventListener('keydown', resizeDockByKeyboard);
  });
  $('#exportDrawioButton').addEventListener('click', exportDrawio);
  $('#importDrawioButton').addEventListener('click', () => $('#drawioFile').click());
  $('#drawioFile').addEventListener('change', event => {
    const file = event.target.files && event.target.files[0];
    if (file) importDrawio(file);
    event.target.value = '';
  });
  $('#canvasViewport').addEventListener('dragover', event => {
    const types = Array.from(event.dataTransfer.types || []);
    if (types.includes('application/x-equipment-flow-method') || types.includes('application/x-equipment-flow-shape')) {
      event.preventDefault(); event.dataTransfer.dropEffect = 'copy';
    }
  });
  $('#canvasViewport').addEventListener('drop', event => {
    const shape = event.dataTransfer.getData('application/x-equipment-flow-shape');
    const payload = event.dataTransfer.getData('application/x-equipment-flow-method');
    if (!shape && !payload) return;
    event.preventDefault(); event.stopPropagation();
    const point = canvasEditor.pointFromClient(event.clientX, event.clientY);
    if (shape) { addControlNode(shape, point); return; }
    try {
      const reference = JSON.parse(payload);
      const candidates = (state.workspace.Methods || []).filter(method => method.MethodId === reference.MethodId
        && Number(method.SchemaVersion) === Number(reference.SchemaVersion)
        && (!reference.TaskId || method.TaskId === reference.TaskId)
        && (!Object.prototype.hasOwnProperty.call(reference, 'MachineName') || String(method.MachineName || '') === String(reference.MachineName || ''))
        && (!Object.prototype.hasOwnProperty.call(reference, 'StationId') || String(method.StationId || '') === String(reference.StationId || '')));
      if (candidates.length !== 1) throw new Error('拖入方法的 Task 或签名无法唯一匹配。');
      const method = candidates[0]; assertApplicableMethod(method);
      const target = event.target.closest('[data-node-id]');
      if (target) {
        const node = currentFlow().Nodes.find(item => item.NodeId === target.dataset.nodeId);
        if (!node || ['Start', 'End'].includes(node.NodeType)) throw new Error('开始 / 结束节点不能绑定执行方法。');
        state.selectedNodeId = node.NodeId; state.activeInspector = 'node'; canvasEditor.clearEdgeSelection();
        updateNodeField('MethodId', methodLibrary.methodSelectionValue(method));
        updateInspectorTab(); setStatus(`已绑定 ${node.NodeId} → ${method.MethodId}`, 'normal');
      } else addMethodNode(method, point);
    } catch (error) { setStatus(error.message || '无法添加该方法节点', 'error'); }
  });
  $('#canvasViewport').addEventListener('contextmenu', canvasContextMenu);
  document.addEventListener('contextmenu', event => {
    event.preventDefault();
    if (event.target.closest('#canvasViewport, #methodList')) return;
    if (event.target.closest('#methodCodeMonaco')) {
      const hasSelection = Boolean(methodCodeEditor && methodCodeEditor.hasSelection());
      showContextMenu(event.clientX, event.clientY, [
        { label: '剪切', action: () => methodCodeEditor?.runAction('cut') },
        { label: '复制', action: () => methodCodeEditor?.runAction('copy') },
        { label: '粘贴', action: () => methodCodeEditor?.runAction('paste') },
        { label: '删除选中内容', disabled: !hasSelection, action: () => methodCodeEditor?.runAction('delete') },
        { label: '代码整理（CSharpier 风格）', action: () => {
          const changed = methodCodeEditor?.formatDocument();
          setStatus(changed ? '已按 CSharpier 风格整理当前方法代码。' : '代码格式已经整齐。', 'normal');
        } },
      ]);
      return;
    }
    const text = textForContextCopy(event);
    if (text) showContextMenu(event.clientX, event.clientY, [
      { label: '复制', action: () => copyText(text) },
    ]);
    else hideContextMenu();
  });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#deviceContextMenu')) hideContextMenu(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hideContextMenu();
    const command = event.ctrlKey || event.metaKey;
    if (!command) return;
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); if (event.shiftKey) saveProjectAs(); else saveProject(); }
    else if (key === 'o') { event.preventDefault(); openProjectFromPicker(); }
  });
  $('#closeDiagnostics').addEventListener('click', closeDiagnostics);

  function closeDiagnostics() {
    window.clearTimeout(diagnosticsHideTimer);
    diagnosticsHideTimer = null;
    $('#diagnosticsPanel').classList.add('hidden');
    updateWorkspaceHeader();
  }

  window.addEventListener('resize', () => {
    if (state.workspace) renderFlow();
  });
  state.mode = window.chrome && window.chrome.webview ? 'embedded' : 'browser';
  initializeEditor();
  restoreProjectFileHandle();
  restoreTaskOutputDirectories();
  window.EquipmentFlowEnumWorkbench.initialize({
    getWorkspace: () => state.workspace,
    persist: () => persistProjectDraft({ allTasksDirty: true }),
    status: message => setStatus(message, /失败|错误|异常|缺少|未连接|未配置|无效/.test(String(message || '')) ? 'error' : 'normal'),
    showResult,
    setView: setWorkspaceView,
    generateEnumSource,
  });
  setStatus(state.workspace.Tasks.length ? '已恢复 Task 项目，可继续编辑' : '新建 Task 或导入 Task 模板开始编辑', 'normal');
})();
