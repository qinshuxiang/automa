// 导入数据回归（源码级）：把 output/import-data-fix-2026-10-11/regressions.test.cjs
// 中基于旧 bundle 模块号的业务断言迁移为不依赖模块号的源码测试。
// 语义与历史套件一致：范围裁剪、失败上下文、目标类型校验、值保真、JSON 判别。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { load, makeExcelBytes } = require('./harness.cjs');

const xlsx = require('xlsx');

const plain = (value) => JSON.parse(JSON.stringify(value));
const excelBytes = makeExcelBytes(xlsx);

// insertData.js 仅依赖 xlsx、papaparse 与 @/utils/getFile（按用例注入）
function loadInsertData(getFile) {
  return load('utils/insertData.js', {
    '@/utils/getFile': Object.assign(
      (p, o) => getFile(p, o),
      {
        default: (p, o) => getFile(p, o),
        readFileAsBase64: async () => 'data:x;base64,YQ==',
      }
    ),
  });
}

const item = (fields) => ({ filePath: '/tmp/a.xlsx', ...fields });
const bytes = () => new Uint8Array(excelBytes);

for (const purpose of ['preview', 'execute']) {
  for (const action of ['json', 'json-header']) {
    test(`insertData: ${purpose}/${action} trims range consistently`, async () => {
      const parser = loadInsertData(async () => '');
      const expected = await parser.parseInsertData(
        bytes(),
        item({ action, xlsRange: 'A1:B2' }),
        { purpose }
      );
      const actual = await parser.parseInsertData(
        bytes(),
        item({ action, xlsRange: ' A1:B2 ' }),
        { purpose }
      );

      assert.deepEqual(plain(actual.value), plain(expected.value));
      assert.equal(actual.metadata.range, 'A1:B2');
    });
  }
}

test('insertData: range failure retains item index', async () => {
  const parser = loadInsertData(async () => '');

  await assert.rejects(
    parser.parseInsertData(bytes(), item({ action: 'json', xlsRange: 'bad' }), {
      itemIndex: 4,
    }),
    (error) =>
      error.code === 'INVALID_CELL_RANGE' &&
      error.data.itemIndex === 4 &&
      error.data.range === 'bad'
  );
});

test('insertData: conversion failure has context', async () => {
  const parser = loadInsertData(async () => '');

  await assert.rejects(
    parser.parseInsertData(bytes(), item({ action: 'json', xlsRange: 'A1:B2' }), {
      itemIndex: 2,
      utilsXlsx: {
        sheet_to_json() {
          throw new Error('conversion failed');
        },
      },
    }),
    (error) =>
      error.code === 'EXCEL_CONVERT_FAILED' &&
      error.data.itemIndex === 2 &&
      error.data.range === 'A1:B2' &&
      error.data.sheet === '数据'
  );
});

for (const action of ['base64', 'default']) {
  test(`insertData: ${action} ignores hidden invalid range`, async () => {
    const parser = loadInsertData(async () => '');

    const out = await parser.parseInsertData(
      'text',
      item({ action, xlsRange: 'bad' }),
      { readFileAsBase64: async () => 'data:x;base64,YQ==' }
    );

    assert.equal(out.value, action === 'base64' ? 'data:x;base64,YQ==' : 'text');
  });
}

test('insertData: non-Excel files ignore hidden range', async () => {
  const parser = loadInsertData(async () => '');

  const jsonOut = await parser.parseInsertData(
    { a: 1 },
    item({ filePath: '/tmp/a.json', xlsRange: 'bad' })
  );
  assert.deepEqual(plain(jsonOut.value), { a: 1 });

  const csvOut = await parser.parseInsertData(
    'a,b\n1,2',
    item({ filePath: '/tmp/a.csv', action: 'json', xlsRange: 'bad' })
  );
  assert.deepEqual(plain(csvOut.value), [['a', 'b'], ['1', '2']]);
});

test('insertData: real XLSX preview and execution use canonical range', async () => {
  const parser = loadInsertData(async () => '');

  for (const purpose of ['preview', 'execute']) {
    const out = await parser.parseInsertData(
      bytes(),
      item({ filePath: '/tmp/数据.xlsx', action: 'json-header', xlsSheet: '数据', xlsRange: ' A1:B3 ' }),
      { purpose }
    );

    assert.deepEqual(plain(out.value), [
      { 姓名: '甲', 数量: 2 },
      { 姓名: '乙', 数量: 3 },
    ]);
    assert.equal(out.metadata.range, 'A1:B3');
  }
});

// ---- getFile：网络与本地文件路径 ----

function loadGetFile(globals) {
  return load('utils/getFile.js', {}, globals).default;
}

