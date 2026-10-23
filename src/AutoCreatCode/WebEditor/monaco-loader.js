import('./vendor/monaco/monaco-runtime.js').catch(error => {
  if (typeof window.EquipmentFlowMonacoFail === 'function') {
    window.EquipmentFlowMonacoFail(error);
  }
});
