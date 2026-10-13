/**
 * 本地备份格式（成品包模块 25539 全量移植）
 *
 * 备份文件格式：{ format: 'automa-local-backup', version: 1, createdAt, encrypted, data }
 * 加密：AES-GCM-256 + PBKDF2-SHA256（310000 次迭代，16 字节 salt + 12 字节 iv），
 * additionalData 绑定 `${format}:${version}` 防止密文挪用。
 */

/* eslint-disable no-restricted-syntax, no-use-before-define */

export const BACKUP_FORMAT = 'automa-local-backup';
export const BACKUP_FORMAT_VERSION = 1;

// 备份覆盖的 storage.local 键（成品包 WH）
export const STORAGE_KEYS = [
  'workflows',
  'folders',
  'savedBlocks',
  'settings',
  'shortcuts',
  'automaShortcut',
  'pinnedWorkflows',
  'theme',
  'localBackupSettings',
];

// 备份覆盖的 IndexedDB 表（成品包 Kt）
export const DB_TABLES = [
  'tablesItems',
  'tablesData',
  'variables',
  'credentials',
];

const PBKDF2_ITERATIONS = 310000;

const deepClone = (value) => JSON.parse(JSON.stringify(value));
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const idKey = (value) => `${typeof value}:${value}`;

function throwError(message) {
  throw new Error(message);
}

/** 备份状态的空结构（成品包 K$） */
export function createDefaultState() {
  return {
    storage: {
      workflows: {},
      folders: [],
      savedBlocks: [],
      settings: {},
      shortcuts: {},
      pinnedWorkflows: [],
    },
    database: {
      tablesItems: [],
      tablesData: [],
      variables: [],
      credentials: [],
    },
    local: {},
  };
}

function assertValidIdList(list, name) {
  if (!Array.isArray(list)) throwError(`备份格式错误：${name} 必须是列表`);

  const seen = new Set();
  list.forEach((item) => {
    if (
      !isPlainObject(item) ||
      !['string', 'number'].includes(typeof item.id) ||
      item.id === ''
    ) {
      throwError(`备份格式错误：${name} 缺少有效 ID`);
    }

    const key = idKey(item.id);
    if (seen.has(key)) throwError(`备份包含重复 ID：${name}`);
    seen.add(key);
  });
}

/**
 * 原型链污染与引用完整性校验（成品包 Nk）
 * @param {any} data 备份状态
 * @param {{ references?: boolean }} options references 为 true 时校验跨实体引用
 * @returns {any} 原数据
 */
