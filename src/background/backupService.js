import browser from 'webextension-polyfill';
import cronParser from 'cron-parser';
import {
  markRestoreGateReady,
  checkRestoreJournal,
  restoreFromJournal,
  doBackup,
} from '@/utils/backupRestore';
import BackgroundWorkflowTriggers from './BackgroundWorkflowTriggers';

/**
 * 后台备份服务（成品包 background 入口内联逻辑移植）
 *
 * - initBackup：门禁就绪 + 未完成恢复快照续恢复 + 定时备份重启锁定；
 * - configureBackup：backup:configure 处理（文件夹校验、权限、会话密码）；
 * - handleScheduledBackup：schedule-local-backup 闹钟处理；
 * - rebuildAfterRestore：恢复完成后重建触发器/快捷键/闹钟。
 */

const SCHEDULE_BACKUP_ALARM = 'schedule-local-backup';

// 会话内定时备份密码（不落盘，浏览器重启后需重新输入）
let sessionPassword = '';
let initPromise = null;

/**
 * 恢复完成后的重建（成品包 S）：
 * 清除工作流闹钟与上下文菜单，重置触发器存储并重新注册，合并备份快捷键。
 * @param {{ storage?: { shortcuts?: object } }} state 恢复写入的状态快照
 */
export async function rebuildAfterRestore(state) {
  const alarms = await browser.alarms.getAll();
  for (const alarm of alarms) {
    if (alarm.name !== SCHEDULE_BACKUP_ALARM) {
      await browser.alarms.clear(alarm.name);
    }
  }

  const menus = browser.contextMenus || browser.menus;
  if (menus) {
    const hasPermission = await browser.permissions.contains({
      permissions: ['contextMenus'],
    });
    if (hasPermission) await menus.removeAll();
  }

  await browser.storage.local.set({
    visitWebTriggers: [],
    onStartupTriggers: [],
    shortcuts: {},
    workflowQueue: [],
  });
  await BackgroundWorkflowTriggers.reRegisterTriggers(false);

  const { shortcuts } = await browser.storage.local.get('shortcuts');
  await browser.storage.local.set({
    shortcuts: { ...state.storage.shortcuts, ...shortcuts },
  });

  await browser.alarms.clear(SCHEDULE_BACKUP_ALARM);
}

/** 计算下一次定时备份时间并注册闹钟（成品包 A） */
async function scheduleBackupAlarm(settings) {
  await browser.alarms.clear(SCHEDULE_BACKUP_ALARM);
  if (!settings.schedule) return;

  const expression =
    settings.schedule === 'custom'
      ? settings.customSchedule
      : settings.schedule;
  const nextTime = cronParser.parseExpression(expression).next().getTime();

  await browser.alarms.create(SCHEDULE_BACKUP_ALARM, { when: nextTime });
}

/**
 * 备份服务初始化（成品包 x，带 memoization）：
 * 门禁就绪、续做未完成的恢复，浏览器重启后锁定加密定时备份。
 */
export function initBackup() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    markRestoreGateReady();
    await restoreFromJournal(rebuildAfterRestore);

    const { localBackupSettings } = await browser.storage.local.get(
      'localBackupSettings'
    );

    if (
      localBackupSettings?.schedule &&
      (localBackupSettings.encrypt || localBackupSettings.includedItems)
    ) {
      // 加密定时备份的密码只在会话内有效，重启后需重新输入启用
      await browser.alarms.clear(SCHEDULE_BACKUP_ALARM);
      await browser.storage.local.set({
        localBackupSettings: {
          ...localBackupSettings,
          requiresUnlock: true,
          lastError: '浏览器已重启，请重新输入备份密码并启用定时备份',
        },
      });
    } else {
      await scheduleBackupAlarm(localBackupSettings || {});
    }
  })().catch((error) => {
    initPromise = null;
    throw error;
  });

  return initPromise;
}

/**
 * 保存定时备份设置（成品包 C，backup:configure）
 * @returns {Promise<object>} 归一化后的设置
 */
export async function configureBackup({ settings, password = '' }) {
  await initBackup();

  const folderName = (settings.folderName || 'automa-backup').trim();
  if (
    !folderName ||
    folderName.includes('..') ||
    /[\\:*?"<>|]/.test(folderName) ||
    folderName.startsWith('/')
  ) {
    throw new Error('备份文件夹必须是下载目录下的有效相对路径');
  }

  const nextSettings = {
    schedule: settings.schedule || '',
    customSchedule: settings.customSchedule || '',
    folderName,
    encrypt: Boolean(settings.encrypt),
    requiresUnlock: false,
  };

  if (nextSettings.schedule) {
    const hasPermission = await browser.permissions.contains({
      permissions: ['downloads'],
    });
    if (!hasPermission) throw new Error('请先允许下载文件权限');

    // 先做一次试备份，验证密码可用
    await doBackup(nextSettings.encrypt ? password : '');
    if (nextSettings.encrypt && !password) {
      throw new Error('请输入本次浏览器会话的定时备份密码');
    }
  }

  sessionPassword = nextSettings.encrypt ? password : '';
  await scheduleBackupAlarm(nextSettings);
  await browser.storage.local.set({ localBackupSettings: nextSettings });

  return nextSettings;
}

/** 执行定时备份（成品包 onAlarms 的 schedule-local-backup 分支） */
async function handleScheduledBackup() {
  await initBackup();

  const { localBackupSettings: settings } = await browser.storage.local.get(
    'localBackupSettings'
  );
  if (!settings?.schedule || settings.requiresUnlock) return;

  try {
    if (settings.encrypt && !sessionPassword) {
      throw new Error('定时备份已锁定，请重新输入密码');
    }

    const backup = await doBackup(settings.encrypt ? sessionPassword : '');
    const blobUrl = URL.createObjectURL(
      new Blob([JSON.stringify(backup)], { type: 'application/json' })
    );

    try {
      await browser.downloads.download({
        filename: `${settings.folderName}/automa-${new Date()
          .toISOString()
          .replace(/[:.]/g, '-')}.json`,
        url: blobUrl,
      });
    } finally {
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }

    const nextSettings = {
      ...settings,
      lastBackup: Date.now(),
      lastError: '',
    };
    await browser.storage.local.set({ localBackupSettings: nextSettings });
    await scheduleBackupAlarm(nextSettings);
  } catch (error) {
    await browser.alarms.clear(SCHEDULE_BACKUP_ALARM);
    await browser.storage.local.set({
      localBackupSettings: {
        ...settings,
        requiresUnlock: true,
        lastError: error.message,
      },
    });
  }
}

export function isScheduledBackupAlarm(name) {
  return name === SCHEDULE_BACKUP_ALARM;
}

/** 当前会话是否已设置定时备份密码（backup:status 的 unlocked 字段） */
export function hasSessionPassword() {
  return Boolean(sessionPassword);
}

/** 恢复完成后清空会话密码（成品包 T=""） */
export function clearSessionPassword() {
  sessionPassword = '';
}

export { handleScheduledBackup };

// 保留对 checkRestoreJournal 的引用，前台/后台共用同一恢复日志语义
export { checkRestoreJournal };
