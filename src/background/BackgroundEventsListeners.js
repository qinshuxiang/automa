import browser from 'webextension-polyfill';
import { initElementSelector } from '@/newtab/utils/elementSelector';
import {
  initBackup,
  isScheduledBackupAlarm,
  handleScheduledBackup,
} from './backupService';
import BackgroundUtils from './BackgroundUtils';
import BackgroundWorkflowTriggers from './BackgroundWorkflowTriggers';

class BackgroundEventsListeners {
  static onActionClicked() {
    BackgroundUtils.openDashboard();
  }

  static onCommand(name) {
    if (name === 'open-dashboard') {
      BackgroundUtils.openDashboard();
    } else if (name === 'element-picker') {
      initElementSelector();
    }
  }

  static onAlarms(event) {
    if (isScheduledBackupAlarm(event.name)) {
      handleScheduledBackup();
      return;
    }

    BackgroundWorkflowTriggers.scheduleWorkflow(event);
  }

  static onWebNavigationCompleted({ tabId, url, frameId }) {
    if (frameId > 0) return;

    BackgroundWorkflowTriggers.visitWebTriggers(tabId, url);
  }

  static onContextMenuClicked(event, tab) {
    BackgroundWorkflowTriggers.contextMenu(event, tab);
  }

  static async onNotificationClicked(notificationId) {
    if (notificationId.startsWith('logs')) {
      const { 1: logId } = notificationId.split(':');

      const [tab] = await browser.tabs.query({
        url: browser.runtime.getURL('/newtab.html'),
      });
      if (!tab) await BackgroundUtils.openDashboard('');

      await BackgroundUtils.sendMessageToDashboard('open-logs', { logId });
    }
  }

  static async onRuntimeStartup() {
    try {
      await initBackup();

      browser.storage.local.remove('workflowStates');
      (browser.action || browser.browserAction).setBadgeText({ text: '' });

      // 注册失败（如单个触发器数据畸形）必须被捕获：未处理的拒绝会让
      // 排在后方的定时触发器当日静默失效且无任何记录
      await BackgroundWorkflowTriggers.reRegisterTriggers(true);
    } catch (error) {
      console.error(error);
    }
  }

  static onHistoryStateUpdated({ frameId, url, tabId }) {
    if (frameId !== 0) return;

    BackgroundWorkflowTriggers.visitWebTriggers(tabId, url, true);
  }

  static async onRuntimeInstalled({ reason }) {
    try {
      if (reason === 'install') {
        const defaults = {
          logs: [],
          shortcuts: {},
          workflows: {},
          settings: { locale: 'zh' },
          collections: [],
          workflowState: {},
          isFirstTime: true,
          visitWebTriggers: [],
          localBackupSettings: {
            schedule: '',
            encrypt: false,
            folderName: 'automa-backup',
          },
        };
        const existing = await browser.storage.local.get(Object.keys(defaults));
        // 只补齐缺失的键，不覆盖已有数据（对齐成品包 onInstalled install 分支）
        await browser.storage.local.set(
          Object.fromEntries(
            Object.entries(defaults).filter(
              ([key]) => existing[key] === undefined
            )
          )
        );
        await browser.windows.create({
          type: 'popup',
          state: 'maximized',
          url: browser.runtime.getURL('newtab.html#/welcome'),
        });

        return;
      }

      if (reason === 'update') {
        await initBackup().catch(console.error);
        await BackgroundWorkflowTriggers.reRegisterTriggers();
      }
    } catch (error) {
      console.error(error);
    }
  }
}

export default BackgroundEventsListeners;
