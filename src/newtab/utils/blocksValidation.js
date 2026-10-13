import browser from 'webextension-polyfill';
import {
  INSERT_DATA_ACTIONS,
  isValidCellRange,
  resolveInsertFileType,
} from '@/utils/insertData';

const checkPermissions = (permissions) =>
  browser.permissions.contains({ permissions });
const isEmptyStr = (str) => !str.trim();
const isFirefox = BROWSER_TYPE === 'firefox';
const defaultOptions = {
  once: false,
};

export async function validateTrigger(data) {
  const errors = [];
  const checkValue = (value, { name, location }) => {
    if (value && value.trim()) return;

    errors.push(`${location}中的“${name}”为空`);
  };
  const triggersValidation = {
    'cron-job': (triggerData) => {
      checkValue(triggerData.expression, {
        name: '表达式',
        location: '定时任务触发器',
      });
    },
    'context-menu': async (triggerData) => {
      const permission = isFirefox ? 'menus' : 'contextMenus';
      const hasPermission = await checkPermissions([permission]);

      if (!hasPermission) {
        errors.push('缺少右键菜单触发器所需权限（若已授权可忽略）');
      } else {
        checkValue(triggerData.contextMenuName, {
          name: '右键菜单名称',
          location: '右键菜单触发器',
        });
      }
    },
    date: (triggerData) => {
      checkValue(triggerData.date, {
        name: '日期',
        location: '指定日期触发器',
      });
    },
    'visit-web': (triggerData) => {
      checkValue(triggerData.url, {
        name: '网址',
        location: '访问网页触发器',
      });
    },
    'keyboard-shortcut': (triggerData) => {
      checkValue(triggerData.shortcut, {
        name: '快捷键',
        location: '快捷键触发器',
      });
    },
  };

  if (data.triggers) {
    for (const trigger of data.triggers) {
      const validate = triggersValidation[trigger.type];
      if (validate) await validate(trigger.data);
    }
  } else {
    const validate = triggersValidation[data.type];
    if (validate) await validate(data);
  }

  return errors;
}

export async function validateExecuteWorkflow(data) {
  if (isEmptyStr(data.workflowId)) return ['未选择工作流'];

  return [];
}

export async function validateNewTab(data) {
  if (isEmptyStr(data.url)) return ['网址为空'];

  return [];
}

export async function validateSwitchTab(data) {
  const errors = [];
  const validateItems = {
    'match-patterns': () => {
      if (isEmptyStr(data.matchPattern)) errors.push('匹配规则为空');
    },
    'tab-title': () => {
      if (isEmptyStr(data.tabTitle)) errors.push('标签页标题为空');
    },
  };

  if (validateItems[data.findTabBy]) validateItems[data.findTabBy]();

  return errors;
}

export async function validateProxy(data) {
  if (isEmptyStr(data.host)) return ['主机地址为空'];

  return [];
}

export async function validateCloseTab(data) {
  if (data.closeType === 'tab' && !data.activeTab && isEmptyStr(data.url)) {
    return ['匹配规则为空'];
  }

  return [];
}

export async function validateTakeScreenshot(data) {
  if (data.type === 'element' && isEmptyStr(data.selector)) {
    return ['CSS 选择器为空'];
  }

  return [];
}

export async function validateInteractionBasic(data) {
  if (isEmptyStr(data.selector)) return ['选择器为空'];

  return [];
}

export async function validateExportData(data) {
  const errors = [];

  const hasPermission = await checkPermissions(['downloads']);
  if (!hasPermission) errors.push('缺少下载权限（若已授权可忽略）');

  if (data.dataToExport === 'variable' && isEmptyStr(data.variableName)) {
    errors.push('变量名称为空');
  }

  return errors;
}

export async function validateAttributeValue(data) {
  const errors = [];

  if (isEmptyStr(data.selector)) errors.push('选择器为空');
  if (isEmptyStr(data.attributeName)) errors.push('属性名称为空');

  return errors;
}

export async function validateWebhook(data) {
  if (isEmptyStr(data.url)) return ['网址为空'];

  return [];
}

export async function validateInsertData(data) {
  const errors = [];

  (data.dataList || []).forEach((item, index) => {
    const prefix = `第 ${index + 1} 项`;

    // 目标类型先校验：非法显式类型直接报错，与执行引擎、归一化逻辑一致
    if (
      item.type != null &&
      item.type !== 'table' &&
      item.type !== 'variable'
    ) {
      errors.push(`${prefix}的导入目标类型无效`);
      return;
    }

    if (item.type === 'variable' && isEmptyStr(item.name)) {
      errors.push(`${prefix}的变量名称为空`);
    } else if (item.type !== 'variable' && isEmptyStr(item.name)) {
      errors.push(`${prefix}未选择表格列`);
    }

    if (!item.isFile) return;

    if (isEmptyStr(item.filePath)) errors.push(`${prefix}的文件路径为空`);

    const action = item.action || item.csvAction || 'default';
    if (!INSERT_DATA_ACTIONS.includes(action)) {
      errors.push(`${prefix}的动作“${String(action)}”无效`);
    }

    // 仅 Excel 格式的 json/json-header 动作校验单元格范围
    const range =
      resolveInsertFileType(item.filePath, item).format === 'excel' &&
      ['json', 'json-header'].includes(action)
        ? (item.xlsRange || '').trim()
        : '';

    if (range && !isValidCellRange(range)) {
      errors.push(`${prefix}的单元格范围“${range}”无效（示例：A1:C10）`);
    }
  });

  return errors;
}