export function validateBackupData(data, { references = false } = {}) {
  if (
    !isPlainObject(data) ||
    !isPlainObject(data.storage) ||
    !isPlainObject(data.database) ||
    !isPlainObject(data.local)
  ) {
    throwError('备份数据结构无效');
  }

  const unsafe = (key) =>
    ['__proto__', 'constructor', 'prototype'].includes(String(key));

  const checkMerge = (value) => {
    if (!value || typeof value !== 'object') return;

    for (const [key, child] of Object.entries(value)) {
      if (unsafe(key)) throwError('备份包含不支持的对象字段');
      checkMerge(child);
    }
  };

  checkMerge(data.storage.settings);
  checkMerge(data.storage.shortcuts);
  checkMerge(data.local);

  if (Object.keys(data.storage.workflows || {}).some(unsafe))
    throwError('工作流 ID 无效');

  for (const workflow of Object.values(data.storage.workflows || {})) {
    for (const node of workflow.drawflow?.nodes || []) {
      if (unsafe(node.id)) throwError('工作流节点 ID 无效');
    }
    for (const column of Object.values(
      workflow.table || workflow.dataColumns || []
    )) {
      if (unsafe(column.id || column.name)) throwError('表格列 ID 无效');
    }
  }

  for (const table of data.database.tablesItems || []) {
    for (const column of table.columns || []) {
      if (unsafe(column.id || column.name)) throwError('表格列 ID 无效');
    }
  }
  for (const table of data.database.tablesData || []) {
    if (Object.keys(table.columnsIndex || {}).some(unsafe))
      throwError('表格列 ID 无效');
  }
  for (const credential of data.database.credentials || []) {
    if (unsafe(credential.name)) throwError('凭据名称无效');
  }
  for (const variable of data.database.variables || []) {
    if (unsafe(variable.name)) throwError('变量名称无效');
  }

  const { storage, database } = data;

  function visitNode(node, workflowName) {
    if (!node || typeof node !== 'object')
      throwError(`工作流节点数据无效：${workflowName}`);

    const label = node.label || node.name || node.id;
    const subWorkflowId = node.data?.workflowId;

    if (
      label === 'execute-workflow' &&
      subWorkflowId != null &&
      subWorkflowId !== '' &&
      !String(subWorkflowId).includes('{{') &&
      !Object.prototype.hasOwnProperty.call(storage.workflows, subWorkflowId)
    ) {
      throwError(
        `工作流引用不存在的子工作流：${workflowName} / ${subWorkflowId}`
      );
    }

    if (label === 'blocks-group') {
      if (!Array.isArray(node.data?.blocks))
        throwError(`节点组数据无效：${workflowName}`);
      node.data.blocks.forEach((block) => visitNode(block, workflowName));
    }

    if (label === 'block-package') {
      validateDrawflow(node.data?.data, workflowName);
    }
  }

  function validateDrawflow(drawflow, workflowName) {
    if (typeof drawflow === 'string') {
      try {
        drawflow = JSON.parse(drawflow);
      } catch {
        throwError(`工作流节点数据损坏：${workflowName}`);
      }
    }

    if (
      !drawflow ||
      (!Array.isArray(drawflow.nodes) && !drawflow.drawflow?.Home?.data)
    ) {
      throwError(`工作流节点格式无效：${workflowName}`);
    }

    if (Array.isArray(drawflow.nodes)) {
      if (!Array.isArray(drawflow.edges))
        throwError(`工作流连接格式无效：${workflowName}`);

      const nodeIds = new Set(drawflow.nodes.map((node) => String(node?.id)));
      if (
        nodeIds.size !== drawflow.nodes.length ||
        drawflow.nodes.some(
          (node) => !node?.id || typeof node.label !== 'string'
        )
      ) {
        throwError(`工作流节点 ID 无效：${workflowName}`);
      }

      if (
        drawflow.edges.some(
          (edge) =>
            !edge ||
            !nodeIds.has(String(edge.source)) ||
            !nodeIds.has(String(edge.target))
        )
      ) {
        throwError(`工作流连接引用不存在的节点：${workflowName}`);
      }

      drawflow.nodes.forEach((node) => visitNode(node, workflowName));
    } else {
      const homeData = drawflow.drawflow.Home.data;
      Object.values(homeData).forEach((node) => {
        visitNode(node, workflowName);

        Object.values(node.outputs || {}).forEach((output) => {
          if (
            !(
              Array.isArray(output.connections) &&
              !output.connections.some(
                (connection) =>
                  !connection ||
                  !Object.prototype.hasOwnProperty.call(
                    homeData,
                    connection.node
                  )
              )
            )
          ) {
            throwError(`旧版工作流连接引用无效：${workflowName}`);
          }
        });
      });
    }
  }

  if (Object.keys(storage).some((key) => !STORAGE_KEYS.includes(key)))
    throwError('备份包含不支持的存储项目');
  if (Object.keys(data.local).some((key) => key !== 'shortcuts'))
    throwError('备份包含不支持的本地设置');
  if (
    !(
      isPlainObject(storage.workflows) &&
      isPlainObject(storage.settings) &&
      isPlainObject(storage.shortcuts)
    )
  )
    throwError('备份工作流或设置格式无效');

  assertValidIdList(Object.values(storage.workflows), 'workflows');
  Object.entries(storage.workflows).forEach(([id, workflow]) => {
    if (
      id !== String(workflow.id) ||
      typeof workflow.name !== 'string' ||
      !workflow.drawflow
    ) {
      throwError('工作流 ID、名称或节点数据无效');
    }
    if (
      workflow.isProtected &&
      !(
        typeof workflow.pass === 'string' &&
        typeof workflow.drawflow === 'string'
      )
    ) {
      throwError('受保护工作流数据不完整');
    }
  });

  assertValidIdList(storage.folders, 'folders');
  assertValidIdList(storage.savedBlocks, 'savedBlocks');
  if (!Array.isArray(storage.pinnedWorkflows)) throwError('固定工作流列表无效');

  DB_TABLES.forEach((table) => assertValidIdList(database[table], table));

  ['credentials', 'variables'].forEach((name) => {
    const seen = new Set();
    database[name].forEach((item) => {
      if (
        !(
          typeof item.name === 'string' &&
          item.name.trim() &&
          !seen.has(item.name)
        )
      ) {
        throwError(`${name} 包含无效或重复名称`);
      }
      seen.add(item.name);
    });
  });

  database.tablesItems.forEach((table) => {
    if (!(typeof table.name === 'string' && Array.isArray(table.columns)))
      throwError('表格结构无效');
  });
  database.tablesData.forEach((table) => {
    if (!(Array.isArray(table.items) && isPlainObject(table.columnsIndex)))
      throwError('表格行数据无效');
  });

  if (references) {
    const tableIds = new Set(
      database.tablesItems.map((item) => idKey(item.id))
    );
    const folderIds = new Set(storage.folders.map((item) => idKey(item.id)));
    const tableDataIds = new Set(
      database.tablesData.map((item) => idKey(item.tableId))
    );

    if (
      tableDataIds.size !== database.tablesData.length ||
      [...tableDataIds].some((id) => !tableIds.has(id))
    ) {
      throwError('表格数据容器缺失或重复');
    }

    database.tablesData.forEach((table) => {
      if (!tableIds.has(idKey(table.tableId)))
        throwError(`表格行引用不存在的表格：${table.tableId}`);
    });

    Object.values(storage.workflows).forEach((workflow) => {
      if (
        workflow.folderId != null &&
        workflow.folderId !== '' &&
        !folderIds.has(idKey(workflow.folderId))
      ) {
        throwError(`工作流引用不存在的文件夹：${workflow.name}`);
      }
      if (
        workflow.connectedTable != null &&
        workflow.connectedTable !== '' &&
        !tableIds.has(idKey(workflow.connectedTable))
      ) {
        throwError(`工作流引用不存在的表格：${workflow.name}`);
      }
    });

    [
      ...Object.values(storage.workflows),
      ...storage.savedBlocks.map((block) => ({
        ...block,
        drawflow: block.data,
      })),
    ].forEach((workflow) => {
      if (!workflow.isProtected)
        validateDrawflow(workflow.drawflow, workflow.name);
    });

    storage.pinnedWorkflows.forEach((workflowId) => {
      if (!Object.prototype.hasOwnProperty.call(storage.workflows, workflowId))
        throwError(`固定列表引用不存在的工作流：${workflowId}`);
    });
  }

  return data;
}

