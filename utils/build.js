/* eslint-disable no-console */
// Do this as the first thing so that any code reading it knows the right env.
process.env.BABEL_ENV = 'production';
process.env.NODE_ENV = 'production';
process.env.ASSET_PATH = '/';

const webpack = require('webpack');
const config = require('../webpack.config');
const writeBuildInfo = require('./build-info');

delete config.chromeExtensionBoilerplate;

config.mode = 'production';

// 构建缺陷修复：原脚本不读取 stats，编译错误（如 NoEmitOnErrorsPlugin
// 抑制产物输出）会静默通过且退出码为 0。这里显式输出错误并返回非零退出码。
webpack(config, (err, stats) => {
  if (err) {
    console.error(err);
    process.exit(1);
    return;
  }

  if (stats.hasErrors() || stats.hasWarnings()) {
    const info = stats.toJson('errors-warnings');

    (info.errors || []).forEach((error) => {
      console.error(typeof error === 'string' ? error : error.message || error);
    });
    (info.warnings || []).forEach((warning) => {
      console.warn(
        typeof warning === 'string' ? warning : warning.message || warning
      );
    });
  }

  console.log(
    stats.toString({
      colors: false,
      chunks: false,
      modules: false,
      children: false,
    })
  );

  if (stats.hasErrors()) {
    process.exitCode = 1;
    return;
  }
  writeBuildInfo(config.output.path);
});