export async function validateLoopData(data) {
  const errors = [];
  if (isEmptyStr(data.loopId)) errors.push('循环标识为空');

  const loopThroughItems = {
    variable: () => {
      if (isEmptyStr(data.variableName)) errors.push('变量名称为空');
    },
  };
  const validateItem = loopThroughItems[data.loopThrough];
  if (validateItem) validateItem();

  return errors;
}

export async function validateLoopElements(data) {
  const errors = [];
  if (isEmptyStr(data.loopId)) errors.push('循环标识为空');
  if (isEmptyStr(data.selector)) errors.push('选择器为空');

  if (
    ['click-element', 'click-link'].includes(data.loadMoreAction) &&
    isEmptyStr(data.actionElSelector)
  ) {
    errors.push('用于加载更多元素的选择器为空');
  }

  return errors;
}

export async function validateClipboard() {
  const permissions = isFirefox
    ? ['clipboardRead', 'clipboardWrite']
    : ['clipboardRead'];
  const hasPermission = await checkPermissions(permissions);

  if (!hasPermission) return ['缺少剪贴板访问权限（若已授权可忽略）'];

  return [];
}

export async function validateSwitchTo(data) {
  if (data.windowType === 'iframe' && isEmptyStr(data.selector)) {
    return ['内嵌框架选择器为空'];
  }

  return [];
}

export async function validateUploadFile(data) {
  const errors = [];

  if (isEmptyStr(data.selector)) errors.push('选择器为空');

  const someInputsEmpty = data.filePaths.some((path) => isEmptyStr(path));
  if (someInputsEmpty) errors.push('部分文件路径为空');

  return errors;
}

export async function validateSaveAssets(data) {
  const errors = [];

  const hasPermission = await checkPermissions(['downloads']);
  if (!hasPermission) errors.push('缺少下载权限（若已授权可忽略）');
  else if (isEmptyStr(data.selector) && data.type === 'element')
    errors.push('选择器为空');

  return errors;
}

export async function validatePressKey(data) {
  const errors = [];

  const isKeyEmpty =
    !data.action || (data.action === 'press-key' && isEmptyStr(data.keys));
  const isMultipleKeysEmpty =
    data.action === 'multiple-keys' && isEmptyStr(data.keysToPress);
  if (isKeyEmpty || isMultipleKeysEmpty) errors.push('待按下的按键为空');

  return errors;
}

export async function validateNotification() {
  const hasPermission = await checkPermissions(['notifications']);
  if (!hasPermission) return ['缺少通知权限'];

  return [];
}

export async function validateCookie() {
  const hasPermission = await checkPermissions(['cookies']);
  if (!hasPermission) return ['缺少 Cookie 权限'];

  return [];
}

export default {
  trigger: {
    ...defaultOptions,
    func: validateTrigger,
  },
  'execute-workflow': {
    ...defaultOptions,
    func: validateExecuteWorkflow,
  },
  'new-tab': {
    ...defaultOptions,
    func: validateNewTab,
  },
  'switch-tab': {
    ...defaultOptions,
    func: validateSwitchTab,
  },
  proxy: {
    ...defaultOptions,
    func: validateProxy,
  },
  'close-tab': {
    ...defaultOptions,
    func: validateCloseTab,
  },
  'take-screenshot': {
    ...defaultOptions,
    func: validateTakeScreenshot,
  },
  'event-click': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'get-text': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'export-data': {
    ...defaultOptions,
    func: validateExportData,
  },
  'element-scroll': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  link: {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'attribute-value': {
    ...defaultOptions,
    func: validateAttributeValue,
  },
  forms: {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'trigger-event': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'element-exists': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  webhook: {
    ...defaultOptions,
    func: validateWebhook,
  },
  'insert-data': {
    ...defaultOptions,
    func: validateInsertData,
  },
  'loop-data': {
    ...defaultOptions,
    func: validateLoopData,
  },
  'loop-elements': {
    ...defaultOptions,
    func: validateLoopElements,
  },
  clipboard: {
    once: true,
    func: validateClipboard,
  },
  'switch-to': {
    ...defaultOptions,
    func: validateSwitchTo,
  },
  'upload-file': {
    ...defaultOptions,
    func: validateUploadFile,
  },
  'hover-element': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  'save-assets': {
    ...defaultOptions,
    func: validateSaveAssets,
  },
  'press-key': {
    ...defaultOptions,
    func: validatePressKey,
  },
  notification: {
    ...defaultOptions,
    func: validateNotification,
  },
  'create-element': {
    ...defaultOptions,
    func: validateInteractionBasic,
  },
  cookie: {
    ...defaultOptions,
    func: validateCookie,
  },
};
