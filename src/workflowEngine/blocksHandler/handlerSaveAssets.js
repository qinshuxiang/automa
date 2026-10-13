import browser from 'webextension-polyfill';

export default async function ({ data, id, label }) {
  const hasPermission = await browser.permissions.contains({
    permissions: ['downloads'],
  });

  if (!hasPermission) {
    const error = new Error('no-permission');
    error.data = { permission: 'downloads' };

    throw error;
  }

  let sources = [data.url];
  let index = 0;
  const downloadFile = (url) => {
    const options = { url, conflictAction: data.onConflict };

    // 只对 URL 提取的路径做 decodeURIComponent，
    // 用户填写的文件名原样保留（如“完成率100%.jpg”不再报 URI malformed）
    let filename = data.filename || null;
    if (!filename) {
      try {
        const urlPart = new URL(url).pathname.split('/').pop();
        if (urlPart && /\.[0-9a-z]+$/i.test(urlPart)) {
          filename = decodeURIComponent(urlPart);
        }
      } catch (urlError) {
        filename = null;
      }
    }

    if (filename) {
      if (data.onConflict === 'overwrite' && index !== 0) {
        filename = `(${index}) ${filename}`;
      }

      options.filename = filename;
      index += 1;
    }

    return browser.downloads.download(options);
  };

  let downloadIds = null;

  if (data.type === 'element') {
    sources = await this._sendMessageToTab({
      id,
      data,
      label,
      tabId: this.activeTab.id,
    });

    downloadIds = await Promise.all(sources.map((url) => downloadFile(url)));
  } else if (data.type === 'url') {
    downloadIds = [await downloadFile(data.url)];
  }

  if (data.saveDownloadIds) {
    if (data.assignVariable) {
      await this.setVariable(data.variableName, downloadIds);
    }
    if (data.saveData) {
      this.addDataToColumn(data.dataColumn, downloadIds);
    }
  }

  return {
    data: { sources, downloadIds },
    nextBlockId: this.getBlockConnections(id),
  };
}
