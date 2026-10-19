// N2 回归（源码级）：后台 fetch:text 消息必须校验 response.ok。
// 修复前 404/500 的错误页文本被当成功数据返回，调用方静默拿到污染数据，
// 与同文件 fetch 处理器（src/background/index.js:63-65）的行为不一致。
// 注意：当前源码内没有 fetch:text 发送方（休眠路径），本回归锁定 handler
// 自身契约，防止后续接入时直接继承该缺陷。
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness.cjs');

function loadBackground(fetchImpl) {
  const handlers = {};

  class MessageListener {
    constructor(prefix) {
      this.prefix = prefix;
    }

    on(name, listener) {
      handlers[name] = listener;
      return this.on;
    }

    listener() {
      return () => {};
    }

    listen() {
      return Promise.resolve();
    }
  }

  load(
    'background/index.js',
    {
      'webextension-polyfill': {
        alarms: { onAlarm: { addListener() {} } },
        commands: { onCommand: { addListener() {} } },
        action: { onClicked: { addListener() {} } },
        runtime: {
          getManifest: () => ({ manifest_version: 3 }),
          getURL: (path) => `chrome-extension://test${path}`,
          id: 'test',
          onMessage: { addListener() {} },
          onConnect: { addListener() {} },
          onStartup: { addListener() {} },
          onInstalled: { addListener() {} },
        },
        webNavigation: {
          onCompleted: { addListener() {} },
          onHistoryStateUpdated: { addListener() {} },
        },
        contextMenus: { onClicked: { addListener() {} } },
        notifications: { onClicked: { addListener() {} } },
        storage: { local: { get: async () => ({}), set: async () => {} } },
        tabs: {
          query: async () => [],
          onUpdated: { addListener() {} },
          sendMessage: async () => {},
          update: async () => {},
          captureVisibleTab: async () => '',
        },
        windows: { update: async () => {} },
      },
      '@/utils/message': { MessageListener, sendMessage: async () => {} },
      '@/utils/helper': { sleep: async () => {} },
      '@/utils/getFile': {
        default: async () => '',
        readFileAsBase64: async () => '',
      },
      '@business': () => {},
      '@/workflowEngine': { workflowState: {} },
      '@/utils/backupRestore': {
        doBackup: async () => {},
        doRestore: async () => {},
      },
      './backupService': {
        initBackup: async () => {},
        configureBackup: async () => {},
        rebuildAfterRestore: async () => {},
        hasSessionPassword: () => false,
        clearSessionPassword: async () => {},
      },
      '../utils/workflowTrigger': { registerWorkflowTrigger: async () => {} },
      './BackgroundUtils': {
        openDashboard: async () => {},
        sendMessageToDashboard: async () => {},
      },
      './BackgroundWorkflowUtils': { executeWorkflow: () => {} },
      './BackgroundEventsListeners': {
        onAlarms() {},
        onCommand() {},
        onActionClicked() {},
        onRuntimeStartup() {},
        onRuntimeInstalled() {},
        onWebNavigationCompleted() {},
        onHistoryStateUpdated() {},
        onContextMenuClicked() {},
        onNotificationClicked() {},
      },
    },
    { BROWSER_TYPE: 'chrome', fetch: fetchImpl }
  );

  return handlers;
}

test('N2: fetch:text 对非 2xx 响应拒绝而不是返回错误页文本', async () => {
  const handlers = loadBackground(async () => ({
    ok: false,
    status: 404,
    statusText: 'Not Found',
    text: async () => '<html><body>404 Not Found</body></html>',
  }));

  await assert.rejects(
    handlers['fetch:text']('https://example.com/missing'),
    /Not Found/
  );
});

test('N2: fetch:text 对 2xx 响应仍返回文本', async () => {
  const handlers = loadBackground(async () => ({
    ok: true,
    status: 200,
    text: async () => 'col1,col2\n1,2',
  }));

  assert.equal(
    await handlers['fetch:text']('https://example.com/data.csv'),
    'col1,col2\n1,2'
  );
});
