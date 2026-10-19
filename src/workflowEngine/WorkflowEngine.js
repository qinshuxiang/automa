/* eslint-disable no-restricted-globals */
import { nanoid } from 'nanoid';
import browser from 'webextension-polyfill';
import cloneDeep from 'lodash.clonedeep';
import { getBlocks } from '@/utils/getSharedData';
import { clearCache, sleep, parseJSON, isObject } from '@/utils/helper';
import dbStorage from '@/db/storage';
import WorkflowWorker from './WorkflowWorker';

let blocks = getBlocks();

class WorkflowEngine {
  constructor(
    workflow,
    { states, logger, blocksHandler, isPopup, options, parentEngine }
  ) {
    this.id = nanoid();
    this.states = states;
    this.logger = logger;
    this.workflow = workflow;
    this.isPopup = isPopup ?? true;
    this.blocksHandler = blocksHandler;
    this.isTestingMode = workflow.testingMode;
    this.parentWorkflow = options?.parentWorkflow;
    this.parentTableEngine = parentEngine;
    this.saveLog = workflow.settings?.saveLog ?? true;
    this.isMV2 = browser.runtime.getManifest().manifest_version === 2;

    this.workerId = 0;
    this.workers = new Map();
    this.contentExecutionTabs = new Set();

    this.packagesCache = {};
    this.extractedGroup = {};
    this.connectionsMap = {};
    this.waitConnections = {};

    this.isDestroyed = false;
    this.isUsingProxy = false;
    this.isInBreakpoint = false;

    this.triggerBlockId = null;

    this.blocks = {};
    this.history = [];
    this.columnsId = {};
    this.historyCtxData = {};
    this.eventListeners = {};
    this.preloadScripts = [];

    this.columns = {
      column: {
        index: 0,
        type: 'any',
        name: this.workflow.settings?.defaultColumnName || 'column',
      },
    };
    this.rowData = {};

    this.logsLimit = 1001;
    this.logHistoryId = 0;

    let variables = {};
    let { globalData } = workflow;
    if (options && options?.data) {
      globalData = options.data.globalData || globalData;
      variables = isObject(options.data.variables)
        ? options?.data.variables
        : {};

      options.data = { globalData, variables };
    }
    this.options = options;

    this.refDataSnapshots = {};
    this.refDataSnapshotsKeys = {
      loopData: {
        index: 0,
        key: '##loopData0',
      },
      variables: {
        index: 0,
        key: '##variables0',
      },
    };
    this.referenceData = {
      variables,
      table: [],
      secrets: {},
      loopData: {},
      workflow: {},
      globalData: parseJSON(globalData, globalData),
    };

    this.onDebugEvent = ({ tabId }, method, params) => {
      let isActiveTabEvent = false;
      this.workers.forEach((worker) => {
        if (isActiveTabEvent) return;

        isActiveTabEvent = worker.activeTab.id === tabId;
      });

      if (!isActiveTabEvent) return;

      (this.eventListeners[method] || []).forEach((listener) => {
        listener(params);
      });
    };
    this.onWorkflowStopped = (id) => {
      if (this.id !== id || this.isDestroyed) return;
      this.stop();
    };
    this.onResumeExecution = ({ id, nextBlock }) => {
      if (this.id !== id || this.isDestroyed) return;

      this.workers.forEach((worker) => {
        worker.resume(nextBlock);
      });
    };
  }

