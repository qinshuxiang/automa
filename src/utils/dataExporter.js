import Papa from 'papaparse';
import { fileSaver } from './helper';

export const files = {
  'plain-text': {
    mime: 'text/plain',
    ext: '.txt',
  },
  json: {
    mime: 'application/json',
    ext: '.json',
  },
  csv: {
    mime: 'text/csv',
    ext: '.csv',
  },
};

export function generateJSON(keys, data) {
  if (Array.isArray(data)) return data;

  const result = [];

  keys.forEach((key) => {
    for (let index = 0; index < data[key].length; index += 1) {
      const currData = data[key][index];

      if (typeof result[index] === 'undefined') {
        result.push({ [key]: currData });
      } else {
        result[index][key] = currData;
      }
    }
  });

  return result;
}

export default function (
  data,
  { name, type, addBOMHeader, csvOptions, returnUrl, returnBlob },
  converted
) {
  let result = data;

  if (type === 'csv' || type === 'json') {
    const jsonData = converted ? data : generateJSON(Object.keys(data), data);

    result =
      type === 'csv'
        ? Papa.unparse(jsonData, csvOptions || {})
        : JSON.stringify(jsonData, null, 2);
  } else if (type === 'plain-text') {
    const extractObj = (obj) => {
      // 显式处理 null/undefined：不是对象直接作为单项返回
      if (obj === null || obj === undefined || typeof obj !== 'object') {
        return [obj];
      }

      // 需要处理深层对象 不然会返回:[object Object]
      // 构建副本返回：不再原地修改输入对象
      const copy = {};
      Object.keys(obj).forEach((key) => {
        const itemValue = obj[key];
        copy[key] =
          itemValue !== null &&
          itemValue !== undefined &&
          typeof itemValue === 'object'
            ? JSON.stringify(itemValue)
            : itemValue;
      });

      return Object.values(copy);
    };

    result = (
      Array.isArray(data)
        ? data.flatMap((item) => extractObj(item))
        : extractObj(data)
    ).join(' ');
  }

  const payload = [result];

  if (type === 'csv' && addBOMHeader) {
    payload.unshift(new Uint8Array([0xef, 0xbb, 0xbf]));
  }

  const { mime, ext } = files[type];
  const blob = new Blob(payload, { type: mime });
  if (returnBlob) return blob;

  const blobUrl = URL.createObjectURL(blob);

  if (!returnUrl) fileSaver(`${name || 'unnamed'}${ext}`, blobUrl);

  return blobUrl;
}
