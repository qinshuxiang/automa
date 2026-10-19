import { customAlphabet } from 'nanoid/non-secure';
import { visibleInViewport, isXPath } from '@/utils/helper';
import { automaRefDataStr } from '@/workflowEngine/helper';
import handleSelector from '../handleSelector';

const nanoid = customAlphabet('1234567890abcdef', 5);

async function handleConditionElement({ data, type, id, frameSelector }) {
  const selectorType = isXPath(data.selector) ? 'xpath' : 'cssSelector';

  const element = await handleSelector({
    id,
    data: {
      ...data,
      findBy: selectorType,
    },
    frameSelector,
    type: selectorType,
  });
  const { 1: actionType } = type.split('#');

  const elementActions = {
    exists: () => Boolean(element),
    notExists: () => !element,
    text: () => element?.innerText ?? null,
    visibleScreen: () => {
      if (!element) return false;

      return visibleInViewport(element);
    },
    visible: () => {
      if (!element) return false;

      const { visibility, display } = getComputedStyle(element);
      return (
        visibility !== 'hidden' &&
        visibility !== 'collapse' &&
        display !== 'none' &&
        element.getClientRects().length > 0
      );
    },
    invisible: () => {
      if (!element) return false;

      const { visibility, display } = getComputedStyle(element);
      const styleHidden =
        visibility === 'hidden' ||
        visibility === 'collapse' ||
        display === 'none';
      return styleHidden || element.getClientRects().length === 0;
    },
    attribute: ({ attrName }) => {
      if (!element || !element.hasAttribute(attrName)) return null;

      return element.getAttribute(attrName);
    },
  };

  return elementActions[actionType](data);
}

async function handleConditionCode({ data, refData }) {
  return new Promise((resolve, reject) => {
    const varName = `automa${nanoid()}`;
    // 每次执行使用独立事件名：避免同页并发条件节点互相接收回执
    const eventName = `__automa-condition-code__-${nanoid()}`;

    const scriptEl = document.createElement('script');
    scriptEl.textContent = `
      (async () => {
        const ${varName} = ${JSON.stringify(refData)};
        ${automaRefDataStr(varName)}
        try {
          ${data.code}
        } catch (error) {
          return {
            $isError: true,
            message: error.message,
          }
        }
      })()
        .then((detail) => {
          window.dispatchEvent(new CustomEvent('${eventName}', { detail }));
        });
    `;

    document.body.appendChild(scriptEl);

    const handleAutomaEvent = ({ detail }) => {
      scriptEl.remove();
      window.removeEventListener(eventName, handleAutomaEvent);

      // detail 判空：空值/无返回解析为“不匹配”（null），Promise 正常结束
      if (detail && detail.$isError) {
        reject(new Error(detail.message));
        return;
      }

      resolve(detail ?? null);
    };

    window.addEventListener(eventName, handleAutomaEvent);
  });
}

export default async function (data) {
  let result = null;

  if (data.type.startsWith('element')) {
    result = await handleConditionElement(data);
  } else if (data.type.startsWith('code')) {
    result = await handleConditionCode(data);
  }

  return result;
}
