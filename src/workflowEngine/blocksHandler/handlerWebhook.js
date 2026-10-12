import objectPath from 'object-path';
import { isWhitespace } from '@/utils/helper';
import { executeWebhook } from '../utils/webhookUtil';
import renderString from '../templating/renderString';

const ALL_HTTP_RESPONSE_KEYWORD = '$response';

export async function webhook({ data, id }, { refData }) {
  const nextBlockId = this.getBlockConnections(id);
  const fallbackOutput = this.getBlockConnections(id, 'fallback');

  let response;

  try {
    if (isWhitespace(data.url)) throw new Error('url-empty');
    if (!data.url.startsWith('http')) {
      const error = new Error('invalid-active-tab');
      error.data = { url: data.url };

      throw error;
    }

    const newHeaders = [];
    for (const { value, name } of data.headers) {
      const newValue = (await renderString(value, refData, this.engine.isPopup))
        .value;

      newHeaders.push({ name, value: newValue });
    }

    response = await executeWebhook({ ...data, headers: newHeaders });

    if (!response.ok) {
      const { status, statusText } = response;

      // 非 JSON 错误响应体先按原文读取，再按需 JSON.parse，
      // 解析失败保留原文，不再抛二次异常丢 ctxData
      let errorBody = null;
      try {
        const rawBody = await response.text();

        try {
          errorBody =
            data.responseType === 'json' ? JSON.parse(rawBody) : rawBody;
        } catch {
          errorBody = rawBody;
        }
      } catch {
        errorBody = null;
      }

      if (response.__automaTimeoutId) {
        clearTimeout(response.__automaTimeoutId);
      }

      const ctxData = {
        ctxData: {
          request: { status, statusText, data: errorBody },
        },
      };

      if (fallbackOutput && fallbackOutput.length > 0) {
        return {
          ctxData,
          data: '',
          nextBlockId: fallbackOutput,
        };
      }

      const error = new Error(`(${response.status}) ${response.statusText}`);
      error.ctxData = ctxData;

      throw error;
    }

    if (!data.assignVariable && !data.saveData) {
      if (response.__automaTimeoutId) {
        clearTimeout(response.__automaTimeoutId);
      }

      return {
        data: '',
        nextBlockId,
      };
    }

    const includeResponse = data.dataPath.includes(ALL_HTTP_RESPONSE_KEYWORD);
    let returnData = '';

    if (data.responseType === 'json') {
      const jsonRes = await response.json();

      if (!includeResponse) {
        returnData = objectPath.get(jsonRes, data.dataPath);
      } else {
        returnData = jsonRes;
      }
    } else if (data.responseType === 'base64') {
      const blob = await response.blob();
      // Chromium 90 垫片读取：统一经 async-lifecycle 的 FileReader 封装
      returnData = await globalThis.__automaAsyncLifecycle.readBlob(
        blob,
        'dataURL'
      );
    } else {
      returnData = await response.text();
    }

    if (response.__automaTimeoutId) {
      clearTimeout(response.__automaTimeoutId);
    }

    if (includeResponse) {
      const { status, statusText, url, redirected, ok } = response;
      const responseData = {
        ok,
        url,
        status,
        statusText,
        redirected,
        data: returnData,
      };

      returnData = objectPath.get({ $response: responseData }, data.dataPath);
    }

    if (data.assignVariable) {
      await this.setVariable(data.variableName, returnData);
    }
    if (data.saveData) {
      if (data.dataColumn === '$assignColumns' && Array.isArray(returnData)) {
        this.addDataToColumn(returnData);
      } else {
        this.addDataToColumn(data.dataColumn, returnData);
      }
    }

    return {
      nextBlockId,
      data: returnData,
    };
  } catch (error) {
    const fallbackErrors = ['Failed to fetch', 'user aborted'];
    const executeFallback =
      fallbackOutput &&
      fallbackErrors.some((message) => error.message.includes(message));
    if (executeFallback) {
      return {
        data: '',
        nextBlockId: fallbackOutput,
      };
    }

    error.nextBlockId = nextBlockId;

    throw error;
  } finally {
    // 任何出口都不泄漏超时计时器
    if (response?.__automaTimeoutId) {
      clearTimeout(response.__automaTimeoutId);
    }
  }
}

export default webhook;
