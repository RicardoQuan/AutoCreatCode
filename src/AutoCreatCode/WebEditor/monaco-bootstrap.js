(() => {
  'use strict';

  let resolveReady;
  let rejectReady;
  window.EquipmentFlowMonacoReady = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  window.EquipmentFlowMonacoWorkerUrl = new URL('./vendor/monaco/editor.worker.js', document.baseURI).toString();
  window.EquipmentFlowMonacoStart = monaco => resolveReady(monaco);
  window.EquipmentFlowMonacoFail = error => rejectReady(error instanceof Error ? error : new Error(String(error)));

  if (window.location.protocol !== 'https:' && window.location.protocol !== 'http:') {
    window.EquipmentFlowMonacoFail(new Error('浏览器通过 file:// 打开了编辑器。请运行 WebEditor 目录中的 OpenInBrowser.cmd，再在本机网页地址中使用代码编辑器。'));
    return;
  }

  const loader = document.createElement('script');
  loader.type = 'module';
  loader.src = new URL('./monaco-loader.js', document.baseURI).toString();
  loader.onerror = () => window.EquipmentFlowMonacoFail(new Error('Monaco 模块加载失败。请确认 WebEditor/vendor/monaco 文件已完整复制，然后通过 OpenInBrowser.cmd 启动。'));
  document.head.appendChild(loader);

  window.setTimeout(() => {
    window.EquipmentFlowMonacoFail(new Error('Monaco 启动超时。请确认 vendor/monaco 资源完整，并通过 OpenInBrowser.cmd 启动。'));
  }, 30_000);
})();
