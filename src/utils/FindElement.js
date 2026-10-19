import Sizzle from 'sizzle';
import { querySelectorAllDeep } from '@/lib/query-selector-shadow-dom';
import { splitSelectorPath } from './selectorPath';

// Add a custom "Sizzle" pseudo-class selector
// ":contains": element content will be selected as long as it contains text
// ":equal" : element content must be exactly the same as text to be selected
// Example: p.description:equal("cat")
Sizzle.selectors.pseudos.equal = Sizzle.selectors.createPseudo(function (text) {
  return function (elem) {
    const elemText = elem.textContent || elem.innerText || '';
    return elemText.trim() === text;
  };
});

const specialSelectors = [':contains', ':header', ':parent', ':equal'];
const specialSelectorsRegex = new RegExp(specialSelectors.join('|'));

class FindElement {
  static cssSelector(data, documentCtx = document) {
    const selector = data.selector.trim();
    const shadowParts = splitSelectorPath(selector, '>>');
    let elements;
    if (specialSelectorsRegex.test(selector)) {
      elements = Sizzle(selector, documentCtx);
    } else if (shadowParts.length > 1) {
      elements = querySelectorAllDeep(shadowParts.join(' '), documentCtx);
    } else {
      elements = documentCtx.querySelectorAll(selector);
    }
    const matches = Array.from(elements || []).filter(
      (element) =>
        (!data.markEl || !element.hasAttribute(data.blockIdAttr)) &&
        (!data.excludeLoop ||
          !element
            .getAttribute('automa-loop')
            ?.startsWith(`${data.excludeLoop}--`))
    );
    return data.multiple ? matches : matches[0] || null;
  }

  static xpath(data, documentCtx = document) {
    const resultType = data.multiple
      ? XPathResult.ORDERED_NODE_ITERATOR_TYPE
      : XPathResult.FIRST_ORDERED_NODE_TYPE;

    let result = null;
    const elements = documentCtx.evaluate(
      data.selector,
      documentCtx,
      null,
      resultType,
      null
    );

    if (data.multiple) {
      result = [];
      let element = elements.iterateNext();

      while (element) {
        result.push(element);

        element = elements.iterateNext();
      }
    } else {
      result = elements.singleNodeValue;
    }

    return result;
  }
}

export default FindElement;
