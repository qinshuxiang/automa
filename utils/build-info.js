const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

module.exports = function writeBuildInfo(directory) {
  const files = {};
  function walk(folder) {
    fs.readdirSync(folder, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach((entry) => {
        const file = path.join(folder, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.isFile() && entry.name !== '.build-info.json') {
          files[path.relative(directory, file)] = crypto
            .createHash('sha256')
            .update(fs.readFileSync(file))
            .digest('hex');
        }
      });
  }
  walk(directory);
  const source = path.resolve(__dirname, '..');
  const git = (args) => {
    try {
      return execFileSync('git', ['-C', source, ...args], {
        encoding: 'utf8',
      }).trim();
    } catch {
      return 'unavailable';
    }
  };
  fs.writeFileSync(
    path.join(directory, '.build-info.json'),
    `${JSON.stringify(
      {
        builtAt: new Date().toISOString(),
        node: process.version,
        sourceCommit: git(['rev-parse', 'HEAD']),
        sourceStatus: git(['status', '--short']),
        validation: 'build only; runtime verification is recorded separately',
        files,
      },
      null,
      2
    )}\n`
  );
};
