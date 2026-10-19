/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const packageJSON = require('../package.json');

async function main() {
  const browser = process.env.BROWSER || 'chrome';
  const destDir = path.resolve(
    __dirname,
    '..',
    process.env.AUTOMA_OUTPUT_DIR || 'build'
  );
  const zipDir = path.resolve(
    __dirname,
    '..',
    process.env.AUTOMA_ZIP_DIR || `build-zip/${packageJSON.version}`
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(destDir, 'manifest.json'), 'utf8')
  );
  if (!manifest.version) throw new Error('构建清单缺少版本，拒绝打包');
  fs.mkdirSync(zipDir, { recursive: true });
  const target = path.join(
    zipDir,
    `${packageJSON.name}-${browser}-v${packageJSON.version}.zip`
  );
  const temporary = `${target}.${process.pid}.tmp`;
  const archive = archiver('zip', { zlib: { level: 9 } });
  const stream = fs.createWriteStream(temporary, { flags: 'wx' });
  try {
    await new Promise((resolve, reject) => {
      stream.on('error', reject);
      stream.on('close', resolve);
      archive.on('error', reject);
      archive.on('warning', reject);
      archive.pipe(stream);
      archive.directory(destDir, false);
      archive.finalize().catch(reject);
    });
    if (!fs.statSync(temporary).size) throw new Error('打包结果为空');
    fs.renameSync(temporary, target);
    console.log(`Success: ${target}`);
  } catch (error) {
    archive.abort();
    stream.destroy();
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
