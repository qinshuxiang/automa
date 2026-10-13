import browser from 'webextension-polyfill';

const getFileExtension = (str) => /(?:\.([^.]+))?$/.exec(str)[1];

function determineFilenameListener(item, suggest) {
  const filesname =
    JSON.parse(sessionStorage.getItem('rename-downloaded-files')) || {};
  const suggestion = filesname[item.id];

  if (!suggestion) return true;

  const hasFileExt = getFileExtension(suggestion.filename);

  if (!hasFileExt) {
    const fileExtension = getFileExtension(item.filename);
    suggestion.filename += `.${fileExtension}`;
  }

  if (!suggestion.waitForDownload) delete filesname[item.id];

  sessionStorage.setItem('rename-downloaded-files', JSON.stringify(filesname));

  suggest({
    filename: suggestion.filename,
    conflictAction: suggestion.onConflict,
  });

  return false;
}

async function handleDownload({ data, id: blockId }) {
  const nextBlockId = this.getBlockConnections(blockId);
  const getFilesname = () =>
    JSON.parse(sessionStorage.getItem('rename-downloaded-files')) || {};

  let downloadId = null;
  if (data.downloadId?.trim()) {
    if (Number.isNaN(+data.downloadId)) throw new Error('下载标识不是数字');

    const [downloadItem] = await browser.downloads.search({
      id: +data.downloadId,
    });
    if (!downloadItem)
      throw new Error(`未找到标识为 ${data.downloadId} 的下载项`);

    if (downloadItem.state === 'complete') {
      if (data.saveData) {
        this.addDataToColumn(data.dataColumn, downloadItem.filename);
      }
      if (data.assignVariable) {
        await this.setVariable(data.variableName, downloadItem.filename);
      }

      return {
        nextBlockId,
        data: downloadItem.filename,
      };
    }

    downloadId = +data.downloadId;
  }

  const result = await new Promise((resolve, reject) => {
    if (!this.activeTab.id) throw new Error('no-tab');

    if (!chrome.downloads.onDeterminingFilename.hasListeners(() => {})) {
      chrome.downloads.onDeterminingFilename.addListener(
        determineFilenameListener
      );
    }

    // onCreated 认领下载：只认领本标签页触发的下载，
    // 不再认领其他标签页（tabId 不一致）的下载项
    const handleCreated = ({ id, tabId: createdTabId }) => {
      if (downloadId) return;
      if (
        createdTabId &&
        createdTabId !== -1 &&
        this.activeTab.id &&
        createdTabId !== this.activeTab.id
      )
        return;

      const names = getFilesname();

      downloadId = id;
      names[id] = data;
      sessionStorage.setItem('rename-downloaded-files', JSON.stringify(names));

      browser.downloads.onCreated.removeListener(handleCreated);
    };
    if (!downloadId) {
      browser.downloads.onCreated.addListener(handleCreated);
    }

    if (!data.waitForDownload) {
      browser.downloads.onCreated.removeListener(handleCreated);
      resolve({
        nextBlockId,
        data: data.filename,
      });

      return;
    }

    let isResolved = false;
    let currentFilename = data.filename;
    let timeout;

    const removeRenameRecord = (id) => {
      const filesname = getFilesname();
      delete filesname[id];
      sessionStorage.setItem(
        'rename-downloaded-files',
        JSON.stringify(filesname)
      );
    };

    // 成功/失败/超时/停止统一清理全部监听与重命名记录
    const cleanUp = () => {
      clearTimeout(timeout);
      isResolved = true;
      // eslint-disable-next-line no-use-before-define
      browser.downloads.onChanged.removeListener(handleChanged);
      browser.downloads.onCreated.removeListener(handleCreated);
      chrome.downloads.onDeterminingFilename.removeListener(
        determineFilenameListener
      );
    };

    timeout = setTimeout(() => {
      if (isResolved) return;

      cleanUp();
      if (downloadId) removeRenameRecord(downloadId);

      reject(new Error(`等待下载超时（${data.timeout}ms），下载仍未完成`));
    }, data.timeout);

    const resolvePromise = (id) => {
      if (data.saveData) {
        this.addDataToColumn(data.dataColumn, currentFilename);
      }
      if (data.assignVariable) {
        this.setVariable(data.variableName, currentFilename);
      }

      cleanUp();
      removeRenameRecord(id);

      resolve({
        nextBlockId,
        data: currentFilename,
      });
    };

    const handleChanged = (event) => {
      if (this.engine.isDestroyed) {
        cleanUp();
        reject(new Error('执行已停止，下载等待已取消'));
        return;
      }
      if (isResolved) {
        browser.downloads.onChanged.removeListener(handleChanged);
        return;
      }

      if (downloadId !== event.id) return;

      // 文件名增量事件先于下载状态处理
      if (event.filename) currentFilename = event.filename.current;

      if (!event.state) return;

      if (event.state.current === 'interrupted') {
        cleanUp();
        removeRenameRecord(downloadId);
        reject(new Error(`下载失败：${event.error?.current ?? '未知错误'}`));
        return;
      }

      if (event.state.current === 'complete') {
        resolvePromise(downloadId);
        return;
      }

      browser.downloads.search({ id: downloadId }).then(([download]) => {
        if (download && download.state === 'complete') {
          resolvePromise(downloadId);
        }
      });
    };

    browser.downloads.onChanged.addListener(handleChanged);
  });

  return result;
}

export default handleDownload;