/** 备份是否包含凭据或受保护工作流（成品包 m） */
function hasSensitiveData(state) {
  return (
    state.database.credentials.length > 0 ||
    Object.values(state.storage.workflows).some(
      (workflow) => workflow.isProtected
    )
  );
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }

  return btoa(binary);
}

function base64ToBytes(base64) {
  if (typeof base64 !== 'string') throwError('备份加密参数无效');

  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

async function deriveBackupKey(password, salt, iterations, cryptoObj) {
  const keyMaterial = await cryptoObj.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );

  return cryptoObj.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * 生成备份文件（成品包 BO）。含敏感数据时必须提供密码。
 * @returns {Promise<object>} 备份文件对象
 */
export async function createBackupFile(
  state,
  password = '',
  cryptoObj = globalThis.crypto
) {
  validateBackupData(state);

  if (hasSensitiveData(state) && !password)
    throwError('备份含凭据或受保护工作流，请设置备份密码');

  const meta = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    encrypted: Boolean(password),
  };

  if (!password) return { ...meta, data: deepClone(state) };

  const salt = cryptoObj.getRandomValues(new Uint8Array(16));
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const key = await deriveBackupKey(
    password,
    salt,
    PBKDF2_ITERATIONS,
    cryptoObj
  );
  const encrypted = await cryptoObj.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(
        `${BACKUP_FORMAT}:${BACKUP_FORMAT_VERSION}`
      ),
    },
    key,
    new TextEncoder().encode(JSON.stringify(state))
  );

  return {
    ...meta,
    encryption: {
      cipher: 'AES-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToBase64(salt),
      iv: bytesToBase64(iv),
    },
    data: bytesToBase64(new Uint8Array(encrypted)),
  };
}

