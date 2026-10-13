import browser from 'webextension-polyfill';
import { MessageListener } from '@/utils/message';
import { sleep } from '@/utils/helper';
import getFile, { readFileAsBase64 } from '@/utils/getFile';
import automa from '@business';
import { workflowState } from '@/workflowEngine';
import { doBackup, doRestore } from '@/utils/backupRestore';
import {
  initBackup,
  configureBackup,
  rebuildAfterRestore,
  hasSessionPassword,
  clearSessionPassword,
} from './backupService';
import { registerWorkflowTrigger } from '../utils/workflowTrigger';
import BackgroundUtils from './BackgroundUtils';
import BackgroundWorkflowUtils from './BackgroundWorkflowUtils';
import BackgroundEventsListeners from './BackgroundEventsListeners';

const isFirefox = BROWSER_TYPE === 'firefox';

// 启动初始化：后台立即解除恢复门禁（不做恒定阻塞），再检查未完成的恢复日志
// 并续做定时备份初始化（含重启锁定）；详尽逻辑见 ./backupService
initBackup().catch(console.error);

browser.alarms.onAlarm.addListener(BackgroundEventsListeners.onAlarms);

browser.commands.onCommand.addListener(BackgroundEventsListeners.onCommand);

(browser.action || browser.browserAction).onClicked.addListener(
  BackgroundEventsListeners.onActionClicked
);

browser.runtime.onStartup.addListener(
  BackgroundEventsListeners.onRuntimeStartup
);
browser.runtime.onInstalled.addListener(
  BackgroundEventsListeners.onRuntimeInstalled
);

browser.webNavigation.onCompleted.addListener(
  BackgroundEventsListeners.onWebNavigationCompleted
);
browser.webNavigation.onHistoryStateUpdated.addListener(
  BackgroundEventsListeners.onHistoryStateUpdated
);

const contextMenu = isFirefox ? browser.menus : browser.contextMenus;
if (contextMenu && contextMenu.onClicked) {
  contextMenu.onClicked.addListener(
    BackgroundEventsListeners.onContextMenuClicked
  );
}

if (browser.notifications && browser.notifications.onClicked) {
  browser.notifications.onClicked.addListener(
    BackgroundEventsListeners.onNotificationClicked
  );
}

const message = new MessageListener('background');

message.on('fetch', async ({ type, resource }) => {
  const response = await fetch(resource.url, resource);
  if (!response.ok) throw new Error(response.statusText);

  let result = null;

  if (type === 'base64') {
    const blob = await response.blob();
    const base64 = await readFileAsBase64(blob);

    result = base64;
  } else {
    result = await response[type]();
  }

  return result;
});
message.on('fetch:text', (url) => {
  return fetch(url).then((response) => response.text());
});

message.on('open:dashboard', (url) => BackgroundUtils.openDashboard(url));
message.on('set:active-tab', (tabId) => {
  return browser.tabs.update(tabId, { active: true });
});

message.on('debugger:send-command', ({ tabId, method, params }) => {
  return new Promise((resolve) => {
    chrome.debugger.sendCommand({ tabId }, method, params, resolve);
  });
});
message.on('debugger:type', ({ tabId, commands, delay }) => {
  return new Promise((resolve) => {
    let index = 0;
    async function executeCommands() {
      const command = commands[index];
      if (!command) {
        resolve();
        return;
      }

      chrome.debugger.sendCommand(
        { tabId },
        'Input.dispatchKeyEvent',
        command,
        async () => {
          if (delay > 0) await sleep(delay);

          index += 1;
          executeCommands();
        }
      );
    }
    executeCommands();
  });
});

message.on('get:sender', (_, sender) => sender);
message.on('get:file', (path) => getFile(path));
message.on('get:tab-screenshot', (options, sender) =>
  browser.tabs.captureVisibleTab(sender.tab.windowId, options)
);

message.on('dashboard:refresh-packages', async () => {
  const tabs = await browser.tabs.query({
    url: browser.runtime.getURL('/newtab.html'),
  });

  tabs.forEach((tab) => {
    browser.tabs.sendMessage(tab.id, {
      type: 'refresh-packages',
    });
  });
});

