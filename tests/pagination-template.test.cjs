// D09 回归：分页模板拓扑 + 真实 repeat/conditions handler 的引擎级模拟。
// 覆盖缺陷：3 页工作流执行 3 次「下一页」（应 2 次）、末页未先结束再导出。
// repeat-task 与 conditions 用源码真实实现，JS 块在沙箱中按 automa API 语义执行。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { load } = require('./harness.cjs');

const TEMPLATE_PATH = path.resolve(
  __dirname,
  '../../../templates/表格分页抓取模板.json'
);

function buildSim(pageCount) {
  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  const config = JSON.parse(template.globalData);
  config.pageCount = pageCount;

  const nodes = Object.fromEntries(
    template.drawflow.nodes.map((node) => [node.id, node])
  );
  const edges = template.drawflow.edges;

  // 模拟站点：pageCount 页表格，每页行内含页码便于断言不串页
  const pages = Array.from({ length: pageCount }, (_, page) =>
    Array.from({ length: 2 + page }, (_, row) => ({
      cells: [`第${page + 1}页`, `r${row + 1}`, `p${page + 1}-${row + 1}`],
    }))
  );
  const site = { pageIdx: 0, clicks: 0 };

  const vars = {};
  const refData = { variables: vars, globalData: config };
  const visited = { collect: [], export: 0 };

  const renderString = async (value) => {
    const match = /^{{\s*(variables|globalData)\.([\w$]+)\s*}}$/.exec(
      String(value)
    );

    return {
      value: match ? String(refData[match[1]][match[2]] ?? '') : value,
      list: {},
    };
  };

  const conditionMocks = {
    'webextension-polyfill': {
      runtime: { getManifest: () => ({ manifest_version: 2 }) },
    },
    '@/utils/compareBlockValue': (type, value, compareValue) => value === compareValue,
    '../utils/conditionCode': async () => true,
    '../templating/renderString': renderString,
    _deep: {
      '@/utils/helper': {
        parseJSON: (value, fallback) => {
          try {
            return JSON.parse(value);
          } catch {
            return fallback;
          }
        },
      },
      '@/utils/shared': {
        conditionBuilder: {
          compareTypes: [
            { id: 'eq', needValue: true },
            { id: 'nq', needValue: true },
            { id: 'gt', needValue: true },
            { id: 'gte', needValue: true },
            { id: 'lt', needValue: true },
            { id: 'cnt', needValue: true },
            { id: 'itr', needValue: false },
            { id: 'ifl', needValue: false },
          ],
          valueTypes: [
            { id: 'value', compareable: true },
            { id: 'data', compareable: false },
            { id: 'code', compareable: false },
            { id: 'element', compareable: false },
          ],
        },
      },
      '../templating/renderString': renderString,
    },
  };

  const conditionsHandler = load(
    'workflowEngine/blocksHandler/handlerWhileLoop.js',
    conditionMocks
  ).default;
  const repeatTaskHandler = load(
    'workflowEngine/blocksHandler/handlerRepeatTask.js'
  ).default;

  const nextId = (id, output) => {
    const handle = `${id}-output-${output ?? 1}`;
    const edge = edges.find((item) => item.source === id && item.sourceHandle === handle);

    return edge ? edge.target : null;
  };

  // JS 块：按真实 automa API 语义执行模板里的代码字符串
  const runJs = (node) =>
    new Promise((resolve, reject) => {
      const fn = new Function(
        'automaRefData',
        'automaSetVariable',
        'automaNextBlock',
        'document',
        node.data.code
      );

      const fakeRow = (row) => ({
        querySelector: (selector) => {
          const nth = /nth-child\((\d+)\)/.exec(selector);

          return nth
            ? { textContent: row.cells[Number(nth[1]) - 1] ?? '' }
            : null;
        },
      });
      const doc = {
        querySelectorAll: () => pages[site.pageIdx].map(fakeRow),
        querySelector: (selector) =>
          selector === config.pageMarkerSelector && config.pageMarkerSelector
            ? { textContent: `page-${site.pageIdx}` }
            : null,
      };

      fn(
        (keyword, name) => (name === undefined ? refData[keyword] : refData[keyword][name]),
        (name, value) => {
          vars[name] = value;
        },
        (data) => resolve(data),
        doc
      );
    });

  const workers = {
    repeat: {
      repeatedTasks: {},
      getBlockConnections: nextId,
    },
    conditions: {
      engine: { isPopup: false, workflow: { settings: {} } },
      activeTab: { id: 1 },
      getBlockConnections: nextId,
      _sendMessageToTab: async () => {
        throw new Error('模拟中不应触发条件代码/元素分支');
      },
    },
  };

  async function run() {
    let current = nextId('init-pages', null) ? 'init-pages' : null;
    // init-pages 的入口边实际来自 new-tab，这里直接从其下游开始
    current = 'init-pages';
    let prevData = '';
    let steps = 0;

    while (current && steps < 200) {
      steps += 1;
      const node = nodes[current];

      if (node.label === 'javascript-code') {
        prevData = await runJs(node);
        if (node.id === 'collect-page') visited.collect.push(site.pageIdx);
        current = nextId(current, null);
      } else if (node.label === 'repeat-task') {
        // 真实引擎在进 handler 前先渲染块数据中的模板串
        const rendered = await renderString(node.data.repeatFor);
        const result = await repeatTaskHandler.call(workers.repeat, {
          ...node,
          data: { ...node.data, repeatFor: rendered.value },
        });
        current = result.nextBlockId;
      } else if (node.label === 'while-loop') {
        const result = await conditionsHandler.call(
          workers.conditions,
          node,
          { prevBlockData: prevData, refData }
        );
        current = result.nextBlockId;
      } else if (node.label === 'event-click') {
        if (site.pageIdx >= pageCount - 1) {
          throw new Error('末页仍执行了下一页点击（D09 缺陷复现）');
        }

        site.clicks += 1;
        site.pageIdx += 1;
        current = nextId(current, null);
      } else if (node.label === 'export-data') {
        visited.export += 1;
        current = null;
      } else {
        throw new Error(`未模拟的块类型: ${node.label}`);
      }
    }

    return visited;
  }

  return { run, site, vars, visited, config };
}

test('template: 3-page simulation clicks next exactly twice', async () => {
  const sim = buildSim(3);
  const result = await sim.run();

  assert.equal(result.export, 1, '导出只执行一次');
  assert.equal(sim.site.clicks, 2, '3 页只需点击 2 次下一页');
  assert.equal(sim.visited.collect.length, 3, '每页采集一次');
});

test('template: single page never clicks next', async () => {
  const sim = buildSim(1);
  const result = await sim.run();

  assert.equal(result.export, 1);
  assert.equal(sim.site.clicks, 0);
  assert.equal(sim.visited.collect.length, 1);
});

test('template: last page routes to export before any next click', async () => {
  const sim = buildSim(2);

  await sim.run();

  // 点击只发生在第 1 页（索引 0），到达末页后直接结束
  assert.equal(sim.site.clicks, 1);
  assert.equal(sim.site.pageIdx, 1);
  assert.equal(sim.visited.export, 1);
});