/**
 * 解密并校验备份文件（成品包 Qb）
 * @returns {Promise<any>} 校验通过的备份状态
 */
export async function decryptBackupFile(
  payload,
  password = '',
  cryptoObj = globalThis.crypto
) {
  if (
    !(
      isPlainObject(payload) &&
      payload.format === BACKUP_FORMAT &&
      payload.version === BACKUP_FORMAT_VERSION
    )
  ) {
    throwError('不支持的备份格式或版本');
  }
  if (typeof payload.encrypted !== 'boolean') throwError('备份加密标识无效');

  if (!payload.encrypted) {
    const state = validateBackupData(deepClone(payload.data));
    if (hasSensitiveData(state)) throwError('含敏感数据的备份必须加密');

    return state;
  }

  if (!password) throwError('请输入备份密码');

  const { encryption } = payload;
  if (
    !(
      encryption &&
      encryption.cipher === 'AES-GCM' &&
      encryption.kdf === 'PBKDF2-SHA256' &&
      encryption.iterations === PBKDF2_ITERATIONS
    )
  ) {
    throwError('不支持的备份加密参数');
  }

  const salt = base64ToBytes(encryption.salt);
  const iv = base64ToBytes(encryption.iv);
  if (!(salt.length === 16 && iv.length === 12)) throwError('备份加密参数损坏');

  let decrypted;
  try {
    const key = await deriveBackupKey(
      password,
      salt,
      encryption.iterations,
      cryptoObj
    );
    decrypted = await cryptoObj.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(
          `${BACKUP_FORMAT}:${BACKUP_FORMAT_VERSION}`
        ),
      },
      key,
      base64ToBytes(payload.data)
    );
  } catch {
    throwError('备份密码错误或文件已损坏，未修改任何数据');
  }

  return validateBackupData(JSON.parse(new TextDecoder().decode(decrypted)));
}

/** 递归合并对象（成品包 E，settings/shortcuts/local 用） */
function deepMerge(target, source, overwrite) {
  const result = deepClone(target);

  Object.entries(source).forEach(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(result, key) || overwrite) {
      result[key] = deepClone(value);
    } else if (isPlainObject(result[key]) && isPlainObject(value)) {
      result[key] = deepMerge(result[key], value, false);
    }
  });

  return result;
}

/** 按 ID 合并列表，overwrite 时新数据胜出（成品包 k） */
function mergeListById(current, incoming, overwrite) {
  const merged = new Map(
    current.map((item) => [idKey(item.id), deepClone(item)])
  );

  incoming.forEach((item) => {
    if (!merged.has(idKey(item.id)) || overwrite) {
      merged.set(idKey(item.id), deepClone(item));
    }
  });

  return [...merged.values()];
}

