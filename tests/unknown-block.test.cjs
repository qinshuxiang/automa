const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness.cjs');
const Worker = load('workflowEngine/WorkflowWorker.js', {
  'webextension-polyfill': {}, '@/utils/helper': {}, '@/db/storage': {},
  './templating': () => { throw new Error('must not template unknown block'); },
  './templating/renderString': {}, './helper': {},
}).default;
for (const label of ['conditions', 'missing-custom-block']) {
  test(`unknown node ${label} finishes with an explicit error`, async () => {
    let result;
    const worker = {
      blocksDetail: {}, activeTab: {},
      engine: {
        id: 'run', states: { get: async () => ({}) },
        updateState: async () => {},
        destroy: async (...args) => { result = args; },
      },
    };
    await Worker.prototype.executeBlock.call(worker, { id: 'bad', label, data: {} });
    assert.equal(result[0], 'error');
    assert.match(result[1], new RegExp(label));
    assert.equal(result[2].blockId, 'bad');
  });
}
