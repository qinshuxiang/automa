// D07/D08 回归（源码级）：xlsx 导出数据形状与工作表名净化。
// 覆盖缺陷：[1,2] 变空行、[null] 抛异常、对象/二维数组丢值、
// 文件名「报告[最终]」直接当表名致 SheetJS 报错。
const test = require('node:test');
const assert = require('node:assert/strict');

const xlsx = require('xlsx');
const { load } = require('./harness.cjs');

function loadExporter() {
  const savedFiles = [];

  const exporter = load('utils/dataExporter.js', {
    './helper': { fileSaver: (name, url) => savedFiles.push({ name, url }) },
  }, {
    URL: {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: () => {},
    },
  }).default;

  return { exporter, savedFiles };
}

async function toSheet(bytes) {
  const buffer = await new Blob([bytes]).arrayBuffer();

  return xlsx.read(new Uint8Array(buffer), { type: 'array' });
}

async function firstSheet(bytes) {
  const workbook = await toSheet(bytes);

  return workbook.Sheets[workbook.SheetNames[0]];
}

test('exporter: scalar array [1,2] exports as value column', async () => {
  const { exporter } = loadExporter();
  const sheet = await firstSheet(exporter([1, 2], { name: 't', type: 'xlsx', returnBlob: true }, true));

  assert.deepEqual(xlsx.utils.sheet_to_json(sheet, { header: 1 }), [
    ['value'],
    [1],
    [2],
  ]);
});

test('exporter: [null] does not throw and stays readable', async () => {
  const { exporter } = loadExporter();
  const sheet = await firstSheet(exporter([null], { name: 't', type: 'xlsx', returnBlob: true }, true));

  assert.deepEqual(xlsx.utils.sheet_to_json(sheet, { header: 1 }), [['value'], []]);
});

test('exporter: two-dimensional array keeps rows and cells', async () => {
  const { exporter } = loadExporter();
  const sheet = await firstSheet(
    exporter(
      [[1, '甲'], [true, null], [{ a: 1 }, [2, 3]]],
      { name: 't', type: 'xlsx', returnBlob: true },
      true
    )
  );

  // 契约：null → 空单元格（回读为 undefined），其余格保真
  const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });
  assert.deepEqual(rows[0], [1, '甲']);
  assert.equal(rows[1][0], true);
  assert.ok(rows[1][1] === undefined || rows[1][1] === null);
  assert.deepEqual(rows[2], ['{"a":1}', '[2,3]']);
});

test('exporter: row objects keep keys, nulls and nested values', async () => {
  const { exporter } = loadExporter();
  const sheet = await firstSheet(
    exporter(
      [
        { 姓名: '甲', 数量: 2, 备注: null, 扩展: { x: 1 } },
        { 姓名: '乙', 数量: 0, 备注: false, 扩展: [1] },
      ],
      { name: 't', type: 'xlsx', returnBlob: true },
      true
    )
  );

  // 契约：null → 空单元格（回读无该键），0/false/嵌套值保真
  const rows = xlsx.utils.sheet_to_json(sheet);
  assert.deepEqual(rows, [
    { 姓名: '甲', 数量: 2, 扩展: '{"x":1}' },
    { 姓名: '乙', 数量: 0, 备注: false, 扩展: '[1]' },
  ]);
});

test('exporter: column-format object converts to row objects', async () => {
  const { exporter } = loadExporter();
  const sheet = await firstSheet(
    exporter(
      { 姓名: ['甲', '乙'], 数量: [2, 3] },
      { name: 't', type: 'xlsx', returnBlob: true },
      false
    )
  );

  assert.deepEqual(xlsx.utils.sheet_to_json(sheet), [
    { 姓名: '甲', 数量: 2 },
    { 姓名: '乙', 数量: 3 },
  ]);
});

test('exporter: empty array exports a readable empty sheet', async () => {
  const { exporter } = loadExporter();
  const workbook = await toSheet(exporter([], { name: 't', type: 'xlsx', returnBlob: true }, true));

  assert.equal(workbook.SheetNames.length, 1);
  assert.deepEqual(xlsx.utils.sheet_to_json(firstSheetSync(workbook)), []);
});

function firstSheetSync(workbook) {
  return workbook.Sheets[workbook.SheetNames[0]];
}

test('exporter: invalid sheet characters are sanitized, file name untouched', async () => {
  const { exporter, savedFiles } = loadExporter();
  const bytes = exporter(
    [{ a: 1 }],
    { name: '报告[最终]', type: 'xlsx', returnBlob: true },
    true
  );

  const workbook = await toSheet(bytes);
  assert.deepEqual(workbook.SheetNames, ['报告_最终_']);

  const saved = exporter([{ a: 1 }], { name: '报告[最终]', type: 'xlsx' }, true);
  assert.equal(typeof saved, 'string');
  assert.deepEqual(savedFiles, [{ name: '报告[最终].xlsx', url: 'blob:mock' }]);
});

test('exporter: sheet name honours 31-char limit and empty fallback', async () => {
  const { exporter } = loadExporter();

  const longName = '长'.repeat(40);
  const bytes = exporter([{ a: 1 }], { name: longName, type: 'xlsx', returnBlob: true }, true);
  assert.equal((await toSheet(bytes)).SheetNames[0].length, 31);

  const fallback = exporter([{ a: 1 }], { name: '', type: 'xlsx', returnBlob: true }, true);
  assert.equal((await toSheet(fallback)).SheetNames[0], '数据');
});

test('exporter: JSON/CSV/plain-text semantics unchanged', async () => {
  const { exporter } = loadExporter();

  const asText = (data, type) =>
    exporter(data, { name: 't', type, returnBlob: true }, true).text();

  assert.equal(await asText([{ a: 1 }], 'json'), '[\n  {\n    "a": 1\n  }\n]');
  assert.equal(await asText([{ a: 1 }, { a: 2 }], 'csv'), 'a\r\n1\r\n2');
  assert.equal(await asText({ a: [1, 2] }, 'plain-text'), '[1,2]');
});
