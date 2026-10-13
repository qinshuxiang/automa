import handleSelector, { markElement } from '../handleSelector';

async function link(block) {
  const element = await handleSelector(block, { returnElement: true });

  if (!element) {
    throw new Error('element-not-found');
  }
  if (element.tagName !== 'A') {
    throw new Error('此元素不是链接');
  }

  markElement(element, block);

  const url = element.href;
  if (url && !block.data.openInNewTab) window.open(url, '_self');

  return url;
}

export default link;