message.on('workflow:stop', (stateId) => workflowState.stop(stateId));
message.on('workflow:execute', async (workflowData, sender) => {
  const context = workflowData.settings.execContext;
  const isMV2 = browser.runtime.getManifest().manifest_version === 2;
  if (!isMV2 && (!context || context === 'popup')) {
    await BackgroundUtils.openDashboard('?fromBackground=true', false);
    await BackgroundUtils.sendMessageToDashboard('workflow:execute', {
      data: workflowData,
      options: workflowData.option,
    });
    return;
  }

  if (workflowData.includeTabId) {
    if (!workflowData.options) workflowData.options = {};

    workflowData.options.tabId = sender.tab.id;
  }

  BackgroundWorkflowUtils.executeWorkflow(
    workflowData,
    workflowData?.options || {}
  );
});
message.on(
  'workflow:added',
  ({ workflowId, teamId, workflowData, source = 'community' }) => {
    let path = `/workflows/${workflowId}`;

    if (source === 'team') {
      if (!teamId) return;
      path = `/teams/${teamId}/workflows/${workflowId}`;
    }

    browser.tabs
      .query({ url: browser.runtime.getURL('/newtab.html') })
      .then((tabs) => {
        if (tabs.length >= 1) {
          const lastTab = tabs.at(-1);

          tabs.forEach((tab) => {
            browser.tabs.sendMessage(tab.id, {
              data: { workflowId, teamId, source, workflowData },
              type: 'workflow:added',
            });
          });

          browser.tabs.update(lastTab.id, {
            active: true,
          });
          browser.windows.update(lastTab.windowId, { focused: true });
        } else {
          BackgroundUtils.openDashboard(`${path}?permission=true`);
        }
      });
  }
);
message.on('workflow:register', ({ triggerBlock, workflowId }) => {
  registerWorkflowTrigger(workflowId, triggerBlock);
});
message.on('recording:stop', async () => {
  try {
    await BackgroundUtils.openDashboard('', false);
    await BackgroundUtils.sendMessageToDashboard('recording:stop');
  } catch (error) {
    console.error(error);
  }
});
message.on('workflow:resume', ({ id, nextBlock }) => {
  if (!id) return;
  workflowState.resume(id, nextBlock);
});
message.on('workflow:breakpoint', (id) => {
  if (!id) return;
  workflowState.update(id, { status: 'breakpoint' });
});

message.on('backup:status', async () => {
  await initBackup();

  const { localBackupSettings = {} } = await browser.storage.local.get(
    'localBackupSettings'
  );

  return { ...localBackupSettings, unlocked: hasSessionPassword() };
});
message.on('backup:create', async ({ password = '' }) => {
  await initBackup();

  return doBackup(password);
});
message.on('backup:configure', configureBackup);
message.on('backup:restore', async (restoreOptions) => {
  await initBackup();

  const result = await doRestore(restoreOptions, {
    rebuild: rebuildAfterRestore,
    assertIdle: async () => {
      const hasRunningWorkflows =
        workflowState.states.size > 0 ||
        [...workflowState.states.values()].some(
          (state) => state.pendingExecutions > 0
        );
      if (hasRunningWorkflows) {
        throw new Error('请先停止全部正在运行的工作流，再恢复备份');
      }
    },
  });
  clearSessionPassword();

  return result;
});

automa('background', message);

browser.runtime.onMessage.addListener(message.listener());

/* eslint-disable no-use-before-define */

const isMV2 = browser.runtime.getManifest().manifest_version === 2;
let lifeline;
async function keepAlive() {
  if (lifeline) return;
  for (const tab of await browser.tabs.query({ url: '*://*/*' })) {
    try {
      await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => chrome.runtime.connect({ name: 'keepAlive' }),
      });
      browser.tabs.onUpdated.removeListener(retryOnTabUpdate);
      return;
    } catch (e) {
      // Do nothing
    }
  }
  browser.tabs.onUpdated.addListener(retryOnTabUpdate);
}
async function retryOnTabUpdate(tabId, info) {
  if (info.url && /^(file|https?):/.test(info.url)) {
    keepAlive();
  }
}
function keepAliveForced() {
  lifeline?.disconnect();
  lifeline = null;
  keepAlive();
}

if (!isMV2) {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name === 'keepAlive') {
      lifeline = port;
      /* eslint-disable-next-line */
      console.log('Stayin alive: ', new Date());
      setTimeout(keepAliveForced, 295e3);
      port.onDisconnect.addListener(keepAliveForced);
    }
  });

  keepAlive();
} else if (!isFirefox) {
  const sandboxIframe = document.createElement('iframe');
  sandboxIframe.src = '/sandbox.html';
  sandboxIframe.id = 'sandbox';

  document.body.appendChild(sandboxIframe);

  window.addEventListener('message', async ({ data, source }) => {
    // 只接受沙箱 iframe 自身发来的消息，扩展页/内容脚本伪造的来源一律拒绝
    if (source !== sandboxIframe.contentWindow || data?.type !== 'automa-fetch')
      return;

    const sendResponse = (result) => {
      sandboxIframe.contentWindow.postMessage(
        {
          type: 'fetchResponse',
          data: result,
          id: data.data.id,
        },
        '*'
      );
    };

    const { type, resource } = data.data;
    try {
      const response = await fetch(resource.url, resource);
      if (!response.ok) throw new Error(response.statusText);

      let result = null;

      if (type === 'base64') {
        const blob = await response.blob();
        const base64 = await readFileAsBase64(blob);

        result = base64;
      } else {
        result = await response[type]();
      }
      sendResponse({ isError: false, result });
    } catch (error) {
      sendResponse({ isError: true, result: error.message });
    }
  });
}