test('getFile: mixed-case HTTP protocols use fetch', async () => {
  const calls = [];
  const get = loadGetFile({
    fetch: async (url) => {
      calls.push(url);
      return { ok: true, text: async () => 'ok' };
    },
    XMLHttpRequest: class {
      open() {
        assert.fail('HTTP URL used XHR');
      }
    },
  });

  for (const url of ['HTTPS://example.com/a.csv', 'HtTp://example.com/a.json?q=1']) {
    assert.equal(await get(url, { responseType: 'text', returnValue: true }), 'ok');
  }

  assert.equal(calls.length, 2);
});

test('getFile: file XHR status 0 and abort lifecycle preserved', async () => {
  let xhr;
  const XMLHttpRequest = class {
    constructor() {
      xhr = this;
    }
    open(_, url) {
      this.url = url;
    }
    send() {}
    abort() {
      if (this.onabort) this.onabort();
    }
  };
  const get = loadGetFile({ XMLHttpRequest, self: { XMLHttpRequest } });

  const first = get('/tmp/中文.csv', { responseType: 'text', returnValue: true });
  assert.equal(xhr.url, 'file:///tmp/中文.csv');

  xhr.status = 0;
  xhr.response = 'a,b';
  xhr.onload();
  assert.equal(await first, 'a,b');
  assert.equal(xhr.onload, null);

  const controller = new AbortController();
  const second = get('/tmp/a.csv', { returnValue: true, signal: controller.signal });
  controller.abort();

  await assert.rejects(second, /取消/);
  assert.equal(xhr.onabort, null);
});

// ---- handlerInsertData：目标校验与写入保真 ----

function loadHandler() {
  return load('workflowEngine/blocksHandler/handlerInsertData.js', {
    '@/utils/helper': { parseJSON: (value, fallback) => {
      try {
        return JSON.parse(value);
      } catch {
        return fallback;
      }
    } },
    '@/utils/insertData': loadInsertData(async () => 'a,b\n1,2'),
    '../templating/renderString': async (value) => String(value),
  }).default;
}

function makeWorker() {
  const writes = [];

  return {
    writes,
    engine: {},
    addDataToColumn: (name, value) => writes.push({ type: 'table', name, value: plain(value) }),
    setVariable: async (name, value) => writes.push({ type: 'variable', name, value: plain(value) }),
    getBlockConnections: () => [],
  };
}

const runWrites = async (dataList, overrides = {}) => {
  const worker = makeWorker();

  try {
    await loadHandler().call(
      { ...worker, ...overrides.worker },
      { id: 'import', data: { dataList } },
      { refData: {} }
    );
  } catch (error) {
    error.writes = worker.writes;

    throw error;
  }

  return worker.writes;
};

for (const isFile of [false, true]) {
  test(`handlerInsertData: invalid target rejected before writes (${isFile})`, async () => {
    await assert.rejects(
      runWrites([
        {
          type: 'typo',
          name: 'unexpected',
          isFile,
          filePath: '/tmp/a.csv',
          action: 'json',
          value: '1',
        },
      ]),
      (error) => {
        assert.equal(error.code, 'INVALID_TARGET_TYPE');
        assert.equal(error.data.itemIndex, 0);
        assert.deepEqual(error.writes, []);

        return true;
      }
    );
  });
}

test('handlerInsertData: missing target type uses normalized table', async () => {
  const writes = await runWrites([{ name: 'c', isFile: false, value: '1' }]);

  assert.equal(writes.length, 1);
  assert.equal(writes[0].type, 'table');
});

test('handlerInsertData: array, delimiters and false values preserved', async () => {
  const writes = await runWrites([
    { type: 'table', name: 'c', value: '[[1,2],[3,4]]' },
    { type: 'table', name: 'c', value: 'a||b' },
    { type: 'variable', name: 'zero', value: 0 },
    { type: 'variable', name: 'flag', value: false },
  ]);

  assert.deepEqual(
    writes.map((x) => x.value),
    [[[1, 2], [3, 4]], 'a', 'b', 0, false]
  );
});

test('handlerInsertData: legacy csvAction header conversion preserved', async () => {
  const writes = await runWrites([
    {
      type: 'variable',
      name: 'rows',
      isFile: true,
      filePath: '/tmp/a.csv',
      csvAction: 'json-header',
    },
  ]);

  assert.deepEqual(writes[0].value, [{ a: '1', b: '2' }]);
});

test('handlerInsertData: JSON null and malformed JSON distinguished', async () => {
  const parser = loadInsertData(async (p) => (p === '/tmp/null.json' ? 'null' : '{'));

  const nullOut = await parser.readInsertFile('/tmp/null.json', item({}), {});
  assert.equal(nullOut, null);

  await assert.rejects(
    parser.readInsertFile('/tmp/bad.json', item({}), { itemIndex: 3 }),
    (error) => error.code === 'JSON_PARSE_FAILED' && error.data.itemIndex === 3
  );
});
