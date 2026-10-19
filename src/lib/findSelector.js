import { finder as finderLib } from '@medv/finder';

const ariaAttrs = ['data-testid'];

export function finder(element, options = {}) {
  const root = element.getRootNode();
  if (root.host) {
    const rest = { ...options };
    delete rest.root;
    const inner = finderLib(element, { ...rest, root });
    return `${finder(root.host, rest)} >> ${inner}`;
  }
  return finderLib(element, { root: element.ownerDocument, ...options });
}

export default function (element, options = {}) {
  let selector = finder(element, {
    tagName: () => true,
    attr: (name, value) => name === 'id' || (ariaAttrs.includes(name) && value),
    ...options,
  });

  const tag = element.tagName.toLowerCase();
  if (!selector.startsWith(tag) && !selector.includes(' ')) {
    selector = `${tag}${selector}`;
  }

  return selector;
}
