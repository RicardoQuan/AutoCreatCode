import * as monaco from 'monaco-editor/editor/editor.api.js';

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    return new Worker(globalThis.EquipmentFlowMonacoWorkerUrl, {
      type: 'module',
      name: label || 'editorWorkerService',
    });
  },
};

globalThis.monaco = monaco;
globalThis.EquipmentFlowMonacoStart(monaco);
