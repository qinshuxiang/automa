// N4/N5 回归（源码级）：状态与录制的 storage.local 写入失败必须有错误边界。
// 修复前这些浮动写入被拒后静默丢失（断点快照、录制块），并产生 unhandled
// rejection；录制 UI 侧另需用户可见提示（Recording.vue 无源码级测试，靠构建
// 与同文件既有 toast 用法保证）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness.cjs');

test('N4: 断点快照写入失败被记录', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));

  const browserMock = {
    action: { setBadgeText() {} },
    storage: {
      local: {
        set: async () => {
          throw new Error('QuotaExceededError');
        },
      },
    },
  };

  try {
    const WorkflowState = load('workflowEngine/WorkflowState.js', {
      'webextension-polyfill': browserMock,
    }).default;

    // 与生产一致的 storage 包装：browser.storage.local.set({ [key]: value })
    const state = new WorkflowState({
      storage: {
        set: (key, value) => browserMock.storage.local.set({ [key]: value }),
      },
    });

    state.add('exec-n4', { status: 'running' });

    // _saveToStorage 有 1s 防抖
    await new Promise((resolve) => setTimeout(resolve, 1100));

    assert.ok(
      errors.some((text) => text.includes('工作流状态')),
      '断点快照写入失败应被记录'
    );
  } finally {
    console.error = originalError;
  }
});

test('N5: 录制 iframe 选择器合并落盘失败被记录', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));

  let messageListener = null;
  const browserMock = {
    storage: {
      local: {
        get: async () => ({ isRecording: true }),
        set: async () => {
          throw new Error('QuotaExceededError');
        },
      },
    },
  };
  const windowMock = {
    addEventListener(type, listener) {
      if (type === 'message') messageListener = listener;
    },
    removeEventListener() {},
    top: { postMessage() {} },
    frameElement: null,
  };
  const documentMock = {
    activeElement: { tagName: 'DIV' },
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };

  try {
    const recordEvents = load(
      'content/services/recordWorkflow/recordEvents.js',
      {
        'webextension-polyfill': browserMock,
        '@/utils/helper': { debounce: (fn) => fn },
        '@/utils/recordKeys': { recordPressedKey: () => {} },
        '@/lib/findSelector': Object.assign(() => '', { finder: () => '' }),
        './addBlock': async () => ({ recording: { flows: [] } }),
      },
      { window: windowMock, document: documentMock }
    );

    await recordEvents.default(true);
    assert.ok(messageListener, '应注册 message 监听');

    messageListener({
      data: {
        type: 'automa:record-events',
        frameSelector: '#frm',
        recording: {
          flows: [{ id: 'event-click', data: { selector: '#a' } }],
        },
      },
      source: {},
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(
      errors.some((text) => text.includes('录制')),
      '录制落盘失败应被记录'
    );
  } finally {
    console.error = originalError;
  }
});
