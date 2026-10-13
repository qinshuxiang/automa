import browser from 'webextension-polyfill';
import Dexie from 'dexie';
import AES from 'crypto-js/aes';
import SHA256 from 'crypto-js/sha256';
import HmacSHA256 from 'crypto-js/hmac-sha256';
import encUtf8 from 'crypto-js/enc-utf8';
import dbStorage from '@/db/storage';
import getPassKey from './getPassKey';
import {
  STORAGE_KEYS,
  DB_TABLES,
  BACKUP_FORMAT,
  createDefaultState,
  createBackupFile,
  decryptBackupFile,
  validateBackupData,
  mergeBackupState,
  restoreWithJournal,
} from './backupFormat';

/* eslint-disable no-use-before-define */

/**
 * 备份/恢复门控与完整 payload 处理（成品包模块 85245 全量移植）
 *
 * - 后台负责执行恢复；前台（newtab）启动时检查恢复日志；
 * - 恢复期间 isRestoreBlocked() 为 true，工作流执行被阻塞；
 * - 恢复走快照 + 回滚：失败自动还原，快照保留在 automa-backup-recovery 库。
 */

// 恢复中标记与门控就绪标记（成品包 v/y）
let restoring = false;
let gateReady = false;

// 恢复日志库（成品包：new Dexie('automa-backup-recovery')，journal 表，键 'restore'）
const recoveryDb = new Dexie('automa-backup-recovery');
recoveryDb.version(1).stores({ journal: 'id' });

const journal = {
  save: (snapshot) =>
    recoveryDb.journal.put({
      id: 'restore',
      snapshot,
      createdAt: Date.now(),
    }),
  clear: () => recoveryDb.journal.delete('restore'),
};

/** 是否处于恢复阻塞状态（阻塞期间不能执行工作流） */
export function isRestoreBlocked() {
  return restoring || !gateReady;
}

/** 解除"正在恢复本地数据"的恒定阻塞（后台启动初始化时调用） */
export function markRestoreGateReady() {
  gateReady = true;
}

/**
 * 启动时检查恢复日志：
 * - 存在未完成的恢复快照：保持阻塞并返回 true；
 * - 不存在：解除阻塞并返回 false；
 * - 查表失败：兜底解除阻塞并返回 false（console.error 记录，避免永久卡死）。
 *
 * @returns {Promise<boolean>} 是否仍处于恢复阻塞状态
 */
export async function checkRestoreJournal() {
  try {
    const entry = await recoveryDb.journal.get('restore');
    restoring = Boolean(entry);
    markRestoreGateReady();

    return restoring;
  } catch (error) {
    console.error('检查恢复日志失败，已解除恢复阻塞', error);
    markRestoreGateReady();

    return false;
  }
}

const deepClone = (value) => JSON.parse(JSON.stringify(value));

/** 归一化 storage.local 读取结果（成品包 _ 内的内联变换） */
function normalizeStorage(storage) {
  const defined = Object.fromEntries(
    Object.entries(storage).filter(([, value]) => value !== undefined)
  );
  const merged = { ...createDefaultState().storage, ...defined };

  if (Array.isArray(merged.workflows)) {
    merged.workflows = Object.fromEntries(
      merged.workflows.map((workflow) => [workflow.id, workflow])
    );
  }
  if (Array.isArray(merged.shortcuts)) merged.shortcuts = {};

  if (merged.localBackupSettings) {
    const settings = merged.localBackupSettings;
    merged.localBackupSettings = {
      schedule: settings.schedule || '',
      customSchedule: settings.customSchedule || '',
      folderName: settings.folderName || 'automa-backup',
      lastBackup: settings.lastBackup || null,
      encrypt: Boolean(settings.encrypt),
    };
  }

  return merged;
}

/** 收集当前完整状态（storage + database + local 快捷键），成品包 _ */
async function collectBackupState() {
  const storage = normalizeStorage(
    await browser.storage.local.get(STORAGE_KEYS)
  );

  const database = {};
  await dbStorage.transaction('r', dbStorage.tables, async () => {
    for (const table of DB_TABLES) {
      database[table] = await dbStorage[table].toArray();
    }
  });

  const shortcuts = localStorage.getItem('shortcuts');
  const state = {
    storage,
    database,
    local: shortcuts === null ? {} : { shortcuts },
  };

  return validateBackupData(deepClone(state));
}

