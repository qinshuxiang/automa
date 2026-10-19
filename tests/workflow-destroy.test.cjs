// N1 回归（源码级）：表格 IndexedDB 提交失败（如存储配额耗尽）时，destroyed
// 事件必须照常派发。子工作流的父流程以该事件为唯一结束信号，丢失会永久挂起。
// 复现方式：dbStorage.transaction 拒绝，直接驱动 WorkflowEngine#destroy，
// 不经过浏览器，聚焦提交失败与事件派发之间的错误边界。
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness.cjs');

function loadWorkflowEngine(dbStorage, storageSet = async () => {}) {
  return load(
    'workflowEngine/WorkflowEngine.js',
    {
      'webextension-polyfill': {
        runtime: { getManifest: () => ({ manifest_version: 3 }) },
        tabs: { sendMessage: async () => {} },
        storage: { local: { get: async () => ({}), set: storageSet } },
        proxy: { settings: { clear: async () => {} } },
      },
      '@/utils/getSharedData': { getBlocks: () => [] },
      '@/utils/helper': {
        clearCache: () => {},
        sleep: async () => {},
        parseJSON: (value, fallback) => {
          try {
            return JSON.parse(value);
          } catch {
            return fallback;
          }
        },
        isObject: (value) =>
          typeof value === 'object' && value !== null && !Array.isArray(value),
      },
      '@/db/storage': dbStorage,
      './WorkflowWorker': class WorkflowWorker {},
    },
    { self: {}, BROWSER_TYPE: 'chrome' }
  ).default;
}

const makeStates = () => ({
  pendingExecutions: 0,
  off() {},
  delete: async () => {},
  update: async () => {},
});

// 绕过构造函数直接装配 destroy 所需的最小实例状态
function makeEngine(WorkflowEngine, states) {
  const engine = Object.create(WorkflowEngine.prototype);
  const destroyed = [];

  Object.assign(engine, {
    id: 'exec-n1',
    states,
    logger: { add: async () => {} },
    workflow: {
      id: 'wf-n1',
      name: 'N1 回归',
      settings: { debugMode: false, reuseLastState: false, saveLog: false },
      connectedTable: 'table-n1',
      isTesting: false,
    },
    isDestroyed: false,
    isUsingProxy: false,
    workers: new Map(),
    executeQueue: async () => {},
    referenceData: { variables: {}, table: [{ a: 1 }], workflow: {} },
    __tableLoaded: true,
    __tableBaseItems: [],
    columns: { column: { index: 0, type: 'any', name: 'column' } },
    eventListeners: {},
    startedTimestamp: Date.now(),
    saveLog: false,
    history: [],
    historyCtxData: {},
    refDataSnapshots: {},
    parentWorkflow: null,
    contentExecutionTabs: new Set(),
  });
  engine.on('destroyed', (detail) => destroyed.push(detail));

  return { engine, destroyed };
}

// Dexie 配额耗尽等场景：transaction 承诺拒绝
const failingDb = () => ({
  transaction: async () => {
    throw new Error('QuotaExceededError');
  },
  tablesItems: { update: async () => {} },
  tablesData: {
    where: () => ({
      equals: () => ({
        first: async () => ({}),
        modify: async () => {},
      }),
    }),
  },
});

// 正常路径：记录事务内的合并写入，验证修复不破坏成功提交
function recordingDb(current) {
  const records = { transactions: 0, itemUpdates: [], modifies: [] };
  records.db = {
    transaction: async (mode, ...rest) => {
      records.transactions += 1;
      await rest[rest.length - 1]();
    },
    tablesItems: {
      update: async (tableId, patch) =>
        records.itemUpdates.push({ tableId, patch }),
    },
    tablesData: {
      where: () => ({
        equals: (tableId) => ({
          first: async () => current,
          modify: async (patch) => records.modifies.push({ tableId, patch }),
        }),
      }),
    },
  };
  return records;
}

test('N1: 表格提交失败仍派发 destroyed 并记录错误', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));

  try {
    const WorkflowEngine = loadWorkflowEngine(failingDb());
    const { engine, destroyed } = makeEngine(WorkflowEngine, makeStates());

    await engine.destroy('success');

    assert.equal(destroyed.length, 1);
    assert.equal(destroyed[0].status, 'success');
    assert.ok(
      errors.some((text) => text.includes('提交表格数据失败')),
      '提交失败应被记录，且不影响结束通知'
    );
  } finally {
    console.error = originalError;
  }
});

test('N1: 表格提交成功时正常合并写入并派发 destroyed', async () => {
  const records = recordingDb({
    items: [{ existing: 1 }],
    columnsIndex: {},
  });
  const WorkflowEngine = loadWorkflowEngine(records.db);
  const { engine, destroyed } = makeEngine(WorkflowEngine, makeStates());

  await engine.destroy('success');

  assert.equal(destroyed.length, 1);
  assert.equal(records.transactions, 1);
  assert.deepEqual(records.modifies[0].patch.items, [{ existing: 1 }, { a: 1 }]);
  assert.deepEqual(Object.keys(records.modifies[0].patch.columnsIndex), [
    'column',
  ]);
  assert.equal(records.itemUpdates[0].patch.rowsCount, 2);
});

test('N1: 连续执行中前一次提交失败不阻塞后一次', async () => {
  const WorkflowEngine = loadWorkflowEngine(failingDb());
  const first = makeEngine(WorkflowEngine, makeStates());
  const second = makeEngine(WorkflowEngine, makeStates());

  await first.engine.destroy('success');
  await second.engine.destroy('success');

  assert.equal(first.destroyed.length, 1);
  assert.equal(second.destroyed.length, 1);
});

test('N4: reuseLastState 写入失败被记录且不阻断 destroyed', async () => {
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));

  try {
    const WorkflowEngine = loadWorkflowEngine(failingDb(), async () => {
      throw new Error('QuotaExceededError');
    });
    const { engine, destroyed } = makeEngine(WorkflowEngine, makeStates());
    engine.workflow.settings.reuseLastState = true;

    await engine.destroy('success');

    assert.equal(destroyed.length, 1);
    assert.ok(
      errors.some((text) => text.includes('reuseLastState')),
      '复用状态写入失败应被记录'
    );
  } finally {
    console.error = originalError;
  }
});
