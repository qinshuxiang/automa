import browser from 'webextension-polyfill';
import { isWhitespace } from '@/utils/helper';

function setProxy({ data, id }) {
  const nextBlockId = this.getBlockConnections(id);

  return new Promise((resolve, reject) => {
    if (data.clearProxy) {
      browser.proxy.settings.clear({});
    }

    const config = {
      mode: 'fixed_servers',
      rules: {
        singleProxy: {
          scheme: data.scheme,
        },
        bypassList: isWhitespace(data.bypassList)
          ? []
          : data.bypassList.split(','),
      },
    };

    let proxyPort = data.port;

    if (!isWhitespace(data.host)) {
      let proxyHost = data.host;

      // scheme 整体分组匹配：原正则未分组时 socks4/socks5 会脱离锚点
      const schemeRegex = /^(https?|socks4|socks5):\/\//i;
      if (schemeRegex.test(data.host)) {
        /* eslint-disable-next-line */
        let [scheme, host] = data.host.split(/:\/\/(.*)/);

        if (host.includes(':')) {
          [host, proxyPort] = host.split(':');
        }

        proxyHost = host;
        config.rules.singleProxy.scheme = scheme;
      }

      config.rules.singleProxy.host = proxyHost;
    } else {
      if (data.clearProxy) {
        this.engine.isUsingProxy = false;

        resolve({
          data: '',
          nextBlockId,
        });

        return;
      }

      const error = new Error('invalid-proxy-host');
      error.nextBlockId = nextBlockId;

      reject(error);
      return;
    }

    // 端口必须是 1..65535 的整数：Chromium 90 会把非法端口钳位为 65535
    // 且不置 lastError，必须在调用前拦截
    if (
      proxyPort !== '' &&
      proxyPort != null &&
      (!Number.isInteger(Number(proxyPort)) ||
        Number(proxyPort) < 1 ||
        Number(proxyPort) > 65535)
    ) {
      const error = new Error('invalid-proxy-port');
      error.nextBlockId = nextBlockId;

      reject(error);
      return;
    }

    if (proxyPort !== '' && proxyPort != null) {
      config.rules.singleProxy.port = +proxyPort;
    }

    chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
      // 设置失败经 chrome.runtime.lastError 传播为异常
      const proxyError = chrome.runtime.lastError;

      if (proxyError) {
        reject(new Error(proxyError.message || 'proxy-settings-failed'));
        return;
      }

      this.engine.isUsingProxy = true;

      resolve({
        data: data.host,
        nextBlockId,
      });
    });
  });
}

export default setProxy;
