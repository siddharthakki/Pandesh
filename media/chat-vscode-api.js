(function () {
  'use strict';

  const acquire = window.acquireVsCodeApi;
  if (typeof acquire !== 'function') {
    throw new Error('VS Code webview API is unavailable.');
  }

  const api = acquire();
  Object.defineProperty(window, '__ollamaAgentVsCodeApi', {
    value: api,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  Object.defineProperty(window, 'acquireVsCodeApi', {
    value: () => api,
    configurable: false,
    enumerable: false,
    writable: false,
  });
})();
