// D05 回归（源码级）：Switch To 块在 iframe 模式间的状态原子更新。
// 覆盖缺陷：跨源→同源保留旧 frameId、同源→跨源保留旧 frameSelector、
// 未找到 frame 时 undefined 误判成功、重定向候选误选其他网站同名路径。
const test = require('node:test');
const assert = require('node:assert/strict');

const { load } = require('./harness.cjs');

function loadSwitchTo({ frames = {}, sameOrigin = false, url = 'https://child.example/page' } = {}) {
  const sentMessages = [];

  const switchTo = load('workflowEngine/blocksHandler/handlerSwitchTo.js', {
    '@/utils/helper': { sleep: async () => {} },
    '../helper': { getFrames: async () => frames },
  }).default;

  const makeWorker = (state = {}) => ({
    activeTab: { id: 1, frameId: state.frameId ?? 0 },
    frameSelector: state.frameSelector,
    sentMessages,
    getBlockConnections: () => [],
    _sendMessageToTab: async (payload, options) => {
      sentMessages.push({ payload, options });
      return { url, isSameOrigin: sameOrigin };
    },
  });

  return { switchTo, makeWorker, sentMessages };
}

const block = (data) => ({ id: 'switch', data });

test('switchTo: cross-origin to same-origin resets numeric frameId', async () => {
  const { switchTo, makeWorker } = loadSwitchTo({ sameOrigin: true });
  const worker = makeWorker({ frameId: 7 });

  const result = await switchTo.call(worker, block({ selector: '#same' }));

  assert.equal(worker.activeTab.frameId, 0);
  assert.equal(worker.frameSelector, '#same');
  assert.equal(result.data, '#same');
});

test('switchTo: same-origin to cross-origin clears stale selector', async () => {
  const { switchTo, makeWorker } = loadSwitchTo({
    sameOrigin: false,
    frames: { 'https://child.example/page': 7 },
  });
  const worker = makeWorker({ frameId: 0, frameSelector: '#old' });

  const result = await switchTo.call(worker, block({ selector: '#cross' }));

  assert.equal(worker.activeTab.frameId, 7);
  assert.equal(worker.frameSelector, undefined);
  assert.equal(result.data, 7);
});

test('switchTo: back to main document clears both frame modes', async () => {
  const { switchTo, makeWorker } = loadSwitchTo();
  const worker = makeWorker({ frameId: 7, frameSelector: '#old' });

  await switchTo.call(worker, block({ windowType: 'main-window' }));

  assert.equal(worker.activeTab.frameId, 0);
  assert.equal(worker.frameSelector, undefined);
});

test('switchTo: main-window entry also resets selector-only mode', async () => {
  const { switchTo, makeWorker } = loadSwitchTo();
  const worker = makeWorker({ frameId: 0, frameSelector: '#old' });

  await switchTo.call(worker, block({ windowType: 'main-window' }));

  assert.equal(worker.activeTab.frameId, 0);
  assert.equal(worker.frameSelector, undefined);
});

test('switchTo: missing frame rejects and leaves state untouched', async () => {
  const { switchTo, makeWorker } = loadSwitchTo({ sameOrigin: false, frames: {} });
  const worker = makeWorker({ frameId: 7, frameSelector: '#old' });

  await assert.rejects(
    switchTo.call(worker, block({ selector: '#cross' })),
    (error) => error.message === 'no-iframe-id' && error.data.selector === '#cross'
  );

  // 失败不留下半更新状态
  assert.equal(worker.activeTab.frameId, 7);
  assert.equal(worker.frameSelector, '#old');
});

test('switchTo: non-integer and non-positive frame ids are rejected', async () => {
  for (const bogus of [undefined, null, 0, -3, '7']) {
    const { switchTo, makeWorker } = loadSwitchTo({
      sameOrigin: false,
      frames: { 'https://child.example/page': bogus },
    });
    const worker = makeWorker({ frameId: 7 });

    await assert.rejects(switchTo.call(worker, block({ selector: '#cross' })), /no-iframe-id/);
    assert.equal(worker.activeTab.frameId, 7, `state kept for ${String(bogus)}`);
  }
});

test('switchTo: redirect candidate matched by same origin and pathname', async () => {
  // iframe 重定向后最终 URL 带查询串，pathname 一致且同源 → 唯一候选可用
  const { switchTo, makeWorker } = loadSwitchTo({
    sameOrigin: false,
    url: 'https://child.example/page?after=redirect',
    frames: { 'https://child.example/page': 5, 'https://child.example/other': 6 },
  });
  const worker = makeWorker({ frameId: 0 });

  const result = await switchTo.call(worker, block({ selector: '#cross' }));

  assert.equal(worker.activeTab.frameId, 5);
  assert.equal(result.data, 5);
});

test('switchTo: same pathname on another origin is not misselected', async () => {
  const { switchTo, makeWorker } = loadSwitchTo({
    sameOrigin: false,
    url: 'https://child.example/page?after=redirect',
    frames: { 'https://other.example/page': 5 },
  });
  const worker = makeWorker({ frameId: 7, frameSelector: '#old' });

  await assert.rejects(switchTo.call(worker, block({ selector: '#cross' })), /no-iframe-id/);
  assert.equal(worker.activeTab.frameId, 7);
  assert.equal(worker.frameSelector, '#old');
});

test('switchTo: ambiguous redirect candidates reject instead of guessing', async () => {
  const { switchTo, makeWorker } = loadSwitchTo({
    sameOrigin: false,
    url: 'https://child.example/page?after=redirect',
    frames: {
      'https://child.example/page': 5,
      'https://child.example/page?x=2': 6,
    },
  });
  const worker = makeWorker({ frameId: 7 });

  await assert.rejects(switchTo.call(worker, block({ selector: '#cross' })), /no-iframe-id/);
  assert.equal(worker.activeTab.frameId, 7);
});

test('switchTo: probe message never leaks stale frameSelector', async () => {
  const { switchTo, makeWorker, sentMessages } = loadSwitchTo({ sameOrigin: true });
  const worker = makeWorker({ frameId: 7, frameSelector: '#old' });

  await switchTo.call(worker, block({ selector: '#same' }));

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].payload.frameSelector, '');
  assert.deepEqual(sentMessages[0].options, { frameId: 0 });
});
