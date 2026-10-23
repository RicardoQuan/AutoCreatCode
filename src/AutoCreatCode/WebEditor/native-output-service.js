// Shared Windows file operations for the standalone browser and embedded WebView2 editor.
(() => {
  'use strict';

  const webView = window.chrome && window.chrome.webview;
  const localHost = window.location.protocol === 'http:'
    && ['127.0.0.1', 'localhost'].includes(window.location.hostname);
  const pending = new Map();
  let sequence = 0;
  let localRequestPending = false;

  // Keep the local file helper alive while the editor tab is open.
  if (localHost) {
    const keepAlive = () => fetch('/__keepalive', { cache: 'no-store', keepalive: true }).catch(() => {});
    keepAlive();
    window.setInterval(keepAlive, 2 * 60 * 1000);
    window.addEventListener('pageshow', keepAlive);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) keepAlive();
    });
  }

  function parseResponse(value) {
    if (typeof value === 'string') return JSON.parse(value);
    return value;
  }

  if (webView) {
    webView.addEventListener('message', event => {
      let response;
      try { response = parseResponse(event.data); }
      catch (_) { return; }
      if (!response || !response.requestId || !pending.has(response.requestId)) return;
      const callbacks = pending.get(response.requestId);
      pending.delete(response.requestId);
      if (response.ok) callbacks.resolve(response.result);
      else callbacks.reject(new Error(response.error || '本机文件操作失败。'));
    });
  }

  async function request(action, values = {}) {
    if (!webView && !localHost)
      throw new Error('当前页面未连接本机文件助手。请通过 WebEditorLocalServer.ps1 或 C# 内嵌界面启动。');

    const requestId = `native_${Date.now()}_${++sequence}`;
    const payload = { requestId, action, ...values };
    if (webView) {
      return new Promise((resolve, reject) => {
        const timeout = window.setTimeout(() => {
          pending.delete(requestId);
          reject(new Error('本机文件助手响应超时。'));
        }, 5 * 60 * 1000);
        pending.set(requestId, {
          resolve: result => { window.clearTimeout(timeout); resolve(result); },
          reject: error => { window.clearTimeout(timeout); reject(error); },
        });
        try { webView.postMessage(JSON.stringify(payload)); }
        catch (error) {
          window.clearTimeout(timeout);
          pending.delete(requestId);
          reject(error);
        }
      });
    }

    if (localRequestPending)
      throw new Error('本机文件助手正在等待前一个系统对话框，请先完成或关闭对话框后再操作。');
    localRequestPending = true;
    try {
      const response = await fetch('/__native', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        cache: 'no-store',
      });
      let body;
      try { body = await response.json(); }
      catch (_) { throw new Error(`本机文件助手返回无效响应（HTTP ${response.status}）。`); }
      if (!response.ok || !body.ok) throw new Error(body.error || `本机文件操作失败（HTTP ${response.status}）。`);
      return body.result;
    } finally {
      localRequestPending = false;
    }
  }

  window.EquipmentFlowNativeOutput = Object.freeze({
    available: Boolean(webView || localHost),
    chooseDirectory: async currentPath => {
      const directory = await request('chooseDirectory', { currentPath: currentPath || '' });
      return directory ? { ...directory, native: true } : null;
    },
    chooseProjectFile: (suggestedName, currentDirectory) => request('chooseProjectFile', {
      suggestedName: suggestedName || 'TaskProject.TaskProject.json', currentDirectory: currentDirectory || '',
    }),
    writeProjectFile: (filePath, content) => request('writeProjectFile', { filePath: filePath || '', content: content || '' }),
    fileExists: (directoryPath, fileName) => request('fileExists', { directoryPath, fileName }),
    writeText: (directoryPath, fileName, content) => request('writeText', { directoryPath, fileName, content }),
    formatCSharp: source => request('formatCSharp', { source: source || '' }),
    createDirectory: async (parentPath, childName) => {
      const directory = await request('createDirectory', { parentPath: parentPath || '', childName: childName || '' });
      return directory ? { ...directory, native: true } : null;
    },
    openDirectory: directoryPath => request('openDirectory', { directoryPath }),
  });
})();