  async init() {
    try {
      if (this.workflow.isDisabled) return;

      if (!this.states) {
        console.error(`"${this.workflow.name}" workflow doesn't have states`);
        this.destroy('error');
        return;
      }

      const { nodes, edges } = this.workflow.drawflow;
      if (!nodes || nodes.length === 0) {
        console.error(`${this.workflow.name} doesn't have blocks`);
        return;
      }

      const triggerBlock = nodes.find((node) => {
        if (this.options?.blockId) return node.id === this.options.blockId;

        return node.label === 'trigger';
      });
      if (!triggerBlock) {
        console.error(`${this.workflow.name} doesn't have a trigger block`);
        return;
      }

      if (!this.workflow.settings) {
        this.workflow.settings = {};
      }

      blocks = getBlocks();

      const checkParams = this.options?.checkParams ?? true;
      const hasParams =
        checkParams && triggerBlock.data?.parameters?.length > 0;
      if (hasParams) {
        this.eventListeners = {};

        if (triggerBlock.data.preferParamsInTab) {
          const [activeTab] = await browser.tabs.query({
            active: true,
            url: '*://*/*',
            lastFocusedWindow: true,
          });
          if (activeTab) {
            const result = await browser.tabs.sendMessage(activeTab.id, {
              type: 'input-workflow-params',
              data: {
                workflow: this.workflow,
                params: triggerBlock.data.parameters,
              },
            });

            if (result) return;
          }
        }

        const paramUrl = browser.runtime.getURL('params.html');
        const tabs = await browser.tabs.query({});
        const paramTab = tabs.find((tab) => tab.url?.includes(paramUrl));

        if (paramTab) {
          browser.tabs.sendMessage(paramTab.id, {
            name: 'workflow:params',
            data: this.workflow,
          });

          browser.windows.update(paramTab.windowId, { focused: true });
        } else {
          browser.windows.create({
            type: 'popup',
            width: 480,
            height: 700,
            url: browser.runtime.getURL(
              `/params.html?workflowId=${this.workflow.id}`
            ),
          });
        }
        return;
      }

      this.triggerBlockId = triggerBlock.id;

      this.blocks = nodes.reduce((acc, node) => {
        acc[node.id] = node;

        return acc;
      }, {});
      this.connectionsMap = edges.reduce(
        (acc, { sourceHandle, target, targetHandle }) => {
          if (!acc[sourceHandle]) acc[sourceHandle] = new Map();
          acc[sourceHandle].set(target, {
            id: target,
            targetHandle,
            sourceHandle,
          });

          return acc;
        },
        {}
      );

      const workflowTable =
        this.workflow.table || this.workflow.dataColumns || [];
      let columns = Array.isArray(workflowTable)
        ? workflowTable
        : Object.values(workflowTable);

      if (this.workflow.connectedTable) {
        // 可重入的祖先表共享：沿 parentTableEngine 链向上找同表且未销毁的祖先，
        // 直接共享其表格数据与列索引（运行时祖先递归检查，不做深度截断）
        let ancestor = this.parentTableEngine;
        while (
          ancestor &&
          (ancestor.isDestroyed ||
            ancestor.workflow.connectedTable !== this.workflow.connectedTable)
        ) {
          ancestor = ancestor.parentTableEngine;
        }

        if (ancestor) {
          this.__tableParent = ancestor;
          this.columns = ancestor.columns;
          this.referenceData.table = ancestor.referenceData.table;
          columns = ancestor.workflow.table;
        } else {
          const tableId = this.workflow.connectedTable;

          // P1-3：按表 ID 内存互斥锁（promise 链），只覆盖"加载"临界区
          const locks =
            self.__automaTableLocks || (self.__automaTableLocks = new Map());
          const previous = locks.get(tableId) || Promise.resolve();
          let release;
          const gate = new Promise((resolve) => {
            release = resolve;
          });
          const tail = previous.then(() => gate);
          locks.set(tableId, tail);
          this.__releaseTableLock = release;
          tail.then(() => {
            if (locks.get(tableId) === tail) locks.delete(tableId);
          });

          await previous;
          if (this.isDestroyed) return;

          const connectedTable = await dbStorage.tablesItems
            .where('id')
            .equals(tableId)
            .first();
          if (this.isDestroyed) return;

          const connectedTableData =
            connectedTable &&
            (await dbStorage.tablesData
              .where('tableId')
              .equals(tableId)
              .first());
          if (this.isDestroyed) return;

          if (connectedTable && connectedTableData) {
            columns = Object.values(connectedTable.columns);
            Object.assign(this.columns, connectedTableData.columnsIndex);
            this.referenceData.table = connectedTableData.items || [];
            this.__tableLoaded = true;
            // 记录加载时的基线快照（深拷贝，避免与运行中的表共享引用）：
            // destroy 提交时以此为参照做合并，
            // 只追加本执行新增的行，不再整表覆盖执行期间的并发修改
            this.__tableBaseItems = JSON.parse(
              JSON.stringify(connectedTableData.items || [])
            );
          } else {
            this.workflow.connectedTable = null;

            if (typeof this.__releaseTableLock === 'function') {
              this.__releaseTableLock();
              this.__releaseTableLock = null;
            }
          }

          // 表格加载完成后立即释放锁：锁不再跨整个执行周期持有，
          // 否则两个流程各自持有 A 表锁、子流程互等 B 表锁时会形成死锁环
          if (typeof this.__releaseTableLock === 'function') {
            this.__releaseTableLock();
            this.__releaseTableLock = null;
          }
        }
      }

      columns.forEach(({ name, type, id }) => {
        const columnId = id || name;

        this.rowData[name] = null;

        this.columnsId[name] = columnId;
        if (!this.columns[columnId])
          this.columns[columnId] = { index: 0, name, type };
      });

      if (BROWSER_TYPE !== 'chrome') {
        this.workflow.settings.debugMode = false;
      } else if (this.workflow.settings.debugMode) {
        chrome.debugger.onEvent.addListener(this.onDebugEvent);
      }
      if (
        this.workflow.settings.reuseLastState &&
        !this.workflow.connectedTable
      ) {
        const lastStateKey = `state:${this.workflow.id}`;
        const value = await browser.storage.local.get(lastStateKey);
        const lastState = value[lastStateKey];

        if (lastState) {
          Object.assign(this.columns, lastState.columns);
          Object.assign(this.referenceData, lastState.referenceData);
        }
      }

      const { settings: userSettings } = await browser.storage.local.get(
        'settings'
      );
      this.logsLimit = userSettings?.logsLimit || 1001;

      this.workflow.table = columns;
      this.startedTimestamp = Date.now();

      this.states.on('stop', this.onWorkflowStopped);
      this.states.on('resume', this.onResumeExecution);

      const credentials = await dbStorage.credentials.toArray();
      credentials.forEach(({ name, value }) => {
        this.referenceData.secrets[name] = value;
      });

      const variables = await dbStorage.variables.toArray();
      variables.forEach(({ name, value }) => {
        this.referenceData.variables[`$$${name}`] = value;
      });

      this.addRefDataSnapshot('variables');

      await this.states.add(this.id, {
        id: this.id,
        status: 'running',
        state: this.state,
        workflowId: this.workflow.id,
        parentState: this.parentWorkflow,
        teamId: this.workflow.teamId || null,
      });
      this.addWorker({ blockId: triggerBlock.id });
    } catch (error) {
      console.error(error);
    }
  }

