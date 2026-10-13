<template>
  <div class="space-y-6 pb-8">
    <ui-card>
      <h2 class="text-xl font-semibold">完整本地备份与恢复</h2>
      <p class="mt-3">
        备份包含工作流（含受保护工作流）、文件夹、组件包、设置、快捷键、表格结构及全部行数据、变量和凭据。运行日志与临时执行状态不包含在内。
      </p>
      <p class="mt-2">
        含凭据或受保护工作流时，必须设置密码，整个备份文件都会加密。密码不会写入文件，请妥善保管。
      </p>
      <ui-input
        v-model="password"
        type="password"
        label="备份／恢复密码"
        autocomplete="new-password"
        class="mt-4 w-full"
        placeholder="无敏感数据时可留空；输入密码后整包加密"
      />
      <div class="mt-4 flex gap-3">
        <ui-button variant="accent" :loading="loading" @click="createBackup">
          下载完整备份
        </ui-button>
        <ui-button :loading="loading" @click="restoreBackup">
          选择文件并恢复
        </ui-button>
      </div>
      <ui-checkbox v-model="overwrite" class="mt-4">
        覆盖现有同 ID 数据（默认保留现有数据）
      </ui-checkbox>
      <p class="mt-3 text-sm">
        恢复前会检查密码、文件格式和关联关系，并保存恢复前快照。恢复失败时自动回滚；请先停止运行中的工作流。支持旧版导出，但旧文件未保存的表格行数据无法补回。
      </p>
      <p v-if="statusMessage" role="status" class="mt-4 whitespace-pre-wrap">
        {{ statusMessage }}
      </p>
    </ui-card>
    <ui-card>
      <h2 class="text-xl font-semibold">定时完整备份</h2>
      <p class="mt-2">
        默认关闭。加密密码只保留在当前浏览器会话，重启后需要重新输入密码并启用。
      </p>
      <ui-select v-model="settings.schedule" class="mt-4 w-full">
        <option value="">关闭</option>
        <option value="0 8 * * *">每天 08:00</option>
        <option value="0 8 * * 0">每周日 08:00</option>
        <option value="custom">自定义 Cron</option>
      </ui-select>
      <ui-input
        v-if="settings.schedule === 'custom'"
        v-model="settings.customSchedule"
        label="Cron 表达式"
        class="mt-3 w-full"
      />
      <ui-input
        v-model="settings.folderName"
        label="下载目录内的备份文件夹"
        class="mt-3 w-full"
      />
      <ui-checkbox v-model="settings.encrypt" class="mt-3">
        加密定时备份（使用上方输入的会话密码）
      </ui-checkbox>
      <p v-if="settings.requiresUnlock" class="mt-3 text-red-500">
        {{ settings.lastError || '定时备份已锁定，请重新输入密码并启用。' }}
      </p>
      <p v-if="settings.lastBackup" class="mt-3">
        最近备份：{{
          dayjs(settings.lastBackup).format('YYYY年MM月DD日 HH:mm')
        }}
      </p>
      <ui-button class="mt-4" :loading="loading" @click="configureBackup">
        保存定时备份设置
      </ui-button>
    </ui-card>
  </div>
</template>
<script setup>
import { reactive, ref, onMounted } from 'vue';
import dayjs from 'dayjs';
import browser from 'webextension-polyfill';
import { sendMessage } from '@/utils/message';
import { openFilePicker } from '@/utils/helper';

// 完整本地备份与恢复（成品包 SettingsBackup 页面组件移植）
const password = ref('');
const overwrite = ref(false);
const loading = ref(false);
const statusMessage = ref('');
const settings = reactive({
  schedule: '',
  customSchedule: '',
  folderName: 'automa-backup',
  encrypt: false,
});

async function run(task) {
  if (loading.value) return;

  loading.value = true;
  statusMessage.value = '';

  try {
    await task();
  } catch (error) {
    statusMessage.value = `操作失败：${error.message}`;
  } finally {
    loading.value = false;
  }
}

function createBackup() {
  run(async () => {
    const backup = await sendMessage(
      'backup:create',
      { password: password.value },
      'background'
    );

    const blobUrl = URL.createObjectURL(
      new Blob([JSON.stringify(backup)], { type: 'application/json' })
    );
    const anchor = document.createElement('a');
    anchor.download = `automa-backup-${dayjs().format(
      'YYYY-MM-DD-HH-mm'
    )}.json`;
    anchor.href = blobUrl;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);

    statusMessage.value = '完整备份已生成。请保留文件和备份密码。';
  });
}

function restoreBackup() {
  run(async () => {
    const [file] = await openFilePicker('application/json');
    if (!file) return;

    const payload = JSON.parse(await file.text());
    const result = await sendMessage(
      'backup:restore',
      {
        payload,
        password: password.value,
        overwrite: overwrite.value,
      },
      'background'
    );

    password.value = '';
    statusMessage.value = `${result.message} 页面将在 3 秒后重新加载。`;
    setTimeout(() => window.location.reload(), 3000);
  });
}

function configureBackup() {
  run(async () => {
    if (settings.schedule) {
      const granted = await browser.permissions.request({
        permissions: ['downloads'],
      });
      if (!granted) throw new Error('未获得下载权限，无法启用定时备份');
    }

    Object.assign(
      settings,
      await sendMessage(
        'backup:configure',
        { settings: { ...settings }, password: password.value },
        'background'
      )
    );
    password.value = '';
    statusMessage.value = settings.schedule
      ? '定时备份已启用。加密密码只保留在本次会话。'
      : '定时备份已关闭。';
  });
}

onMounted(async () => {
  try {
    Object.assign(
      settings,
      await sendMessage('backup:status', {}, 'background')
    );
  } catch (error) {
    statusMessage.value = error.message;
  }
});
</script>
