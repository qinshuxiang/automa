import browser from 'webextension-polyfill';
import dayjs from 'dayjs';
import { findTriggerBlock, parseJSON } from '@/utils/helper';
import {
  registerCronJob,
  registerSpecificDay,
  registerWorkflowTrigger,
} from '@/utils/workflowTrigger';
import BackgroundUtils from './BackgroundUtils';
import BackgroundWorkflowUtils from './BackgroundWorkflowUtils';

async function executeWorkflow(workflowData, options) {
  if (workflowData.isDisabled) return;

  const isMV2 = browser.runtime.getManifest().manifest_version === 2;
  const context = workflowData.settings.execContext;
  if (isMV2 || context === 'background') {
    BackgroundWorkflowUtils.executeWorkflow(workflowData, options);
    return;
  }

  await BackgroundUtils.openDashboard('?fromBackground=true', false);
  await BackgroundUtils.sendMessageToDashboard('workflow:execute', {
    data: workflowData,
    options,
  });
}

class BackgroundWorkflowTriggers {
  static async visitWebTriggers(tabId, tabUrl, spa = false) {
    const { visitWebTriggers } = await browser.storage.local.get(
      'visitWebTriggers'
    );
    if (!visitWebTriggers || visitWebTriggers.length === 0) return;

    const triggeredWorkflow = visitWebTriggers.find(
      ({ url, isRegex, supportSPA }) => {
        if (!url.trim() || (spa && !supportSPA)) return false;

        // 非正则 URL 用 includes 字面匹配，不再把普通字符串当正则；
        // 正则路径捕获无效正则的构造异常
        if (!isRegex) return tabUrl.includes(url.trim());

        try {
          return new RegExp(url, 'g').test(tabUrl);
        } catch (regexError) {
          return false;
        }
      }
    );

    if (triggeredWorkflow) {
      let workflowId = triggeredWorkflow.id;
      if (triggeredWorkflow.id.startsWith('trigger')) {
        const { 1: triggerWorkflowId } = triggeredWorkflow.id.split(':');
        workflowId = triggerWorkflowId;
      }

      const workflowData = await BackgroundWorkflowUtils.getWorkflow(
        workflowId
      );
      if (workflowData) executeWorkflow(workflowData, { tabId });
    }
  }

  static async scheduleWorkflow({ name }) {
    try {
      let workflowId = name;
      let triggerId = null;

      if (name.startsWith('trigger')) {
        const { 1: triggerWorkflowId, 2: triggerItemId } = name.split(':');
        triggerId = triggerItemId;
        workflowId = triggerWorkflowId;
      }

      const currentWorkflow = await BackgroundWorkflowUtils.getWorkflow(
        workflowId
      );
      if (!currentWorkflow) return;

      let data = currentWorkflow.trigger;
      if (!data) {
        const drawflow =
          typeof currentWorkflow.drawflow === 'string'
            ? parseJSON(currentWorkflow.drawflow, {})
            : currentWorkflow.drawflow;
        const { data: triggerBlockData } = findTriggerBlock(drawflow) || {};
        data = triggerBlockData;
      }

      if (triggerId) {
        data = data.triggers.find((trigger) => trigger.id === triggerId);
        if (data) data = { ...data, ...data.data };
      }

      if (data && data.type === 'interval' && data.fixedDelay) {
        const { workflowStates } = await browser.storage.local.get(
          'workflowStates'
        );
        const workflowState = (workflowStates || []).find(
          (item) => item.workflowId === workflowId
        );

        if (workflowState) {
          let { workflowQueue } = await browser.storage.local.get(
            'workflowQueue'
          );
          workflowQueue = workflowQueue || [];

          if (!workflowQueue.includes(workflowId)) {
            (workflowQueue = workflowQueue || []).push(workflowId);
            await browser.storage.local.set({ workflowQueue });
          }

          return;
        }
      } else if (data && data.type === 'date') {
        const [hour, minute, second] = data.time.split(':');
        const date = dayjs(data.date)
          .hour(hour)
          .minute(minute)
          .second(second || 0);

        const isAfter = dayjs(Date.now() - 60 * 1000).isAfter(date);
        if (isAfter) return;
      }

      executeWorkflow(currentWorkflow);

      if (!data) return;

      if (['specific-day', 'cron-job'].includes(data.type)) {
        if (data.type === 'specific-day') {
          registerSpecificDay(name, data);
        } else {
          registerCronJob(name, data);
        }
      }
    } catch (error) {
      console.error(error);
    }
  }

  static async contextMenu({ parentMenuItemId, menuItemId, frameId }, tab) {
    try {
      if (parentMenuItemId !== 'automaContextMenu') return;
      const message = await browser.tabs.sendMessage(
        tab.id,
        {
          type: 'context-element',
        },
        { frameId }
      );

      let workflowId = menuItemId;
      if (menuItemId.startsWith('trigger')) {
        const { 1: triggerWorkflowId } = menuItemId.split(':');
        workflowId = triggerWorkflowId;
      }

      const workflowData = await BackgroundWorkflowUtils.getWorkflow(
        workflowId
      );
      executeWorkflow(workflowData, {
        data: {
          variables: message,
        },
      });
    } catch (error) {
      console.error(error);
    }
  }

  static async reRegisterTriggers(isStartup = false) {
    const { workflows, workflowHosts, teamWorkflows } =
      await browser.storage.local.get([
        'workflows',
        'workflowHosts',
        'teamWorkflows',
      ]);
    const convertToArr = (value) =>
      Array.isArray(value) ? value : Object.values(value);

    const workflowsArr = convertToArr(workflows);

    if (workflowHosts) {
      workflowsArr.push(...convertToArr(workflowHosts));
    }
    if (teamWorkflows) {
      workflowsArr.push(
        ...BackgroundWorkflowUtils.flattenTeamWorkflows(teamWorkflows)
      );
    }

    for (const currWorkflow of workflowsArr) {
      // eslint-disable-next-line no-continue
      if (currWorkflow.isDisabled) continue;

      let triggerBlock = currWorkflow.trigger;

      if (!triggerBlock) {
        const flow =
          typeof currWorkflow.drawflow === 'string'
            ? parseJSON(currWorkflow.drawflow, {})
            : currWorkflow.drawflow;

        triggerBlock = findTriggerBlock(flow)?.data;
      }

      if (triggerBlock) {
        try {
          if (isStartup && triggerBlock.type === 'on-startup') {
            executeWorkflow(currWorkflow);
          } else {
            if (isStartup && triggerBlock.triggers) {
              for (const trigger of triggerBlock.triggers) {
                if (trigger.type === 'on-startup') {
                  await BackgroundWorkflowUtils.executeWorkflow(currWorkflow);
                }
              }
            }

            await registerWorkflowTrigger(currWorkflow.id, {
              data: triggerBlock,
            });
          }
        } catch (error) {
          // 单个工作流的触发器数据畸形不能中断其余工作流的注册，
          // 否则排在其后的定时触发器当日静默失效
          console.error(`注册工作流触发器失败（${currWorkflow.id}）:`, error);
        }
      }
    }
  }
}

export default BackgroundWorkflowTriggers;