  addRefDataSnapshot(key) {
    this.refDataSnapshotsKeys[key].index += 1;
    this.refDataSnapshotsKeys[key].key = key;

    const keyName = this.refDataSnapshotsKeys[key].key;
    this.refDataSnapshots[keyName] = cloneDeep(this.referenceData[key]);
  }

  addWorker(detail) {
    this.workerId += 1;

    const workerId = `worker-${this.workerId}`;
    const worker = new WorkflowWorker(workerId, this, { blocksDetail: blocks });
    worker.init(detail);

    this.workers.set(worker.id, worker);
  }

  addLogHistory(detail) {
    if (detail.name === 'blocks-group') return;

    const isLimit = this.history?.length >= this.logsLimit;
    const notErrorLog = detail.type !== 'error';

    if ((isLimit || !this.saveLog) && notErrorLog) return;

    this.logHistoryId += 1;
    detail.id = this.logHistoryId;

    if (
      detail.name !== 'delay' ||
      detail.replacedValue ||
      detail.name === 'javascript-code' ||
      (blocks[detail.name]?.refDataKeys && this.saveLog)
    ) {
      const { variables, loopData } = this.refDataSnapshotsKeys;

      this.historyCtxData[this.logHistoryId] = {
        referenceData: {
          loopData: loopData.key,
          variables: variables.key,
          activeTabUrl: detail.activeTabUrl,
          prevBlockData: detail.prevBlockData || '',
        },
        replacedValue: cloneDeep(detail.replacedValue),
        ...(detail?.ctxData || {}),
      };

      delete detail.replacedValue;
    }

    this.history.push(detail);
  }

  async stop() {
    await this.destroy('stopped');
  }

  async executeQueue() {
    // 串行化队列消费：并发的整队读改写会互相丢失移除结果，
    // 导致已执行过的队列项残留并被再次执行
    const task = (self.__automaQueueLock || Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const workflowId = this.workflow?.id;
        const { workflowQueue } = await browser.storage.local.get(
          'workflowQueue'
        );

        if (!workflowQueue || !workflowQueue.includes(workflowId)) return;

        // 执行前从存储回读最新流程定义：
        // 已删除、已禁用的流程不再用运行中的旧对象重跑
        const { workflows } = await browser.storage.local.get('workflows');
        const latestWorkflow = Array.isArray(workflows)
          ? workflows.find((workflow) => workflow.id === workflowId)
          : (workflows || {})[workflowId];

        const queueIndex = workflowQueue.indexOf(workflowId);

        if (!latestWorkflow || latestWorkflow.isDisabled) {
          if (queueIndex !== -1) {
            workflowQueue.splice(queueIndex, 1);

            await browser.storage.local.set({ workflowQueue });
          }

          return;
        }

        const { states } = this;
        states.pendingExecutions = (states.pendingExecutions || 0) + 1;

        // 先移除队列项再启动执行，避免执行期间又读到同一项
        if (queueIndex !== -1) workflowQueue.splice(queueIndex, 1);

        await browser.storage.local.set({ workflowQueue });

        const engine = new WorkflowEngine(latestWorkflow, {
          logger: this.logger,
          states: this.states,
          blocksHandler: this.blocksHandler,
        });
        engine
          .init()
          .finally(() => {
            states.pendingExecutions -= 1;
          })
          .catch((error) => console.error(error));
      });

