<template>
  <template v-if="retrieved">
    <app-sidebar v-if="$route.name !== 'recording'" />
    <main :class="{ 'pl-16': $route.name !== 'recording' }">
      <router-view />
    </main>
    <app-logs />
    <ui-dialog />
    <shared-permissions-modal
      v-model="permissionState.showModal"
      :permissions="permissionState.items"
    />
    <div
      class="pointer-events-none fixed bottom-3 right-4 z-50 select-none rounded-full bg-black/60 px-3 py-1 text-xs text-white"
    >
      V2.1.1 觋溟
    </div>
  </template>
  <div v-else class="py-8 text-center">
    <ui-spinner color="text-accent" size="28" />
  </div>
</template>
<script setup>
import { ref, reactive, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter, useRoute } from 'vue-router';
import { useHead } from '@vueuse/head';
import browser from 'webextension-polyfill';
import { useStore } from '@/stores/main';
import { useFolderStore } from '@/stores/folder';
import { usePackageStore } from '@/stores/package';
import { useWorkflowStore } from '@/stores/workflow';
import { useTheme } from '@/composable/theme';
import { loadLocaleMessages, setI18nLanguage } from '@/lib/vueI18n';
import { getWorkflowPermissions } from '@/utils/workflowData';
import { sendMessage } from '@/utils/message';
import { workflowState, startWorkflowExec } from '@/workflowEngine';
import emitter from '@/lib/mitt';
import dbLogs from '@/db/logs';
import dayjs from '@/lib/dayjs';
import AppLogs from '@/components/newtab/app/AppLogs.vue';
import AppSidebar from '@/components/newtab/app/AppSidebar.vue';
import dataMigration from '@/utils/dataMigration';
import iconFirefox from '@/assets/svg/logoFirefox.svg';
import iconChrome from '@/assets/svg/logo.svg';
import SharedPermissionsModal from '@/components/newtab/shared/SharedPermissionsModal.vue';

const iconElement = document.createElement('link');
iconElement.rel = 'icon';
iconElement.href =
  window.location.protocol === 'moz-extension' ? iconFirefox : iconChrome;
document.head.appendChild(iconElement);

window.fromBackground = window.location.href.includes('?fromBackground=true');

const { t } = useI18n();
const route = useRoute();
const store = useStore();
const theme = useTheme();
const router = useRouter();
const folderStore = useFolderStore();
const packageStore = usePackageStore();
const workflowStore = useWorkflowStore();

theme.init();

const retrieved = ref(false);
const permissionState = reactive({
  permissions: [],
  showModal: false,
});

const currentVersion = browser.runtime.getManifest().version;

function stopRecording() {
  if (!window.stopRecording) return;

  window.stopRecording();
}

const messageEvents = {
  'refresh-packages': function () {
    packageStore.loadData(true);
  },
  'open-logs': function (data) {
    emitter.emit('ui:logs', {
      show: true,
      logId: data.logId,
    });
  },
  'workflow:added': function (data) {
    if (!data.workflowData) return;

    workflowStore
      .insert(data.workflowData, { duplicateId: true })
      .then(async () => {
        try {
          const permissions = await getWorkflowPermissions(data.workflowData);
          if (permissions.length === 0) return;

          permissionState.items = permissions;
          permissionState.showModal = true;
        } catch (error) {
          console.error(error);
        }
      })
      .catch((error) => {
        console.error(error);
      });
  },
  'workflow:execute': function ({ data, options }) {
    if (!data || data.isDisabled) return;

    startWorkflowExec(data, options ?? data?.options ?? {});
  },
  'recording:stop': stopRecording,
  'background--recording:stop': stopRecording,
};

browser.runtime.onMessage.addListener(({ type, data }) => {
  if (!type) return;

  if (messageEvents[type]) {
    messageEvents[type](data);
  } else {
    console.warn(`未注册的页面消息类型：${type}`);
  }
});

browser.storage.local.onChanged.addListener(({ workflowStates }) => {
  if (!workflowStates) return;
  const states = Object.values(workflowStates.newValue);
  workflowStore.states = states;
});

useHead(() => {
  const runningWorkflows = workflowStore.popupStates.length;

  return {
    title: '工作流管理',
    titleTemplate:
      runningWorkflows > 0
        ? `%s (${runningWorkflows} 个工作流运行中) - 自动化工具`
        : '%s - 自动化工具',
  };
});

