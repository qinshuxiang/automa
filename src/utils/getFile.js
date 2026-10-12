export function readFileAsBase64(blob, options = {}) {
  return globalThis.__automaAsyncLifecycle.readBlob(
    blob,
    'dataURL',
    options.signal
  );
}

async function downloadFile(url, options = {}) {
  const response = await fetch(url, { signal: options.signal });
  if (!response.ok) throw new Error(response.statusText);

  const type = options.responseType || 'blob';
  const result = await response[type]();

  if (options.returnValue) {
    return result;
  }

  if (URL.createObjectURL) {
    const objUrl = URL.createObjectURL(result);
    return { objUrl, path: url, type: result.type };
  }

  const base64 = await readFileAsBase64(result, options);
  return { path: url, objUrl: base64, type: result.type };
}
function getLocalFile(path, options = {}) {
  return new Promise((resolve, reject) => {
    const isFile = /\.(.*)/.test(path);

    if (!isFile) {
      reject(new Error(`文件路径“${path}”无效。`));
      return;
    }

    const fileUrl = path?.startsWith('file://') ? path : `file://${path}`;

    /* eslint-disable-next-line */
    if ('XMLHttpRequest' in self) {
      const xhr = new XMLHttpRequest();
      xhr.responseType = options.responseType || 'blob';

      // 一次完成控制：任一出口触发后其余回调全部失效，abort 监听同步清理
      let abortHandler = null;
      let settled = false;
      const settle = (error, value) => {
        if (settled) return;
        settled = true;

        if (options.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }
        xhr.onload = null;
        xhr.onerror = null;
        xhr.onabort = null;

        if (error) reject(error);
        else resolve(value);
      };

      abortHandler = () => {
        settle(new Error('文件读取已取消'));
        xhr.abort();
      };

      xhr.onload = () => {
        try {
          if (xhr.status === 0 || xhr.status === 200) {
            if (options.returnValue) {
              settle(null, xhr.response);
              return;
            }

            const objUrl = URL.createObjectURL(xhr.response);
            settle(null, { path, objUrl, type: xhr.response.type });
          } else {
            settle(new Error(xhr.statusText));
          }
        } catch (error) {
          settle(error);
        }
      };
      xhr.onerror = function () {
        settle(new Error(xhr.statusText || `未找到路径为“${path}”的文件`));
      };
      xhr.onabort = function () {
        settle(new Error('文件读取已取消'));
      };

      if (options.signal) {
        if (options.signal.aborted) {
          settle(new Error('文件读取已取消'));
          return;
        }

        options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        xhr.open('GET', fileUrl);
        xhr.send();
      } catch (error) {
        settle(error);
      }
    } else {
      fetch(fileUrl, { signal: options.signal })
        .then((response) => {
          if (!response.ok) throw new Error(response.statusText);

          if (options.returnValue) {
            const responseType = options.responseType || 'blob';

            if (responseType === 'json') return response.json();
            if (responseType === 'text') return response.text();
            return response.blob();
          }

          return response.blob();
        })
        .then((result) => {
          if (options.returnValue) {
            resolve(result);
            return;
          }
          if (!result) return;

          if (URL.createObjectURL) {
            const objUrl = URL.createObjectURL(result);
            resolve({ path, objUrl, type: result.type });
            return;
          }

          readFileAsBase64(result, options).then((base64) => {
            resolve({ path, objUrl: base64, type: result.type });
          });
        })
        .catch(reject);
    }
  });
}

export default function (path, options = {}) {
  // HTTP(S) 判定不区分大小写，与格式识别器保持一致
  if (/^https?:\/\//i.test(path)) return downloadFile(path, options);

  return getLocalFile(path, options);
}