/**
 * 生成完整备份文件（成品包 d5）：
 * 凭据解密为明文、受保护工作流附加恢复材料后交给 createBackupFile 加密。
 * @param {string} password 备份密码，含敏感数据时必填
 */
export async function doBackup(password = '') {
  if (restoring) throw new Error('正在恢复数据，请稍后备份');

  const state = await collectBackupState();

  const prepared = prepareBackupState(state);

  return createBackupFile(prepared, password);
}

/** 解密凭据与工作流恢复材料（成品包 T 的内联变换） */
function prepareBackupState(state) {
  const cloned = deepClone(state);
  const credentialPass = getPassKey('credential');

  cloned.database.credentials.forEach((credential) => {
    const hmac = credential.value.substring(0, 64);
    const encrypted = credential.value.substring(64);

    if (hmac !== HmacSHA256(encrypted, SHA256(credentialPass)).toString()) {
      throw new Error(`凭据无法解密：${credential.name}。请确认使用原安装密钥`);
    }

    credential.value = AES.decrypt(encrypted, credentialPass).toString(encUtf8);
  });

  Object.values(cloned.storage.workflows).forEach((workflow) => {
    if (!workflow.isProtected) return;

    const encryptedPass = workflow.pass.substring(64);
    const recoveryPassword = AES.decrypt(
      encryptedPass,
      getPassKey('workflow')
    ).toString(encUtf8);

    if (
      HmacSHA256(encryptedPass, recoveryPassword).toString() !==
      workflow.pass.substring(0, 64)
    ) {
      throw new Error(`工作流密码无法恢复：${workflow.name}`);
    }

    workflow.recoveryPassword = recoveryPassword;
  });

  return cloned;
}

/** 将恢复快照写入 storage/IndexedDB/localStorage（成品包 x） */
export async function writeBackupState(state) {
  await dbStorage.transaction('rw', dbStorage.tables, async () => {
    for (const table of DB_TABLES) {
      await dbStorage[table].clear();
      await dbStorage[table].bulkPut(state.database[table]);
    }
  });

  await browser.storage.local.set(state.storage);

  const missingKeys = STORAGE_KEYS.filter((key) => !(key in state.storage));
  if (missingKeys.length) {
    await browser.storage.local.remove(missingKeys);
  }

  if (Object.prototype.hasOwnProperty.call(state.local, 'shortcuts')) {
    localStorage.setItem('shortcuts', state.local.shortcuts);
  } else {
    localStorage.removeItem('shortcuts');
  }
}

/**
 * 从恢复日志恢复（成品包 hI）：
 * 存在未完成快照时重新写入并重建触发器，成功后清除快照。
 * @param {(snapshot: any) => Promise<void>} rebuild 恢复后的触发器重建回调
 * @returns {Promise<boolean>} 是否执行了恢复
 */
export async function restoreFromJournal(rebuild) {
  const entry = await recoveryDb.journal.get('restore');
  if (!entry) return false;

  restoring = true;

  try {
    await writeBackupState(entry.snapshot);
    await rebuild(entry.snapshot);
    await journal.clear();

    return true;
  } finally {
    restoring = Boolean(await recoveryDb.journal.get('restore'));
  }
}

function parseMaybeEncodedJSON(value) {
  if (typeof value !== 'string') return value;

  try {
    return JSON.parse(value);
  } catch {
    return JSON.parse(decodeURIComponent(value));
  }
}

/** 旧版（v1.28.27 导出）备份转完整状态（成品包 O$ 内的 legacy 分支） */
function convertLegacyBackup(legacy, password) {
  const state = createDefaultState();
  let { workflows } = legacy;

  if (legacy.isProtected) {
    if (!password) throw new Error('请输入旧版备份密码');
    if (typeof workflows !== 'string') throw new Error('旧版加密备份格式无效');

    const hmac = workflows.substring(0, 64);
    const encrypted = workflows.substring(64);
    if (HmacSHA256(encrypted, password).toString() !== hmac) {
      throw new Error('备份密码错误或文件已损坏');
    }

    workflows = AES.decrypt(encrypted, password).toString(encUtf8);
  }

  if (legacy.drawflow) {
    workflows = [legacy, ...Object.values(legacy.includedWorkflows || {})];
  }

  workflows = parseMaybeEncodedJSON(workflows);
  if (!Array.isArray(workflows)) throw new Error('旧版备份没有有效工作流列表');

  workflows.forEach((workflow) => {
    if (workflow.isProtected) {
      throw new Error('旧版受保护工作流缺少跨安装恢复材料，请使用新版完整备份');
    }

    const id =
      workflow.id ||
      `import-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')}`;

    state.storage.workflows[id] = { settings: {}, ...workflow, id };
    delete state.storage.workflows[id].includedWorkflows;
  });

  if (legacy.storageTables) {
    state.database.tablesItems = parseMaybeEncodedJSON(legacy.storageTables);
  }
  if (legacy.storageVariables) {
    state.database.variables = parseMaybeEncodedJSON(legacy.storageVariables);
  }

  state.database.tablesData = state.database.tablesItems.map(
    (table, index) => ({
      id: index + 1,
      tableId: table.id,
      items: [],
      columnsIndex: Object.fromEntries(
        (table.columns || []).map((column) => [
          column.id,
          { index: 0, name: column.name, type: column.type },
        ])
      ),
    })
  );
  state.database.tablesItems.forEach((table) => {
    table.rowsCount = 0;
  });

  return validateBackupData(state);
}

