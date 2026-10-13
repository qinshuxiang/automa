import browser from 'webextension-polyfill';
import { isWhitespace, parseJSON } from '@/utils/helper';
import decryptFlow, { getWorkflowPass } from '@/utils/decryptFlow';
import convertWorkflowData from '@/utils/convertWorkflowData';
import { validateWorkflowData } from '@/utils/workflowValidation';
import { nanoid } from 'nanoid';
import WorkflowEngine from '../WorkflowEngine';

function workflowListener(workflow, options) {
  return new Promise((resolve, reject) => {
    const engine = new WorkflowEngine(workflow, options);
    engine.on('destroyed', ({ id, status, message }) => {
      options.events.onDestroyed(engine);

      if (status === 'error') {
        const error = new Error(message);
        error.data = { logId: id };

        reject(error);
        return;
      }

      resolve({ id, status, message });
    });

    options.events.onInit(engine);

    options.states.pendingExecutions =
      (options.states.pendingExecutions || 0) + 1;
    engine.init().finally(() => {
      options.states.pendingExecutions -= 1;
    });
  });
}

function findWorkflow(workflows, workflowId) {
  const workflow = Array.isArray(workflows)
    ? workflows.find(({ id }) => id === workflowId)
    : workflows[workflowId];

  return workflow;
}

async function executeWorkflow({ id: blockId, data }, { refData }) {
  if (data.workflowId === '') throw new Error('empty-workflow');

  const { workflows = {} } = await browser.storage.local.get('workflows');
  let workflow = findWorkflow(workflows, data.workflowId);

  if (!workflow) {
    const errorInstance = new Error('no-workflow');
    errorInstance.data = { workflowId: data.workflowId };

    throw errorInstance;
  }

  if (workflow.isDisabled) {
    throw new Error('子工作流已禁用，无法执行');
  }

  if (workflow.isProtected) {
    const pass = getWorkflowPass(workflow.pass);
    const decryptedFlow = decryptFlow(workflow, pass);

    if (decryptedFlow?.isError) {
      throw new Error('受保护子工作流解密失败');
    }

    workflow = {
      ...workflow,
      drawflow: parseJSON(decryptedFlow, decryptedFlow),
    };
  }

  validateWorkflowData(workflow);

  workflow = convertWorkflowData(workflow);
  if (
    !Array.isArray(workflow.drawflow?.nodes) ||
    !workflow.drawflow.nodes.some((node) => node.label === 'trigger')
  ) {
    throw new Error('子工作流缺少有效的触发节点');
  }

  const optionsParams = { variables: {} };

  if (workflow.testingMode) workflow.testingMode = false;

  if (data.insertAllGlobalData) {
    optionsParams.globalData = refData.globalData;
  }

  if (!isWhitespace(data.globalData)) {
    // shallow copy
    optionsParams.globalData = {
      ...optionsParams.globalData,
      ...JSON.parse(data.globalData),
    };
  }

  if (data.insertAllVars) {
    optionsParams.variables = JSON.parse(
      JSON.stringify(this.engine.referenceData.variables)
    );
  } else if (data.insertVars) {
    const varsName = data.insertVars.split(',');
    varsName.forEach((name) => {
      const varName = name.trim();
      const value = this.engine.referenceData.variables[varName];

      // 仅跳过 undefined：0 与 "" 等 falsy 值同样是有效变量值，需要传递
      if (value === undefined) return;

      optionsParams.variables[varName] = value;
    });
  }

  const options = {
    options: {
      data: optionsParams,
      parentWorkflow: {
        id: this.engine.id,
        name: this.engine.workflow.name,
      },
    },
    events: {
      onInit: (engine) => {
        this.childWorkflowId = engine.id;

        // 子执行 ID 注册到引擎：Engine.stop 遍历停止全部子执行
        if (!this.engine.childExecutions) {
          this.engine.childExecutions = new Set();
        }
        this.engine.childExecutions.add(engine.id);

        if (!this.engine.childEngines) {
          this.engine.childEngines = new Map();
        }
        this.engine.childEngines.set(engine.id, engine);
      },
      onDestroyed: (engine) => {
        if (this.engine.childExecutions) {
          this.engine.childExecutions.delete(engine.id);
        }
        if (this.engine.childEngines) {
          this.engine.childEngines.delete(engine.id);
        }

        // 引擎销毁后 referenceData 可能已清空，判空防御
        if (!this.engine.referenceData) return;

        this.engine.referenceData.workflow[
          data.executeId || `${engine.id}-${nanoid(8)}`
        ] = {
          table: engine.referenceData.table,
          variables: engine.referenceData.variables,
        };
      },
    },
    states: this.engine.states,
    logger: this.engine.logger,
    blocksHandler: this.engine.blocksHandler,
  };

  // 沿 parentTableEngine 与 parentWorkflow→states 两条祖先链收集全部祖先工作流 ID：
  // A→B→C→A 这类多层环同样会被拒绝（原仅检查直接父级，只能挡住两环）
  const ancestors = new Set();
  const seen = new Set();
  let { engine } = this;
  while (engine && !seen.has(engine)) {
    seen.add(engine);
    ancestors.add(engine.workflow?.id);
    engine = engine.parentTableEngine;
  }

  const workflowStates = this.engine.states?.states;
  let parentStateId = this.engine.parentWorkflow?.id;
  while (parentStateId && workflowStates && !seen.has(parentStateId)) {
    seen.add(parentStateId);
    const parentState = workflowStates.get(parentStateId);
    if (!parentState) break;

    ancestors.add(parentState.workflowId);
    parentStateId = parentState.parentState?.id;
  }

  if (ancestors.has(workflow.id)) {
    throw new Error('workflow-infinite-loop');
  }

  const result = await workflowListener(workflow, options);

  return {
    data: '',
    logId: result.id,
    nextBlockId: this.getBlockConnections(blockId),
  };
}

export default executeWorkflow;