    self.__automaQueueLock = task;

    await task;
  }

  async destroyWorker(workerId) {
    // is last worker
    if (this.workers.size === 1 && this.workers.has(workerId)) {
      this.addLogHistory({
        type: 'finish',
        name: 'finish',
      });
      this.dispatchEvent('finish');
      await this.destroy('success');
    }
    // wait detach debugger
    this.workers.delete(workerId);
  }

  async destroy(status, message, blockDetail) {
    if (this.isDestroyed) return;
    // 先置销毁标记：等锁/等消息的路径据此退出，不会出现销毁后的迟到执行
    this.isDestroyed = true;

    // 通知内容脚本取消本执行在各标签页的进行中操作
    this.contentExecutionTabs.forEach((tabId) => {
      browser.tabs
        .sendMessage(tabId, {
          type: 'cancel-workflow-execution',
          executionId: this.id,
        })
        .catch(() => {});
    });
    this.contentExecutionTabs.clear();

    // 捕获 states 引用：cleanUp 之后仍要在 finally 里递减执行计数
    const statesRef = this.states;
    // 销毁期间的执行计数占位，防止新的执行在销毁过程中启动
    statesRef.pendingExecutions = (statesRef.pendingExecutions || 0) + 1;

    const cleanUp = () => {
      this.id = null;
      this.states = null;
      this.logger = null;
      this.saveLog = null;
      this.workflow = null;
      this.blocksHandler = null;
      this.parentWorkflow = null;

      this.isDestroyed = true;
      this.referenceData = null;
      this.eventListeners = null;
      this.packagesCache = null;
      this.extractedGroup = null;
      this.connectionsMap = null;
      this.waitConnections = null;
      this.blocks = null;
      this.history = null;
      this.columnsId = null;
      this.historyCtxData = null;
      this.preloadScripts = null;
    };

    try {
      // 归属并停止全部子引擎，取消时不留迟到执行或空快照提交
      for (const child of Array.from(this.childEngines?.values() || [])) {
        await child.stop();
      }
      this.childEngines?.clear();

      if (this.isUsingProxy) browser.proxy.settings.clear({});
      if (this.workflow.settings.debugMode && BROWSER_TYPE === 'chrome') {
        chrome.debugger.onEvent.removeListener(this.onDebugEvent);

        await sleep(1000);

        this.workers.forEach((worker) => {
          if (!worker.debugAttached) return;

          chrome.debugger.detach({ tabId: worker.activeTab.id });
        });
      }

      const endedTimestamp = Date.now();
      this.workers.clear();
      this.executeQueue().catch((error) => console.error(error));

      this.states.off('stop', this.onWorkflowStopped);
      this.states.off('resume', this.onResumeExecution);
      await this.states.delete(this.id);

      if (this.workflow.settings.reuseLastState) {
        const workflowState = {
          [`state:${this.workflow.id}`]: {
            columns: this.columns,
            referenceData: {
              table: this.referenceData.table,
              variables: this.referenceData.variables,
            },
          },
        };

        browser.storage.local
          .set(workflowState)
          .catch((error) =>
            console.error(
              '保存 reuseLastState 状态失败（下次执行将使用新状态）:',
              error
            )
          );
      } else if (status === 'success') {
        clearCache(this.workflow);
      }

      const { table, variables } = this.referenceData;
      // 仅在本次执行实际加载过关联表时才提交，共享祖先表时由祖先负责
      const tableId = this.__tableLoaded ? this.workflow.connectedTable : null;

      // 共享祖先表：把本执行的表格与列索引写回祖先引擎
      if (this.__tableParent && !this.__tableParent.isDestroyed) {
        this.__tableParent.referenceData.table = table;
        this.__tableParent.columns = this.columns;
      }

      // Merge all table and variables from all workflows
      Object.values(this.referenceData.workflow || {}).forEach((data) => {
        Object.assign(table, data.table);
        Object.assign(variables, data.variables);
      });

      await (async () => {
        if (!tableId) return;

        // 提交时重新取表格锁，并与存储中的最新数据合并：
        // 保留执行期间用户或其他上下文对已有行的修改，只追加本执行新增的行，
        // 避免用执行开始时的快照整表回写、覆盖刚做的编辑
        const locks =
          self.__automaTableLocks || (self.__automaTableLocks = new Map());
        const previous = locks.get(tableId) || Promise.resolve();
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        const tail = previous.then(() => gate);
        locks.set(tableId, tail);
        tail.then(() => {
          if (locks.get(tableId) === tail) locks.delete(tableId);
        });

        try {
          await previous;
          await dbStorage.transaction(
            'rw',
            dbStorage.tablesItems,
            dbStorage.tablesData,
            async () => {
              const current = await dbStorage.tablesData
                .where('tableId')
                .equals(tableId)
                .first();

              const baseItems = this.__tableBaseItems || [];
              const appended =
                Array.isArray(table) && table.length > baseItems.length
                  ? table.slice(baseItems.length)
                  : [];
              const mergedItems = [
                ...((current && current.items) || []),
                ...appended,
              ];
              const mergedColumns = {
                ...((current && current.columnsIndex) || {}),
              };
              Object.keys(this.columns || {}).forEach((key) => {
                if (!(key in mergedColumns))
                  mergedColumns[key] = this.columns[key];
              });

              await dbStorage.tablesItems.update(tableId, {
                modifiedAt: Date.now(),
                rowsCount: mergedItems.length,
              });
              await dbStorage.tablesData
                .where('tableId')
                .equals(tableId)
                .modify({ items: mergedItems, columnsIndex: mergedColumns });
            }
          );
        } catch (commitError) {
          // 表格提交失败（如存储配额耗尽、数据库连接关闭）不能阻断执行生命周期：
          // 子流程的父流程通过 destroyed 事件接收结束通知，丢失会导致父流程永久等待
          console.error('提交表格数据失败（不影响执行结束通知）:', commitError);
        } finally {
          release();
        }
      })();

      if (!this.workflow?.isTesting) {
        const { name, id, teamId } = this.workflow;

        // 日志持久化失败（如存储额度不足、数据库关闭）不能阻断执行生命周期：
        // 子流程的父流程通过 destroyed 事件接收结束通知，丢失会导致父流程永久等待
        try {
          await this.logger.add({
            detail: {
              name,
              status,
              teamId,
              message,
              id: this.id,
              workflowId: id,
              saveLog: this.saveLog,
              endedAt: endedTimestamp,
              parentLog: this.parentWorkflow,
              startedAt: this.startedTimestamp,
            },
            history: {
              logId: this.id,
              data: this.saveLog ? this.history : [],
            },
            ctxData: {
              logId: this.id,
              data: {
                ctxData: this.historyCtxData,
                dataSnapshot: this.refDataSnapshots,
              },
            },
            data: {
              logId: this.id,
              data: {
                table: [...this.referenceData.table],
                variables: { ...this.referenceData.variables },
              },
            },
          });
        } catch (logError) {
          console.error('写入执行日志失败（不影响执行结束通知）:', logError);
        }
      }

      this.dispatchEvent('destroyed', {
        status,
        message,
        blockDetail,
        id: this.id,
        endedTimestamp,
        history: this.history,
        startedTimestamp: this.startedTimestamp,
      });

      cleanUp();
    } catch (error) {
      console.error(error);
      cleanUp();
    } finally {
      statesRef.pendingExecutions -= 1;

      // 兜底释放仍持有的表格锁（如加载中途返回）
      if (typeof this.__releaseTableLock === 'function') {
        this.__releaseTableLock();
        this.__releaseTableLock = null;
      }
    }
  }

  async updateState(data) {
    const state = {
      ...data,
      tabIds: [],
      currentBlock: [],
      name: this.workflow.name,
      logs: this.history,
      ctxData: {
        ctxData: this.historyCtxData,
        dataSnapshot: this.refDataSnapshots,
      },
      startedTimestamp: this.startedTimestamp,
    };

    this.workers.forEach((worker) => {
      const { id, label, startedAt } = worker.currentBlock;

      state.currentBlock.push({ id, name: label, startedAt });
      state.tabIds.push(worker.activeTab.id);
    });

    await this.states.update(this.id, { state });
    this.dispatchEvent('update', { state });
  }

  dispatchEvent(name, params) {
    const listeners = this.eventListeners[name];

    if (!listeners) return;

    listeners.forEach((callback) => {
      callback(params);
    });
  }

  on(name, listener) {
    (this.eventListeners[name] = this.eventListeners[name] || []).push(
      listener
    );
  }
}

export default WorkflowEngine;
