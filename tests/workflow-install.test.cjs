// N6 回归（源码级）：*.automa.json 页面安装工作流的错误边界。
// 修复前 JSON.parse 无捕获（页面内容非 JSON 即 unhandled rejection、无提示），
// workflows 键缺失时赋值抛 TypeError；两者都让用户确认后看不到任何结果。
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness.cjs');

function loadContentIndex({ innerText, workflows, onSet }) {
  const listeners = {};
  const alerts = [];
  const windowMock = {
    location: {
      pathname: '/workflow.automa.json',
      href: 'https://example.com/workflow.automa.json',
    },
    getSelection: () => ({ toString: () => '' }),
    confirm: () => true,
    alert: (message) => alerts.push(message),
    addEventListener(type, listener) {
      listeners[type] = listener;
    },
    dispatchEvent() {},
  };
  windowMock.self = windowMock;
  windowMock.top = windowMock;

  const browserMock = {
    runtime: {
      onMessage: { addListener() {} },
      id: 'test',
      getURL: (path) => `chrome-extension://test${path}`,
    },
    storage: {
      local: {
        get: async (keys) =>
          keys === 'workflows' ? { workflows } : {},
        set: async (payload) => onSet(payload),
      },
    },
  };

  const documentMock = {
    documentElement: { innerText },
  };

  load(
    'content/index.js',
    {
      '@/utils/selectorPath': { splitSelectorPath: (value) => [value] },
      'webextension-polyfill': browserMock,
      '@/lib/findSelector': () => '',
      '@/utils/message': { sendMessage: async () => {} },
      '@business': () => {},
      '@/utils/helper': {
        toCamelCase: (value) => value,
        isXPath: (value) => value.startsWith('/'),
      },
      '@/lib/query-selector-shadow-dom': { querySelectorAllDeep: () => [] },
      './handleSelector': Object.assign(() => ({}), {
        queryElements: () => [],
        getDocumentCtx: () => documentMock,
      }),
      './blocksHandler': () => ({}),
      './showExecutedBlock': () => {},
      './services/shortcutListener': () => {},
      './commandPalette': () => {},
      './utils': {
        elementSelectorInstance: () => ({}),
        mapFramePoint: () => ({}),
        getPointPosition: () => ({}),
      },
      './executionSignal': {
        abortExecutionSignal: () => {},
        checkExecutionSignal: () => {},
      },
    },
    { window: windowMock, document: documentMock, alert: windowMock.alert, confirm: windowMock.confirm }
  );

  return { listeners, alerts };
}

test('N6: *.automa.json 内容非 JSON 时给出失败提示', async () => {
  const { listeners, alerts } = loadContentIndex({
    innerText: '<html><body>404 Not Found</body></html>',
    workflows: {},
    onSet: () => assert.fail('不应对无效内容执行写入'),
  });

  await listeners['DOMContentLoaded']();

  assert.ok(
    alerts.some((message) => message.includes('失败')),
    '安装失败应有提示'
  );
});

test('N6: workflows 键缺失时按空对象安装而不抛 TypeError', async () => {
  const sets = [];
  const { listeners, alerts } = loadContentIndex({
    innerText: JSON.stringify({ name: '测试工作流', drawflow: { nodes: [] } }),
    workflows: undefined,
    onSet: (payload) => sets.push(payload),
  });

  await listeners['DOMContentLoaded']();

  assert.equal(sets.length, 1);
  assert.equal(typeof sets[0].workflows, 'object');
  assert.ok(sets[0].workflows, '应写入 workflows 对象');
  assert.ok(alerts.includes('Workflow installed'));
});
