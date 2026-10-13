/* eslint-disable no-restricted-globals */
import browser from 'webextension-polyfill';
import cloneDeep from 'lodash.clonedeep';
import dayjs from '@/lib/dayjs';
import { parseJSON } from '@/utils/helper';
import { fetchApi } from '@/utils/api';
import { sendMessage } from '@/utils/message';
import convertWorkflowData from '@/utils/convertWorkflowData';
import getBlockMessage from '@/utils/getBlockMessage';
import decryptFlow, { getWorkflowPass } from '@/utils/decryptFlow';
import { isRestoreBlocked } from '@/utils/backupRestore';
import { validateWorkflowData } from '@/utils/workflowValidation';
import WorkflowState from './WorkflowState';
import WorkflowLogger from './WorkflowLogger';
import WorkflowEngine from './WorkflowEngine';
import blocksHandler from './blocksHandler';
import { workflowEventHandler } from './workflowEvent';

const workflowStateStorage = {
  get() {
    return browser.storage.local
      .get('workflowStates')
      .then(({ workflowStates }) => workflowStates || []);
  },
  set(key, value) {
    const states = Object.values(value);

    return browser.storage.local.set({ workflowStates: states });
  },
};

export const workflowLogger = new WorkflowLogger();
export const workflowState = new WorkflowState({
  storage: workflowStateStorage,
});

export function stopWorkflowExec(executionId) {
  workflowState.stop(executionId);
  sendMessage('workflow:stop', executionId, 'background');
}

export function startWorkflowExec(workflowData, options, isPopup = true) {
  // 本地数据恢复期间禁止执行工作流，避免读到恢复中的半成品数据
  if (isRestoreBlocked()) {
    throw new Error('正在恢复本地数据，暂时不能执行工作流');
  }

  if (workflowData?.isProtected) {
    const pass = getWorkflowPass(workflowData.pass);
    const decryptedFlow = decryptFlow(workflowData, pass);

    if (decryptedFlow?.isError) {
      throw new Error('受保护工作流解密失败，请确认原安装密钥');
    }

    workflowData = {
      ...workflowData,
      drawflow: parseJSON(decryptedFlow, decryptedFlow),
    };
  }

  validateWorkflowData(workflowData);

  if (self.localStorage) {
    const runCounts =
      parseJSON(self.localStorage.getItem('runCounts'), {}) || {};
    runCounts[workflowData.id] = (runCounts[workflowData.id] || 0) + 1;

    self.localStorage.setItem('runCounts', JSON.stringify(runCounts));
  }

  if (workflowData.testingMode) {
    for (const value of workflowState.states.values()) {
      if (value.workflowId === workflowData.id) return null;
    }
  }

  // 深拷贝（含 drawflow）后再交给引擎，避免运行中修改污染调用方数据
  const clonedWorkflowData = {};
  Object.keys(workflowData).forEach((key) => {
    clonedWorkflowData[key] = cloneDeep(workflowData[key]);
  });

  const convertedWorkflow = convertWorkflowData(clonedWorkflowData);
  const hasStartBlock = convertedWorkflow.drawflow?.nodes?.some((node) =>
    options?.blockId ? node.id === options.blockId : node.label === 'trigger'
  );
  if (!hasStartBlock) {
    throw new Error('工作流缺少有效的起始节点，无法执行');
  }

  const engine = new WorkflowEngine(convertedWorkflow, {
    options,
    isPopup,
    states: workflowState,
    logger: workflowLogger,
    blocksHandler: blocksHandler(),
  });

  workflowState.pendingExecutions = (workflowState.pendingExecutions || 0) + 1;
  engine.init().finally(() => {
    workflowState.pendingExecutions -= 1;
  });

  engine.on('destroyed', ({ id, status, history, blockDetail, ...rest }) => {
    // 手动停止（stopped）不算运行结束，不弹通知也不触发事件动作
    if (status !== 'stopped') {
      browser.permissions
        .contains({ permissions: ['notifications'] })
        .then((hasPermission) => {
          if (!hasPermission || !clonedWorkflowData.settings.notification)
            return;

          const name = clonedWorkflowData.name.slice(0, 32);

          browser.notifications.create(`logs:${id}`, {
            type: 'basic',
            iconUrl: browser.runtime.getURL('icon-128.png'),
            title: status === 'success' ? '运行成功' : '运行失败',
            message: `工作流“${name}”${
              status === 'success' ? '已完成' : '执行失败'
            }`,
          });
        });
    }

    if (convertedWorkflow.settings?.events) {
      const workflowHistory = history.map((item) => {
        delete item.logId;
        delete item.prevBlockData;
        delete item.workerId;

        item.description = item.description || '';

        return item;
      });
      const workflowRefData = {
        status,
        startedAt: rest.startedTimestamp,
        endedAt: rest.endedTimestamp
          ? rest.endedTimestamp - rest.startedTimestamp
          : null,
        logs: workflowHistory,
        errorMessage: status === 'error' ? getBlockMessage(blockDetail) : null,
      };

      convertedWorkflow.settings.events.forEach((event) => {
        // stopped 等状态没有对应的结束事件，直接跳过
        const eventName = {
          success: 'finish:success',
          error: 'finish:failed',
        }[status];
        if (!eventName || !event.events.includes(eventName)) return;

        workflowEventHandler(event.action, {
          workflow: workflowRefData,
          variables: { ...engine.referenceData.variables },
        });
      });
    }
  });

  browser.storage.local.get('checkStatus').then(({ checkStatus }) => {
    const isSameDay = dayjs().isSame(checkStatus, 'day');
    if (!isSameDay || !checkStatus) {
      fetchApi('/status')
        .then((response) => response.json())
        .then(() => {
          browser.storage.local.set({ checkStatus: new Date().toString() });
        });
    }
  });

  return engine;
}

export function executeWorkflow(workflowData, options) {
  if (!workflowData || workflowData.isDisabled) return;

  const isMV2 = browser.runtime.getManifest().manifest_version === 2;
  const context = workflowData?.settings?.execContext;

  if (isMV2 || context === 'background') {
    sendMessage('workflow:execute', { ...workflowData, options }, 'background');
    return;
  }

  if (window) window.fromBackground = false;

  browser.tabs
    .query({ active: true, currentWindow: true })
    .then(async ([tab]) => {
      if (tab && tab.url.includes(browser.runtime.getURL(''))) {
        await browser.windows.update(tab.windowId, { focused: false });
      }

      startWorkflowExec(workflowData, options);
    });
}
