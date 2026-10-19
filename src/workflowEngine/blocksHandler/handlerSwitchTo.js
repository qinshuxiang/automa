import { sleep } from '@/utils/helper';
import { getFrames } from '../helper';

async function switchTo(block) {
  const nextBlockId = this.getBlockConnections(block.id);

  try {
    if (block.data.windowType === 'main-window') {
      this.activeTab.frameId = 0;

      delete this.frameSelector;

      return {
        data: '',
        nextBlockId,
      };
    }

    const { url, isSameOrigin } = await this._sendMessageToTab(
      { ...block, frameSelector: '' },
      {
        frameId: 0,
      }
    );

    if (isSameOrigin) {
      this.activeTab.frameId = 0;
      this.frameSelector = block.data.selector;

      return {
        data: block.data.selector,
        nextBlockId,
      };
    }

    const frames = await getFrames(this.activeTab.id);

    let frameId = frames[url];
    if (!Number.isInteger(frameId) || frameId <= 0) {
      // 只允许同源且路径一致的唯一重定向候选，避免选到其他网站的同名路径。
      const matches = Object.entries(frames).filter(([frameURL, id]) => {
        try {
          const requested = new URL(url);
          const candidate = new URL(frameURL);
          return (
            Number.isInteger(id) &&
            id > 0 &&
            requested.origin === candidate.origin &&
            requested.pathname === candidate.pathname
          );
        } catch {
          return false;
        }
      });
      frameId = matches.length === 1 ? matches[0][1] : null;
    }

    if (Number.isInteger(frameId) && frameId > 0) {
      await sleep(1000);
      this.activeTab.frameId = frameId;
      delete this.frameSelector;
      return { nextBlockId, data: frameId };
    }

    throw new Error('no-iframe-id');
  } catch (error) {
    error.data = { selector: block.data.selector };
    error.nextBlockId = nextBlockId;

    throw error;
  }
}

export default switchTo;
