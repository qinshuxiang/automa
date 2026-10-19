// N3 回归（源码级）：离线版启动工作流不得发起 /status 在线探测。
// 修复前 baseApiUrl 为空，fetchApi('/status') 必然 404、.json() 抛错且无
// catch，checkStatus 永不写入，「每日一次」退化为每次执行都探测。
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness.cjs');

function loadStartWorkflow({ fetchApi, storageSet }) {
  return load(
    'workflowEngine/index.js',
    {
      'webextension-polyfill': {
        storage: {
          local: {
            get: async () => ({}),
            set: async (payload) => storageSet(payload),
          },
        },
        permissions: { contains: async () => false },
        notifications: { create: () => {} },
        runtime: {
          getManifest: () => ({ manifest_version: 3 }),
          getURL: () => 'chrome-extension://test/',
        },
      },
      '@/utils/helper': {
        parseJSON: (value, fallback) => {
          try {
            return JSON.parse(value);
          } catch {
            return fallback;
          }
        },
      },
      '@/utils/api': { fetchApi },
      '@/utils/message': { sendMessage: async () => {} },
      '@/utils/convertWorkflowData': (data) => ({
        ...data,
        drawflow: { nodes: [{ id: 'trigger', label: 'trigger' }] },
      }),
      '@/utils/getBlockMessage': () => '',
      '@/utils/decryptFlow': Object.assign((workflow) => workflow, {
        getWorkflowPass: () => '',
      }),
      '@/utils/backupRestore': { isRestoreBlocked: () => false },
      '@/utils/workflowValidation': { validateWorkflowData: () => true },
      './WorkflowState': class WorkflowState {
        constructor() {
          this.states = new Map();
          this.pendingExecutions = 0;
        }
        stop() {}
      },
      './WorkflowLogger': class WorkflowLogger {
        add() {}
      },
      './WorkflowEngine': class WorkflowEngine {
        constructor() {
          this.referenceData = { variables: {} };
        }
        init() {
          return Promise.resolve();
        }
        on() {}
      },
      './blocksHandler': () => ({}),
      './workflowEvent': { workflowEventHandler: () => {} },
    },
    { self: {} }
  );
}

test('N3: 启动工作流不再发起 /status 在线探测', async () => {
  const fetchApiCalls = [];
  const setCalls = [];
  const { startWorkflowExec } = loadStartWorkflow({
    fetchApi: async (path) => {
      fetchApiCalls.push(path);
      return { json: async () => ({}) };
    },
    storageSet: (payload) => setCalls.push(payload),
  });

  const engine = startWorkflowExec(
    { id: 'wf-n3', name: 'N3 回归', drawflow: { nodes: [] }, settings: {} },
    {}
  );
  assert.ok(engine, '应返回引擎实例');

  // 等待启动链路上的微任务全部完成
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(fetchApiCalls, []);
  assert.ok(
    !setCalls.some((payload) => 'checkStatus' in payload),
    '不应再写入 checkStatus'
  );
});
