// 源码级测试 harness：把 src 下的 ESM（非 Vue）模块用 Babel 转成 CJS 后在当前
// realm 执行。使用当前 realm 是刻意的：instanceof Error 等跨模块判定必须与
// 真实运行一致，vm.runInNewContext 的新 realm 会产生假失败。
// 依赖解析顺序：显式 mocks → '@/...' 别名递归加载真实源码 → node_modules。
// 浏览器全局（document、fetch、XMLHttpRequest 等）通过包装函数参数注入，
// 不污染 globalThis。
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const babel = require('@babel/core');

const srcRoot = path.resolve(__dirname, '../src');

const transformCache = new Map();

function transformSource(relative) {
  if (transformCache.has(relative)) return transformCache.get(relative);

  const file = require.resolve(path.join(srcRoot, relative));
  const code = fs.readFileSync(file, 'utf8');
  const result = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    plugins: [require.resolve('@babel/plugin-transform-modules-commonjs')],
  }).code;

  transformCache.set(relative, result);

  return result;
}

/**
 * 加载一个源码模块。
 * @param {string} relative 相对 src/ 的模块路径，如 'utils/insertData.js'
 * @param {Record<string, unknown>} mocks 按 import 说明符覆盖的依赖
 * @param {Record<string, unknown>} globals 以参数形式注入的浏览器全局
 * @returns {Record<string, unknown>} module.exports
 */
function load(relative, mocks = {}, globals = {}) {
  const code = transformSource(relative);
  const module = { exports: {} };
  const globalNames = Object.keys(globals);

  const localRequire = (name) => {
    if (Object.hasOwn(mocks, name)) return mocks[name];

    if (name.startsWith('@/') || name.startsWith('.')) {
      const target = name.startsWith('@/') ? name.slice(2) : path.join(path.dirname(relative), name);
      return load(target, mocks._deep || {}, globals);
    }

    return require(name);
  };

  const wrapper = vm.runInThisContext(
    `(function (module, exports, require, __filename, __dirname, ${globalNames.join(',')}) {\n${code}\n})`,
    { filename: `src/${relative}`, displayErrors: true }
  );

  wrapper(
    module,
    module.exports,
    localRequire,
    path.join(srcRoot, relative),
    path.dirname(path.join(srcRoot, relative)),
    ...globalNames.map((name) => globals[name])
  );

  return module.exports;
}

/** 用 SheetJS 生成与历史 fixture.xlsx 等价的测试字节：工作表“数据”，A1:B3 */
function makeExcelBytes(xlsx) {
  const workbook = xlsx.utils.book_new();
  const sheet = xlsx.utils.aoa_to_sheet([
    ['姓名', '数量'],
    ['甲', 2],
    ['乙', 3],
  ]);

  xlsx.utils.book_append_sheet(workbook, sheet, '数据');

  return xlsx.write(workbook, { bookType: 'xlsx', type: 'array' });
}

module.exports = { load, makeExcelBytes };