/** 为恢复数据重新加密凭据与恢复材料（成品包 O$ 新格式分支） */
function reEncryptRestoreData(state) {
  const cloned = deepClone(state);
  const credentialPass = getPassKey('credential');

  cloned.database.credentials.forEach((credential) => {
    if (typeof credential.value !== 'string')
      throw new Error('凭据恢复数据无效');

    const encrypted = AES.encrypt(credential.value, credentialPass).toString();
    credential.value =
      HmacSHA256(encrypted, SHA256(credentialPass)).toString() + encrypted;
  });

  Object.values(cloned.storage.workflows).forEach((workflow) => {
    if (!workflow.isProtected) return;

    if (typeof workflow.recoveryPassword !== 'string') {
      throw new Error(`缺少工作流恢复材料：${workflow.name}`);
    }

    const encryptedPass = AES.encrypt(
      workflow.recoveryPassword,
      getPassKey('workflow')
    ).toString();
    workflow.pass =
      HmacSHA256(encryptedPass, workflow.recoveryPassword).toString() +
      encryptedPass;
    delete workflow.recoveryPassword;
  });

  // 用恢复材料试解密受保护工作流节点，验证跨安装可恢复性
  const verified = deepClone(cloned);
  Object.values(verified.storage.workflows).forEach((workflow) => {
    if (!workflow.isProtected) return;

    const recoveryPassword = AES.decrypt(
      workflow.pass.substring(64),
      getPassKey('workflow')
    ).toString(encUtf8);

    try {
      workflow.drawflow = JSON.parse(
        AES.decrypt(workflow.drawflow, recoveryPassword).toString(encUtf8)
      );
    } catch {
      throw new Error(`受保护工作流节点损坏：${workflow.name}`);
    }

    workflow.isProtected = false;
  });

  validateBackupData(verified, { references: true });

  return cloned;
}

/**
 * 执行完整恢复（成品包 O$）：
 * 校验并合并数据，写入前保存快照，失败自动回滚。
 * @param {{ payload: any, password?: string, overwrite?: boolean }} restoreOptions
 * @param {{ rebuild: (snapshot: any) => Promise<void>, assertIdle: () => Promise<void> }} options
 * @returns {Promise<{ workflows: number, legacy: boolean, message: string }>}
 */
export async function doRestore(
  { payload, password = '', overwrite = false },
  { rebuild, assertIdle }
) {
  if (restoring) throw new Error('另一个恢复操作尚未完成');

  payload = parseMaybeEncodedJSON(payload);
  const isLegacy = payload?.format !== BACKUP_FORMAT;

  const restored = isLegacy
    ? convertLegacyBackup(payload, password)
    : reEncryptRestoreData(await decryptBackupFile(payload, password));

  if (restoring) throw new Error('另一个恢复操作尚未完成');

  restoring = true;

  try {
    await assertIdle();

    const before = await collectBackupState();
    const after = mergeBackupState(before, restored, overwrite);

    await restoreWithJournal({
      before,
      after,
      journal,
      write: writeBackupState,
      rebuild,
    });

    return {
      workflows: Object.keys(restored.storage.workflows).length,
      legacy: isLegacy,
      message: isLegacy
        ? '旧版文件已恢复；旧版备份未包含的表格行数据无法恢复。'
        : '完整备份已恢复，定时备份已关闭，请按需重新设置。',
    };
  } finally {
    restoring = Boolean(await recoveryDb.journal.get('restore'));
  }
}
