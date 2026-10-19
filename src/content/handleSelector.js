import { splitSelectorPath } from '@/utils/selectorPath';
import FindElement from '@/utils/FindElement';
import { visibleInViewport, isXPath } from '@/utils/helper';
import { checkExecutionSignal } from './executionSignal';

/* eslint-disable consistent-return */

export function markElement(el, { id, data }) {
  if (data.markEl) {
    el.setAttribute(`block--${id}`, '');
  }
}

export function getDocumentCtx(frameSelector) {
  if (!frameSelector) return document;

  let documentCtx = document;

  const iframeSelectors = splitSelectorPath(frameSelector, '|>');
  iframeSelectors.forEach((selector) => {
    if (!documentCtx) return;

    const type = isXPath(selector) ? 'xpath' : 'cssSelector';
    const element = FindElement[type]({ selector }, documentCtx);
    documentCtx = element?.contentDocument;
  });

  return documentCtx;
}

export function queryElements(data, signal, documentCtx = document) {
  return new Promise((resolve, reject) => {
    let waitTimeout = null;
    let retryTimeout = null;
    let settled = false;

    function onAbort() {
      try {
        checkExecutionSignal(signal);
      } catch (error) {
        // eslint-disable-next-line no-use-before-define
        settle(reject, error);
      }
    }

    function settle(settleFn, value) {
      if (settled) return;

      settled = true;
      clearTimeout(waitTimeout);
      clearTimeout(retryTimeout);
      signal?.removeEventListener('abort', onAbort);
      settleFn(value);
    }

    const findSelector = () => {
      if (settled) return;

      try {
        checkExecutionSignal(signal);

        const selectorType = data.findBy || 'cssSelector';
        const elements = FindElement[selectorType](data, documentCtx);
        const isElNotFound = !elements || elements.length === 0;

        if (!isElNotFound || !data.waitForSelector) {
          settle(resolve, elements);
        } else {
          retryTimeout = setTimeout(findSelector, 200);
        }
      } catch (error) {
        settle(reject, error);
      }
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    if (data.waitForSelector) {
      waitTimeout = setTimeout(
        () => settle(resolve, null),
        data.waitSelectorTimeout
      );
    }

    findSelector();
  });
}

export default async function (
  { data, id, frameSelector, debugMode, signal },
  { onSelected, onError, onSuccess, withDocument } = {}
) {
  if (!data || !data.selector) {
    if (onError) onError(new Error('selector-empty'));
    return null;
  }

  try {
    const documentCtx = getDocumentCtx(frameSelector);
    if (!documentCtx) {
      if (onError) onError(new Error('iframe-not-found'));
      return null;
    }

    data.blockIdAttr = `block--${id}`;

    const elements = await queryElements(data, signal, documentCtx);

    if (!elements || elements.length === 0) {
      if (onError) onError(new Error('element-not-found'));

      return null;
    }

    const elementsArr = data.multiple ? Array.from(elements) : [elements];

    const actionResults = await Promise.allSettled(
      elementsArr.map(async (el) => {
        checkExecutionSignal(signal);
        markElement(el, { id, data });

        if (debugMode) {
          const isInViewport = visibleInViewport(el);
          if (!isInViewport) el.scrollIntoView();
        }

        if (onSelected) await onSelected(el);
      })
    );

    // 选择器吞错修复：allSettled 的 rejected 必须抛出，
    // 点击/输入失败不再被静默处理成成功
    const failedResult = actionResults.find(
      (result) => result.status === 'rejected'
    );
    if (failedResult) throw failedResult.reason;

    checkExecutionSignal(signal);
    if (onSuccess) onSuccess();
    if (withDocument) {
      return {
        elements,
        document: documentCtx,
      };
    }

    return elements;
  } catch (error) {
    if (onError) onError(error);
    if (!onError) throw error;
  }
}
