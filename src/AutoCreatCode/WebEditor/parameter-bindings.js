(() => {
  'use strict';

  function setManualValue(parameter, value) {
    parameter.Value = value == null ? '' : String(value);
    parameter.SourceNodeId = '';
    parameter.SourceParameterName = '';
    return parameter;
  }

  function setOutputSource(parameter, nodeId, parameterName) {
    parameter.Value = '';
    parameter.SourceNodeId = String(nodeId || '');
    parameter.SourceParameterName = String(parameterName || '');
    return parameter;
  }

  function clearOutputSource(parameter) {
    parameter.SourceNodeId = '';
    parameter.SourceParameterName = '';
    return parameter;
  }

  const api = { setManualValue, setOutputSource, clearOutputSource };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EquipmentFlowParameterBindings = api;
})();
