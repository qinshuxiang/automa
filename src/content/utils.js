export function simulateClickElement(element) {
  const eventOpts = { bubbles: true, view: window };

  element.dispatchEvent(new MouseEvent('mousedown', eventOpts));
  element.dispatchEvent(new MouseEvent('mouseup', eventOpts));

  if (element.click) {
    element.click();
  } else {
    element.dispatchEvent(new PointerEvent('click', { bubbles: true }));
  }

  element.focus?.();
}

export function generateLoopSelectors(
  elements,
  { max, attrId, frameSelector, reverseLoop, startIndex = 0 }
) {
  const selectors = [];
  let elementsList = elements;

  if (reverseLoop) {
    elementsList = Array.from(elements).reverse();
  }

  elementsList.forEach((el, index) => {
    if (max > 0 && selectors.length >= max) return;

    const attrName = 'automa-loop';
    const attrValue = `${attrId}--${(startIndex || 0) + index}`;

    el.setAttribute(attrName, attrValue);
    selectors.push(`${frameSelector}[${attrName}="${attrValue}"]`);
  });

  return selectors;
}

export function elementSelectorInstance() {
  const rootElementExist = document.querySelector(
    '#app-container.automa-element-selector'
  );

  if (rootElementExist) {
    rootElementExist.style.display = 'block';
    window.dispatchEvent(new CustomEvent('automa:open-element-selector'));

    return true;
  }

  return false;
}

export function getElementRect(target, withAttributes) {
  if (!target) return {};

  const { x, y, height, width } = target.getBoundingClientRect();
  const result = {
    width: width + 4,
    height: height + 4,
    x: x - 2,
    y: y - 2,
  };

  if (withAttributes) {
    const attributes = {};

    Array.from(target.attributes).forEach(({ name, value }) => {
      if (name === 'automa-el-list') return;

      attributes[name] = value;
    });

    result.attributes = attributes;
    result.tagName = target.tagName;
  }

  return result;
}

export function getElementPath(el, root = el.ownerDocument.documentElement) {
  const path = [];
  let current = el;
  while (current && current !== root) {
    path.push(current);
    current = current.parentElement || current.getRootNode()?.host;
  }
  return path;
}

export function generateXPath(element) {
  if (!element || element.nodeType !== 1) return null;
  const literal = (value) => {
    if (!value.includes('"')) return `"${value}"`;
    if (!value.includes("'")) return `'${value}'`;
    return `concat(${value
      .split('"')
      .map((part) => `"${part}"`)
      .join(`, '"', `)})`;
  };
  if (
    element.id &&
    element.ownerDocument.getElementById(element.id) === element
  ) {
    return `//*[@id=${literal(element.id)}]`;
  }
  const parts = [];
  let current = element;
  while (current?.nodeType === 1) {
    let index = 1;
    let sibling = current.previousElementSibling;
    while (sibling) {
      if (sibling.tagName === current.tagName) index += 1;
      sibling = sibling.previousElementSibling;
    }
    parts.unshift(`${current.tagName}[${index}]`);
    current = current.parentNode;
  }
  if (current?.nodeType !== 9)
    throw new Error('Shadow DOM 元素请使用 CSS 选择器');
  return `/${parts.join('/')}`;
}

export function automaRefDataStr(varName) {
  return `
function findData(obj, path) {
  const paths = path.split('.');
  const isWhitespace = paths.length === 1 && !/\\S/.test(paths[0]);

  if (path.startsWith('$last') && Array.isArray(obj)) {
    paths[0] = obj.length - 1;
  }

  if (paths.length === 0 || isWhitespace) return obj;
  else if (paths.length === 1) return obj[paths[0]];

  let result = obj;

  for (let i = 0; i < paths.length; i++) {
    if (result[paths[i]] == undefined) {
      return undefined;
    } else {
      result = result[paths[i]];
    }
  }

  return result;
}
function automaRefData(keyword, path = '') {
  const data = ${varName}[keyword];

  if (!data) return;

  return findData(data, path);
}
  `;
}

function messageParentFrame(windowCtx, position) {
  return new Promise((resolve, reject) => {
    const messageId = `frame-${Date.now()}-${Math.random()}`;
    let timeout;
    const onMessage = ({ data, source }) => {
      if (
        source !== windowCtx.parent ||
        data?.type !== 'automa:frame-position' ||
        data.messageId !== messageId
      )
        return;
      clearTimeout(timeout);
      windowCtx.removeEventListener('message', onMessage);
      if (data.error) reject(new Error(data.error));
      else resolve(data.position);
    };
    timeout = setTimeout(() => {
      windowCtx.removeEventListener('message', onMessage);
      reject(new Error('无法获取父框架坐标，请检查框架权限'));
    }, 3000);
    windowCtx.addEventListener('message', onMessage);
    windowCtx.parent.postMessage(
      { type: 'automa:get-frame-position', messageId, position },
      '*'
    );
  });
}

// 将子视口坐标映射到父视口；边框和普通 CSS 缩放均按实际框架比例处理。
export function mapFramePoint(frame, point) {
  const rect = frame.getBoundingClientRect();
  const scaleX = frame.offsetWidth ? rect.width / frame.offsetWidth : 1;
  const scaleY = frame.offsetHeight ? rect.height / frame.offsetHeight : 1;
  return {
    x: rect.x + (point.x + (frame.clientLeft || 0)) * scaleX,
    y: rect.y + (point.y + (frame.clientTop || 0)) * scaleY,
  };
}

export async function getPointPosition(windowCtx, point) {
  let currentWindow = windowCtx;
  let position = { ...point };
  while (currentWindow !== currentWindow.top) {
    const frame = currentWindow.frameElement;
    if (!frame) return messageParentFrame(currentWindow, position);
    position = mapFramePoint(frame, position);
    currentWindow = frame.ownerDocument.defaultView;
  }
  return position;
}

export async function getElementPosition(element) {
  const { x, y, width, height } = element.getBoundingClientRect();
  return getPointPosition(element.ownerDocument.defaultView, {
    x: x + width / 2,
    y: y + height / 2,
  });
}
