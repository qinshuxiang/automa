import { getDocumentCtx } from '@/content/handleSelector';

// 注意：本函数会通过 .toString() 注入网页上下文执行，必须保持自包含（不引用外部变量）
export async function automaFetchClient(instance, { type, resource }) {
  if (!['text', 'json', 'base64'].includes(type))
    throw new Error('type 必须为 text、json 或 base64');
  const { url, ...options } = resource;
  const response = await fetch(url, options);
  if (!response.ok)
    throw new Error(`(${response.status}) ${response.statusText}`);
  if (type === 'text') return response.text();
  if (type === 'json') return response.json();
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取响应失败'));
    reader.onabort = () => reject(new Error('读取已取消'));
    reader.readAsDataURL(blob);
  });
}

export function jsContentHandlerEval({
  blockData,
  automaScript,
  preloadScripts,
}) {
  const preloadScriptsStr = preloadScripts
    .map(({ script }) => script)
    .join('\n');

  return `(() => {
    ${preloadScriptsStr}

    return new Promise(($automaResolve) => {
      const $automaTimeoutMs = ${blockData.data.timeout};
      let $automaTimeout = setTimeout(() => {
        $automaResolve();
      }, $automaTimeoutMs);

      ${automaScript}

      ${blockData.data.code}

      ${
        blockData.data.code.includes('automaNextBlock')
          ? ''
          : 'automaNextBlock()'
      }
    }).catch((error) => {
      return { columns: { data: { $error: true, message: error.message } } }
    });
  })();`;
}

export function jsContentHandler(
  $blockData,
  $preloadScripts,
  $automaScript,
  $execId
) {
  return new Promise((resolve, reject) => {
    try {
      let $documentCtx = document;

      if ($blockData.frameSelector) {
        const iframeCtx = getDocumentCtx($blockData.frameSelector);
        if (!iframeCtx) {
          reject(new Error('iframe-not-found'));
          return;
        }

        $documentCtx = iframeCtx;
      }

      const scriptAttr = `block--${$blockData.id}`;

      const isScriptExists = $documentCtx.querySelector(
        `.automa-custom-js[${scriptAttr}]`
      );
      if (isScriptExists) {
        resolve('');
        return;
      }

      const script = document.createElement('script');
      script.setAttribute(scriptAttr, '');
      script.classList.add('automa-custom-js');
      script.textContent = `(() => {
        ${$automaScript}

        try {
          ${$blockData.data.code}
          ${
            $blockData.data.everyNewTab ||
            $blockData.data.code.includes('automaNextBlock')
              ? ''
              : 'automaNextBlock()'
          }
        } catch (error) {
          console.error(error);
          ${
            $blockData.data.everyNewTab
              ? ''
              : 'automaNextBlock({ $error: true, message: error.message })'
          }
        }
      })()`;

      const preloadScriptsEl = $preloadScripts.map((item) => {
        const scriptEl = document.createElement('script');
        scriptEl.id = item.id;
        scriptEl.textContent = item.script;

        $documentCtx.head.appendChild(scriptEl);

        return { element: scriptEl, removeAfterExec: item.removeAfterExec };
      });

      if (!$blockData.data.everyNewTab) {
        let timeout;
        let onNextBlock;
        let onResetTimeout;

        // 未显式传入执行标识时生成本地唯一标识：
        // 完成事件必须携带匹配的 automaId 才会被接受
        let execId = $execId;
        if (!execId) {
          execId = `auto-${$blockData.id}-${Date.now()}-${Math.random()
            .toString(36)
            .slice(2)}`;
        }

        /* eslint-disable-next-line */
        function cleanUp() {
          script.remove();
          preloadScriptsEl.forEach((item) => {
            if (item.removeAfterExec) item.element.remove();
          });

          clearTimeout(timeout);

          $documentCtx.body.removeEventListener(
            '__automa-reset-timeout__',
            onResetTimeout
          );
          $documentCtx.body.removeEventListener(
            '__automa-next-block__',
            onNextBlock
          );
        }

        onNextBlock = ({ detail }) => {
          if (!detail) {
            resolve({ columns: {}, variables: {} });
            return;
          }

          // 回执身份校验：完成事件必须携带本执行的标识（automaId），
          // 否则同页并发执行的 JavaScript 节点会互相接收对方的完成事件
          if (detail.automaId !== execId) return;

          cleanUp();

          const payload = {
            insert: detail.insert,
            data: detail.data?.$error
              ? detail.data
              : JSON.stringify(detail?.data ?? {}),
          };
          resolve({
            columns: payload,
            variables: detail.refData?.variables,
          });
        };
        onResetTimeout = (event) => {
          const detail = event && event.detail;
          if (detail && detail.automaId && detail.automaId !== execId) return;

          clearTimeout(timeout);
          timeout = setTimeout(() => {
            cleanUp();
            reject(new Error('JavaScript 执行超时'));
          }, $blockData.data.timeout);
        };

        $documentCtx.body.addEventListener(
          '__automa-next-block__',
          onNextBlock
        );
        $documentCtx.body.addEventListener(
          '__automa-reset-timeout__',
          onResetTimeout
        );

        timeout = setTimeout(() => {
          cleanUp();
          reject(new Error('JavaScript 执行超时'));
        }, $blockData.data.timeout);
      } else {
        resolve();
      }

      $documentCtx.head.appendChild(script);
    } catch (error) {
      console.error(error);
    }
  });
}
