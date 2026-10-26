(() => {
  'use strict';

  function normalizeResultStatusCodes(input) {
    const tokens = Array.isArray(input)
      ? input
      : String(input ?? '').split(/[\s,，;；]+/u).filter(Boolean);
    const values = tokens.map(value => {
      const token = String(value).trim();
      if (!/^-?\d+$/u.test(token)) throw new Error('int 返回状态码必须是整数。');
      const number = Number(token);
      if (!Number.isSafeInteger(number)) throw new Error('int 返回状态码超出整数范围。');
      return number;
    });
    return [...new Set([0, ...values])].sort((left, right) => left - right);
  }

  function addResultStatusCode(values, value) {
    return normalizeResultStatusCodes([...normalizeResultStatusCodes(values), value]);
  }

  function removeResultStatusCode(values, value) {
    const code = Number(value);
    if (!Number.isSafeInteger(code) || code === 0) return normalizeResultStatusCodes(values);
    return normalizeResultStatusCodes(values).filter(item => item !== code);
  }

  function validateResultStatusCodesChange(method, values, workspace) {
    const next = normalizeResultStatusCodes(values);
    const removed = new Set((method.ResultStatusCodes || [])
      .map(Number).filter(value => !next.includes(value)).map(String));
    for (const [label, codes] of [['等待', method.PendingStatusCodes], ['报警', method.AlarmStatusCodes]]) {
      for (const code of codes || []) {
        if (removed.has(String(code))) throw new Error(`${code} 是${label}状态码，不能删除。`);
      }
    }
    for (const flow of workspace && workspace.Flows || []) {
      for (const node of flow.Nodes || []) {
        if ((method.TaskId && method.TaskId !== flow.StationId)
          || (method.StationId && method.StationId !== flow.StationId)) continue;
        if (node.MethodId !== method.MethodId
          || Number(node.MethodSchemaVersion || 0) !== Number(method.SchemaVersion || 0)) continue;
        const hasScope = Object.prototype.hasOwnProperty.call(node, 'MethodMachineName')
          || Object.prototype.hasOwnProperty.call(node, 'MethodStationId');
        if (hasScope && (String(node.MethodMachineName || '') !== String(method.MachineName || '')
          || String(node.MethodStationId || '') !== String(method.StationId || ''))) continue;
        if (node.PendingStatusCode != null && String(node.PendingStatusCode).trim() !== ''
          && removed.has(String(node.PendingStatusCode)))
          throw new Error(`${node.NodeId} 的等待状态码 ${node.PendingStatusCode} 仍在使用，不能删除。`);
        for (const edge of (flow.Transitions || []).filter(item => item.FromNodeId === node.NodeId)) {
          if (removed.has(String(edge.Outcome)))
            throw new Error(`${node.NodeId} 的输出分支 ${edge.Outcome} 仍在使用，先处理该连线。`);
        }
      }
    }
    return next;
  }

  const api = { normalizeResultStatusCodes, addResultStatusCode, removeResultStatusCode, validateResultStatusCodesChange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.EquipmentFlowMethodStatuses = api;
})();

