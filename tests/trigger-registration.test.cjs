// N7 回归（源码级）：启动时 reRegisterTriggers 的单工作流隔离与调用点错误边界。
// 修复前单个畸形 trigger（如 specific-day 的 time 非字符串）经
// registerWorkflowTrigger 重抛后中断整个注册循环，排在其后的定时触发器当日
// 静默失效；onRuntimeStartup 的调用既未 await 也无 catch。
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness.cjs');

function loadTriggers(workflows) {
  const alarms = [];
  const browserMock = {
    runtime: { getManifest: () => ({ manifest_version: 3 }) },
    storage: {
      local: {
        get: async () => ({
          shortcuts: {},
          visitWebTriggers: [],
          onStartupTriggers: [],
          workflowQueue: [],
          workflows,
        }),
        set: async () => {},
      },
    },
    contextMenus: { remove: async () => {}, create: () => {} },
    alarms: {
      create: async (name, info) => alarms.push({ name, info }),
      clear: async () => {},
    },
  };

  const workflowTrigger = load(
    'utils/workflowTrigger.js',
    {
      'webextension-polyfill': browserMock,
      './helper': {
        isObject: (value) =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
      },
    },
    { BROWSER_TYPE: 'chrome' }
  );

  const BackgroundWorkflowTriggers = load(
    'background/BackgroundWorkflowTriggers.js',
    {
      'webextension-polyfill': browserMock,
      '@/utils/helper': {
        findTriggerBlock: () => null,
        parseJSON: (value, fallback) => {
          try {
            return JSON.parse(value);
          } catch {
            return fallback;
          }
        },
      },
      '@/utils/workflowTrigger': workflowTrigger,
      './BackgroundUtils': {
        default: { openDashboard: async () => {} },
      },
      './BackgroundWorkflowUtils': {
        default: {
          executeWorkflow: async () => {},
          getWorkflow: async () => null,
          flattenTeamWorkflows: (value) => value,
        },
      },
    },
    { BROWSER_TYPE: 'chrome' }
  ).default;

  return { triggers: BackgroundWorkflowTriggers, alarms };
}

test('N7: 单个畸形 trigger 不中断其余工作流的注册', async () => {
  const { triggers, alarms } = loadTriggers([
    { id: 'wf-a', name: 'A', isDisabled: false, trigger: { type: 'interval', interval: 10 } },
    {
      id: 'wf-bad',
      name: 'Bad',
      isDisabled: false,
      // specific-day 的 times 含非字符串，registerSpecificDay 内 split 抛错
      trigger: { type: 'specific-day', days: [{ id: 1, times: [123] }] },
    },
    { id: 'wf-b', name: 'B', isDisabled: false, trigger: { type: 'interval', interval: 20 } },
  ]);

  await triggers.reRegisterTriggers(true);

  const names = alarms.map((item) => item.name);
  assert.ok(names.includes('wf-a'), '首个工作流应注册');
  assert.ok(names.includes('wf-b'), '畸形 trigger 之后的工作流仍应注册');
});

test('N7: 启动时触发器注册失败被捕获且不挂起启动流程', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));

  try {
    const BackgroundEventsListeners = load(
      'background/BackgroundEventsListeners.js',
      {
        'webextension-polyfill': {
          storage: { local: { remove: async () => {} } },
          action: { setBadgeText() {} },
        },
        '@/newtab/utils/elementSelector': { initElementSelector: () => {} },
        './backupService': {
          initBackup: async () => {},
          isScheduledBackupAlarm: () => false,
          handleScheduledBackup: async () => {},
        },
        './BackgroundUtils': { default: { openDashboard: async () => {} } },
        './BackgroundWorkflowTriggers': {
          reRegisterTriggers: async () => {
            throw new Error('bad trigger data');
          },
        },
      }
    ).default;

    await BackgroundEventsListeners.onRuntimeStartup();

    assert.ok(errors.length > 0, '注册失败应被记录');
  } finally {
    console.error = originalError;
  }
});
