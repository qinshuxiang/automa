import handleFormElement from '@/utils/handleFormElement';
import { sendMessage } from '@/utils/message';
import handleSelector, { markElement } from '../handleSelector';
import synchronizedLock from '../synchronizedLock';

async function forms(block) {
  const { data } = block;
  const elements = await handleSelector(block, { returnElement: true });

  if (!elements) {
    throw new Error('element-not-found');
  }

  if (data.getValue) {
    let result = '';

    if (data.multiple) {
      result = Array.from(elements).map((element) => element.value || '');
    } else {
      result = elements.value || '';
    }

    return result;
  }

  async function typeText(element) {
    if (block.debugMode && data.type === 'text-field') {
      // get lock
      await synchronizedLock.getLock();
      element.focus?.();

      try {
        if (data.clearValue) {
          const backspaceCommands = new Array(element.value?.length ?? 0).fill({
            type: 'rawKeyDown',
            unmodifiedText: 'Delete',
            text: 'Delete',
            windowsVirtualKeyCode: 46,
          });

          await sendMessage(
            'debugger:type',
            { commands: backspaceCommands, tabId: block.activeTabId, delay: 0 },
            'background'
          );
        }

        const commands = data.value.split('').map((char) => ({
          type: 'keyDown',
          text: char === '\n' ? '\r' : char,
        }));
        const typeDelay = +block.data.delay;
        await sendMessage(
          'debugger:type',
          {
            commands,
            tabId: block.activeTabId,
            delay: Number.isNaN(typeDelay) ? 0 : typeDelay,
          },
          'background'
        );
      } finally {
        synchronizedLock.releaseLock();
      }
      return;
    }

    markElement(element, block);
    await handleFormElement(element, data);
  }

  if (data.multiple) {
    const promises = Array.from(elements).map((element) => typeText(element));

    // F03 修复：allSettled 的 rejected 必须检查并传播，
    // 否则全部写入失败时节点仍然报成功。与单元素路径保持一致，
    // 原样抛出首个失败原因，并在 error.data 上附带统计信息
    // （失败数/总数），便于定位第几个目标出错。
    // synchronizedLock 的释放由 typeText 内部 finally 保证，不受影响。
    const settledResults = await Promise.allSettled(promises);
    const firstFailure = settledResults.find(
      (result) => result.status === 'rejected'
    );

    if (firstFailure) {
      const failureCount = settledResults.filter(
        (result) => result.status === 'rejected'
      ).length;
      const error =
        firstFailure.reason instanceof Error
          ? firstFailure.reason
          : new Error(String(firstFailure.reason ?? '未知错误'));

      error.data = {
        ...(error.data || {}),
        failedCount: failureCount,
        totalCount: settledResults.length,
      };

      throw error;
    }
  } else {
    await typeText(elements);
  }

  return null;
}

export default forms;
