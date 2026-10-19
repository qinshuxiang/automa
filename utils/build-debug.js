// 诊断用：与 utils/build.js 相同配置，但完整输出 stats 错误与警告
process.env.BABEL_ENV = 'production';
process.env.NODE_ENV = 'production';
process.env.ASSET_PATH = '/';

const webpack = require('webpack');
const config = require('../webpack.config');

delete config.chromeExtensionBoilerplate;
config.mode = 'production';
config.stats = 'errors-warnings';

webpack(config, (err, stats) => {
  if (err) {
    console.error('FATAL:', err);
    process.exit(1);
  }
  const info = stats.toJson({ errors: true, warnings: true, assets: false });
  console.log(
    'hasErrors:',
    stats.hasErrors(),
    'hasWarnings:',
    stats.hasWarnings()
  );
  if (info.errors && info.errors.length) {
    console.log('ERRORS:');
    info.errors.slice(0, 5).forEach((e) => {
      if (typeof e === 'string') {
        console.log(e.slice(0, 4000));
        return;
      }
      console.log('message:', e.message);
      console.log('stack:', e.stack || '(none)');
      console.log('moduleName:', e.moduleName);
      console.log('loc:', e.loc);
      console.log('full:', JSON.stringify(e).slice(0, 4000));
    });
  }
  if (info.warnings && info.warnings.length) {
    console.log('WARNINGS (first 3):');
    info.warnings.slice(0, 3).forEach((w) => {
      console.log(
        typeof w === 'string'
          ? w.slice(0, 800)
          : w.message || JSON.stringify(w).slice(0, 800)
      );
    });
  }
  process.exit(stats.hasErrors() ? 1 : 0);
});
