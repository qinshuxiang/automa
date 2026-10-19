const test = require('node:test');
const assert = require('node:assert/strict');
const xlsx = require('xlsx');
const { load } = require('./harness.cjs');

function switchHarness(same, url = 'https://child.test/frame', frames = { 'https://child.test/frame': 7 }) {
  const handler = load('workflowEngine/blocksHandler/handlerSwitchTo.js', {
    '@/utils/helper': { sleep: async () => {} }, '../helper': { getFrames: async () => frames },
  }).default;
  const worker = { activeTab: { id: 1, frameId: 7 }, frameSelector: '#old',
    getBlockConnections: () => ['next'], _sendMessageToTab: async () => ({ url, isSameOrigin: same }) };
  return { worker, run: () => handler.call(worker, { id: 'switch', data: { selector: '#new' } }) };
}
test('switch: same-origin resets numeric routing', async () => {
  const { worker, run } = switchHarness(true); await run();
  assert.equal(worker.activeTab.frameId, 0); assert.equal(worker.frameSelector, '#new');
});
test('switch: cross-origin clears document path', async () => {
  const { worker, run } = switchHarness(false); await run();
  assert.equal(worker.activeTab.frameId, 7); assert.equal(worker.frameSelector, undefined);
});
for (const url of ['https://missing.test/absent', 'https://other.test/frame']) {
  test(`switch: missing or different-origin frame rejects (${url})`, async () => {
    const { worker, run } = switchHarness(false, url);
    await assert.rejects(run(), /no-iframe-id/);
    assert.equal(worker.activeTab.frameId, 7); assert.equal(worker.frameSelector, '#old');
  });
}
test('switch: unique same-origin redirect can match path', async () => {
  const { worker, run } = switchHarness(false, 'https://child.test/frame?q=old'); await run();
  assert.equal(worker.activeTab.frameId, 7);
});
test('switch: ambiguous fallback rejects', async () => {
  const { run } = switchHarness(false, 'https://child.test/frame?q=old', {
    'https://child.test/frame?q=1': 2, 'https://child.test/frame?q=2': 3,
  });
  await assert.rejects(run(), /no-iframe-id/);
});
for (const max of [0, 1, 2]) {
  test(`loop: candidate maximum ${max}`, () => {
    const { generateLoopSelectors } = load('content/utils.js');
    const elements = Array.from({ length: 5 }, () => ({ setAttribute() {} }));
    assert.equal(generateLoopSelectors(elements, { max, attrId: 'x', frameSelector: '' }).length, max || 5);
  });
}
const exporter = () => load('utils/dataExporter.js', { './helper': { fileSaver() {} } }).default;
async function rows(data, name = '数据', converted = true) {
  const blob = exporter()(data, { type: 'xlsx', name, returnBlob: true }, converted);
  const book = xlsx.read(Buffer.from(await blob.arrayBuffer()), { type: 'buffer' });
  return { name: book.SheetNames[0], rows: xlsx.utils.sheet_to_json(book.Sheets[book.SheetNames[0]], { header: 1, defval: null }) };
}
for (const data of [[1, 2], [0, false, '中文'], [null], []]) {
  test(`xlsx: scalar rows preserve values ${JSON.stringify(data)}`, async () => {
    assert.deepEqual((await rows(data)).rows, data.length ? [['value'], ...data.map(value => [value])] : []);
  });
}
test('xlsx: object rows and nested values preserve content', async () => {
  assert.deepEqual((await rows([{ 名称: '甲', 信息: { a: 1 } }])).rows, [['名称', '信息'], ['甲', '{"a":1}']]);
});
test('xlsx: two-dimensional arrays keep columns', async () => {
  assert.deepEqual((await rows([['姓名', '数值'], ['甲', 2]])).rows, [['姓名', '数值'], ['甲', 2]]);
});
test('xlsx: column dictionary keeps uneven columns aligned', async () => {
  assert.deepEqual((await rows({ a: [1, 2], b: ['x'] }, '数据', false)).rows, [['a', 'b'], [1, 'x'], [2, null]]);
});
test('xlsx: sheet name sanitized independently of filename', async () => {
  const result = await rows([{ a: 1 }], "'报告[最终]/:*?\\'".repeat(4));
  assert.ok(result.name.length <= 31); assert.doesNotMatch(result.name, /[\\/:*?\[\]]/);
  assert.ok(!result.name.startsWith("'") && !result.name.endsWith("'"));
  assert.deepEqual(result.rows, [['a'], [1]]);
});
test('xlsx: zero scalar value is retained', async () => {
  assert.deepEqual((await rows(0, '数据', false)).rows, [['value'], [0]]);
});
test('exports: JSON and BOM CSV remain compatible', async () => {
  const run = exporter();
  assert.equal(await run([{ a: 1 }], { type: 'json', returnBlob: true }, true).text(), '[\n  {\n    "a": 1\n  }\n]');
  const blob = run([{ a: '中文' }], { type: 'csv', addBOMHeader: true, returnBlob: true }, true);
  assert.deepEqual([...new Uint8Array(await blob.arrayBuffer()).slice(0, 3)], [239, 187, 191]);
});

const { splitSelectorPath } = load('utils/selectorPath.js');
for (const selector of ['[data-note="a|>b"]', ':is([title="a|>b"], button)', '[title="escaped\\\"|>text"]']) {
  test(`path parsing preserves literal separators: ${selector}`, () => assert.deepEqual(splitSelectorPath(selector, '|>'), [selector]));
}
test('path parsing separates only actual frame boundaries', () => {
  assert.deepEqual(splitSelectorPath('#frame |> [title="a|>b"]', '|>'), ['#frame', '[title="a|>b"]']);
});
test('frame coordinates include border and scale', () => {
  const { mapFramePoint } = load('content/utils.js');
  assert.deepEqual(mapFramePoint({ offsetWidth: 100, offsetHeight: 200, clientLeft: 2, clientTop: 3,
    getBoundingClientRect: () => ({ x: 50, y: 60, width: 200, height: 400 }) }, { x: 10, y: 20 }), { x: 74, y: 106 });
});
test('build script returns failure for compiler errors', () => {
  const fs = require('fs'); const path = require('path'); const vm = require('vm');
  const proc = { env: {}, exitCode: 0, exit(code) { this.exitCode = code; } };
  let writes = 0;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/build.js'), 'utf8'), {
    process: proc, console: { log() {}, error() {}, warn() {} },
    require(name) {
      if (name === './build-info') return () => writes++;
      if (name !== 'webpack') return {};
      return (config, callback) => callback(null, { hasErrors: () => true, hasWarnings: () => false, toJson: () => ({ errors: ['expected error'] }), toString: () => 'expected error' });
    },
  });
  assert.equal(proc.exitCode, 1); assert.equal(writes, 0);
});
