import browser from 'webextension-polyfill';
import { parseJSON } from '@/utils/helper';

function getValues(data, keys) {
  const values = {};
  keys.forEach((key) => {
    const value = data[key];

    // 仅剔除 null/undefined/空字符串；false、0 等是有效值不过滤
    if (value === null || value === undefined || value === '') return;

    values[key] = value;
  });

  return values;
}

const keys = {
  get: ['name', 'url'],
  remove: ['name', 'url'],
  getAll: ['domain', 'name', 'path', 'secure', 'url'],
  set: [
    'name',
    'url',
    'expirationDate',
    'domain',
    'path',
    'sameSite',
    'secure',
    'url',
    'value',
    'httpOnly',
  ],
};

async function cookie({ data, id }) {
  const hasPermission = await browser.permissions.contains({
    permissions: ['cookies'],
  });

  if (!hasPermission) {
    const error = new Error('no-permission');
    error.data = { permission: 'cookies' };

    throw error;
  }

  let key = data.type;
  if (key === 'get' && data.getAll) key = 'getAll';

  let result = null;

  if (data.useJson) {
    const obj = parseJSON(data.jsonCode, null);
    if (!obj) throw new Error('JSON 格式无效');

    result = await browser.cookies[key](obj);
  } else {
    const values = getValues(data, keys[key]);
    if (values.expirationDate) {
      values.expirationDate = Date.now() / 1000 + +values.expirationDate;
    }

    if (data.type === 'remove' && !data.name) {
      const cookies = await browser.cookies.getAll({ url: data.url });
      const removePromise = cookies.map(({ name }) =>
        browser.cookies.remove({ name, url: data.url })
      );
      await Promise.allSettled(removePromise);

      result = cookies;
    } else {
      result = await browser.cookies[key](values);
    }
  }

  if (data.type === 'get') {
    if (data.assignVariable) {
      await this.setVariable(data.variableName, result);
    }
    if (data.saveData) {
      this.addDataToColumn(data.dataColumn, result);
    }
  }

  return {
    data: result,
    nextBlockId: this.getBlockConnections(id),
  };
}

export default cookie;