/* eslint-disable-next-line */
window.onbeforeunload = () => {
  const runningWorkflows = workflowStore.popupStates.length;
  if (window.isDataChanged || runningWorkflows > 0) {
    return t('message.notSaved');
  }
};
window.addEventListener('message', ({ data, source }) => {
  // 仅接受来自沙箱 iframe 的 fetch 代理请求
  if (source !== document.getElementById('sandbox')?.contentWindow) return;
  if (data?.type !== 'automa-fetch') return;

  const sendResponse = (result) => {
    document.getElementById('sandbox').contentWindow.postMessage(
      {
        type: 'fetchResponse',
        data: result,
        id: data.data.id,
      },
      '*'
    );
  };

  sendMessage('fetch', data.data, 'background')
    .then((result) => {
      sendResponse({ isError: false, result });
    })
    .catch((error) => {
      sendResponse({ isError: true, result: error.message });
    });
});

watch(
  () => workflowStore.popupStates,
  () => {
    if (
      !window.fromBackground ||
      workflowStore.popupStates.length !== 0 ||
      route.name !== 'workflows'
    )
      return;

    window.close();
  }
);

/* eslint-disable-next-line */
function autoDeleteLogs() {
  const deleteAfter = store.settings.deleteLogAfter;
  if (deleteAfter === 'never') return;

  const lastCheck =
    +localStorage.getItem('checkDeleteLogs') || Date.now() - 8.64e7;
  const dayDiff = dayjs().diff(dayjs(lastCheck), 'day');

  if (dayDiff < 1) return;

  const aDayInMs = 8.64e7;
  const maxLogAge = Date.now() - aDayInMs * deleteAfter;

  dbLogs.items
    .where('endedAt')
    .below(maxLogAge)
    .toArray()
    .then((values) => {
      const ids = values.map(({ id }) => id);

      dbLogs.items.bulkDelete(ids);
      dbLogs.ctxData.where('logId').anyOf(ids).delete();
      dbLogs.logsData.where('logId').anyOf(ids).delete();
      dbLogs.histories.where('logId').anyOf(ids).delete();

      localStorage.setItem('checkDeleteLogs', Date.now());
    });
}

(async () => {
  try {
    workflowState.storage = {
      get() {
        return workflowStore.popupStates;
      },
      set(key, value) {
        workflowStore.popupStates = Object.values(value);
      },
    };

    const { workflowStates } = await browser.storage.local.get(
      'workflowStates'
    );
    workflowStore.states = Object.values(workflowStates || {});

    const tabs = await browser.tabs.query({
      url: browser.runtime.getURL('/newtab.html'),
    });

    const currentWindow = await browser.windows.getCurrent();
    if (currentWindow.type !== 'popup') {
      await browser.tabs.remove([tabs[0].id]);
      return;
    }

    if (tabs.length > 1) {
      const firstTab = tabs.shift();
      await browser.windows.update(firstTab.windowId, { focused: true });
      await browser.tabs.update(firstTab.id, { active: true });

      await browser.tabs.remove(tabs.map((tab) => tab.id));
      return;
    }

    await Promise.allSettled([
      folderStore.load(),
      store.loadSettings(),
      workflowStore.loadData(),
      packageStore.loadData(),
    ]);

    await loadLocaleMessages(store.settings.locale, 'newtab');
    await setI18nLanguage(store.settings.locale);

    await dataMigration();

    retrieved.value = true;

    const { isRecording } = await browser.storage.local.get('isRecording');
    if (isRecording) {
      router.push('/recording');

      await (browser.action || browser.browserAction).setBadgeBackgroundColor({
        color: '#ef4444',
      });
      await (browser.action || browser.browserAction).setBadgeText({
        text: 'rec',
      });
    }

    autoDeleteLogs();
  } catch (error) {
    retrieved.value = true;
    console.error(error);
  }

  localStorage.setItem('ext-version', currentVersion);
})();
</script>
<style>
html,
body {
  @apply bg-gray-50 dark:bg-gray-900 text-black dark:text-gray-100;
}

body {
  min-height: 100vh;
}

#app {
  height: 100%;
}

h1,
h2,
h3 {
  @apply dark:text-white;
}
</style>
