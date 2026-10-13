/**
 * 工作流数据校验（成品包后台/newtab 模块 12319 反移植，两份内容相同）
 *
 * 导出：
 * - validateWorkflowData(workflow)：工作流执行前校验，数据无效或包含云端节点时抛错
 * - collectUnsupportedBlocks(workflow)：递归收集离线版不支持的云端节点
 */

/* eslint-disable no-use-before-define */

// 离线版不支持的云端节点 label
const cloudBlockLabels = [
  'google-sheets',
  'google-sheets-drive',
  'google-drive',
];

/**
 * 递归收集工作流中离线版不支持的节点
 * @param {any} workflow 工作流对象、drawflow 数据或保存的块数据（可为 JSON 字符串）
 * @returns {{ id: any, label: string }[]} 不支持节点列表
 */
function visitWorkflow(workflow, blocks, visited) {
  if (typeof workflow === 'string') {
    try {
      workflow = JSON.parse(workflow);
    } catch {
      return;
    }
  }

  if (!workflow || typeof workflow !== 'object' || visited.has(workflow))
    return;
  visited.add(workflow);

  // 旧格式为 nodes 数组，新格式为 drawflow.Home.data 字典
  const nodes =
    workflow.nodes || Object.values(workflow.drawflow?.Home?.data || {});
  if (Array.isArray(nodes)) {
    nodes.forEach((node) => visitNode(node, blocks, visited));
  }
}

function visitNode(node, blocks, visited) {
  if (!node || typeof node !== 'object') return;

  const label = node.label || node.name || node.id;

  if (cloudBlockLabels.includes(label)) {
    blocks.push({ id: node.id || node.itemId, label });
  }

  // export-data / loop-data 使用 google-sheets 数据源时同样不支持
  if (
    (label === 'export-data' && node.data?.dataToExport === 'google-sheets') ||
    (label === 'loop-data' && node.data?.loopThrough === 'google-sheets')
  ) {
    blocks.push({ id: node.id, label: 'google-sheets 数据源' });
  }

  if (label === 'blocks-group') {
    (node.data?.blocks || []).forEach((block) =>
      visitNode(block, blocks, visited)
    );
  }

  if (label === 'block-package') {
    visitWorkflow(node.data?.data, blocks, visited);
  }
}

export function collectUnsupportedBlocks(workflow) {
  const blocks = [];
  const visited = new Set();

  visitWorkflow(
    workflow?.drawflow || workflow?.data || workflow,
    blocks,
    visited
  );

  return blocks;
}

export function validateWorkflowData(workflow) {
  if (!workflow || typeof workflow.name !== 'string' || !workflow.drawflow) {
    throw new Error('工作流数据无效，无法执行');
  }

  const unsupportedBlocks = collectUnsupportedBlocks(workflow);
  if (unsupportedBlocks.length > 0) {
    const labels = [
      ...new Set(unsupportedBlocks.map((block) => block.label)),
    ].join('、');
    throw new Error(
      `此离线版不支持云端节点：${labels}。原数据已保留，请删除或替换这些节点后再执行。`
    );
  }

  let { drawflow } = workflow;
  if (typeof drawflow === 'string') {
    try {
      drawflow = JSON.parse(drawflow);
    } catch {
      throw new Error('工作流节点数据无效，无法执行');
    }
  }

  // drawflow 新格式：drawflow.Home.data 为非空对象时直接通过
  const homeData = drawflow?.drawflow?.Home?.data;
  if (
    homeData &&
    typeof homeData === 'object' &&
    Object.keys(homeData).length
  ) {
    return;
  }

  if (
    !Array.isArray(drawflow?.nodes) ||
    drawflow.nodes.length === 0 ||
    !Array.isArray(drawflow.edges)
  ) {
    throw new Error('工作流缺少有效的节点或连接，无法执行');
  }

  const nodeIds = new Set(drawflow.nodes.map((node) => String(node?.id)));
  if (
    nodeIds.size !== drawflow.nodes.length ||
    drawflow.nodes.some(
      (node) => !node?.id || typeof node.label !== 'string'
    ) ||
    drawflow.edges.some(
      (edge) =>
        !edge ||
        !nodeIds.has(String(edge.source)) ||
        !nodeIds.has(String(edge.target))
    )
  ) {
    throw new Error('工作流节点 ID 或连接引用无效，无法执行');
  }
}