/**
 * 将恢复数据合并进当前状态（成品包 px）。
 * 默认保留现有数据，overwrite 为 true 时恢复数据覆盖同 ID 项；
 * 恢复后定时备份强制关闭并要求重新解锁。
 */
export function mergeBackupState(current, restored, overwrite = false) {
  validateBackupData(current);
  validateBackupData(restored, { references: true });

  const merged = deepClone(current);
  const currentTableIds = new Set(
    current.database.tablesItems.map((item) => idKey(item.id))
  );
  const restoredTableIds = new Set(
    restored.database.tablesItems
      .filter((item) => overwrite || !currentTableIds.has(idKey(item.id)))
      .map((item) => idKey(item.id))
  );

  Object.entries(restored.storage.workflows).forEach(([id, workflow]) => {
    if (
      !Object.prototype.hasOwnProperty.call(merged.storage.workflows, id) ||
      overwrite
    ) {
      merged.storage.workflows[id] = deepClone(workflow);
    }
  });

  ['folders', 'savedBlocks'].forEach((name) => {
    merged.storage[name] = mergeListById(
      current.storage[name],
      restored.storage[name],
      overwrite
    );
  });

  ['settings', 'shortcuts'].forEach((name) => {
    merged.storage[name] = deepMerge(
      current.storage[name],
      restored.storage[name],
      overwrite
    );
  });

  merged.storage.pinnedWorkflows = [
    ...new Set([
      ...current.storage.pinnedWorkflows,
      ...restored.storage.pinnedWorkflows,
    ]),
  ];

  ['automaShortcut', 'theme', 'localBackupSettings'].forEach((name) => {
    if (
      !Object.prototype.hasOwnProperty.call(restored.storage, name) ||
      (!overwrite &&
        Object.prototype.hasOwnProperty.call(current.storage, name))
    ) {
      return;
    }

    merged.storage[name] = deepClone(restored.storage[name]);
  });

  if (merged.storage.localBackupSettings) {
    merged.storage.localBackupSettings = {
      ...merged.storage.localBackupSettings,
      schedule: '',
      customSchedule: '',
      requiresUnlock: true,
    };
  }

  merged.local = deepMerge(current.local, restored.local, overwrite);

  ['tablesItems', 'variables', 'credentials'].forEach((name) => {
    merged.database[name] = mergeListById(
      current.database[name],
      restored.database[name],
      overwrite
    );
  });

  const keptTablesData = current.database.tablesData.filter(
    (item) => !restoredTableIds.has(idKey(item.tableId))
  );
  const restoredTablesData = restored.database.tablesData.filter((item) =>
    restoredTableIds.has(idKey(item.tableId))
  );
  const usedIds = new Set(keptTablesData.map((item) => idKey(item.id)));
  let nextId =
    Math.max(
      0,
      ...keptTablesData.map((item) => Number(item.id) || 0),
      ...restoredTablesData.map((item) => Number(item.id) || 0)
    ) + 1;

  const renumbered = deepClone(restoredTablesData).map((item) => {
    if (usedIds.has(idKey(item.id))) {
      item.id = nextId;
      nextId += 1;
    }
    usedIds.add(idKey(item.id));

    return item;
  });

  merged.database.tablesData = [...deepClone(keptTablesData), ...renumbered];

  return validateBackupData(merged, { references: true });
}

/**
 * 快照回滚恢复（成品包 ZK）：
 * 写入恢复前快照，失败时回滚到 before；连回滚都失败时保留快照供重启后重试。
 */
export async function restoreWithJournal({
  before,
  after,
  journal,
  write,
  rebuild,
}) {
  await journal.save(before);

  try {
    await write(after);
    await rebuild(after);
    await journal.clear();
  } catch (error) {
    try {
      await write(before);
      await rebuild(before);
      await journal.clear();
    } catch {
      throwError(
        '恢复失败且自动回滚未完成；恢复快照已保留，请重启浏览器重试恢复'
      );
    }

    throw error;
  }
}
