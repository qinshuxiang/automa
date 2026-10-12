import { parseJSON, isWhitespace } from '@/utils/helper';
import getFile from '@/utils/getFile';

const renderContent = async (content, contentType) => {
  if (contentType === 'text') return content;

  const renderedJson = parseJSON(content, new Error('invalid-body'));

  if (renderedJson instanceof Error) throw renderedJson;

  if (contentType === 'form') {
    return new URLSearchParams(renderedJson);
  }
  if (contentType === 'form-data') {
    if (!Array.isArray(renderedJson) || !Array.isArray(renderedJson[0])) {
      throw new Error('请求体必须是二维数组');
    }

    const formData = new FormData();
    for (const data of renderedJson) {
      const [name, value, customFilename] = data;
      const stringValue = String(value);
      // 仅绝对路径样式的值按文件处理（盘符/斜杠开头、~/、file:），
      // 含点号的文本不再被误判为文件路径
      const isFile =
        /^([a-zA-Z]:)?[\\/]/.test(stringValue) ||
        stringValue.startsWith('~/') ||
        stringValue.startsWith('file:');
      const isURL = /^https?:\/\//i.test(stringValue);

      let formContent = stringValue;
      let filename = customFilename;

      if (isFile || isURL) {
        formContent = await getFile(stringValue, { returnValue: true });

        if (!filename) {
          filename = stringValue.split('/').pop();
        }

        if (!formContent) throw new Error('未找到文件');
      } else if (/^data:/i.test(stringValue)) {
        const response = await fetch(stringValue);

        formContent = await response.blob();
      } else if (filename) {
        // 指定了文件名的标量文本按 Blob(text/plain) 发送，
        // 不再经 btoa 中转，中文与非 Latin1 字符不再损坏
        formContent = new Blob([stringValue], { type: 'text/plain' });
      }

      const args = [name, formContent];
      if (filename) args.push(filename);

      formData.append(...args);
    }

    return formData;
  }

  return JSON.stringify(renderedJson);
};

const filterHeaders = (headers) => {
  const filteredHeaders = {};

  if (!headers || !Array.isArray(headers)) return filteredHeaders;

  headers.forEach((item) => {
    if (item.name && item.value) {
      filteredHeaders[item.name] = item.value;
    }
  });
  return filteredHeaders;
};

const contentTypes = {
  text: 'text/plain',
  json: 'application/json',
  'form-data': 'multipart/form-data',
  form: 'application/x-www-form-urlencoded',
};
const notHaveBody = ['GET', 'HEAD'];

export async function executeWebhook({
  url,
  contentType,
  headers,
  timeout,
  body,
  method,
}) {
  let timeoutId = null;
  let controller = null;

  if (timeout > 0) {
    controller = new AbortController();
    timeoutId = setTimeout(() => {
      controller.abort();
    }, timeout);
  }

  try {
    const finalHeaders = filterHeaders(headers);
    if (contentType !== 'form-data')
      finalHeaders['Content-Type'] = contentTypes[contentType || 'json'];

    const payload = {
      headers: finalHeaders,
      method: method || 'POST',
    };
    if (controller) payload.signal = controller.signal;

    if (!notHaveBody.includes(method || 'POST') && !isWhitespace(body)) {
      payload.body = await renderContent(body, contentType);
    }

    const response = await fetch(url, payload);

    // 超时计时器挂到响应对象上：读响应体期间的超时同样生效，
    // 由消费方在读完 body 后清理
    response.__automaTimeoutId = timeoutId;

    return response;
  } catch (error) {
    if (timeoutId) clearTimeout(timeoutId);

    throw error;
  }
}
