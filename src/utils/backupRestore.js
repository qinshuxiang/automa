import Dexie from 'dexie';

/**
 * 备份/恢复门控（成品包模块 85245 反移植）
 *
 * 本期仅移植"恢复门禁 + 启动检查"部分，完整备份/恢复 payload 处理留待后续阶段。
 *
 * 语义（与成品包后台/前台两个变体一致）：
 * - 后台负责执行恢复；前台（newtab）启动时检查恢复日志；
 * - 存在未完成的恢复快照则保持阻塞，否则解除"正在恢复本地数据"的恒定阻塞；
 * - 恢复日志查表失败时兜底解除阻塞，保证不会永久卡死。
 */

// 恢复中标记与门控就绪标记（成品包 V6/w：restoring || !gateReady）
let restoring = false;
let gateReady = false;

// 恢复日志库（成品包：new Dexie('automa-backup-recovery')，journal 表，键 'restore'）
const recoveryDb = new Dexie('automa-backup-recovery');
recoveryDb.version(1).stores({ journal: 'id' });

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
