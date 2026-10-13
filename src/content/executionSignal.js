// 每个工作流执行的取消信号注册表：
// contentScript 收到 cancel-workflow-execution 消息时中止对应执行的信号，
// 进行中的操作通过 checkExecutionSignal 提前退出
const signalRegistry = new Map();

export function getExecutionSignal(executionId) {
  if (!executionId) return undefined;

  if (!signalRegistry.has(executionId)) {
    signalRegistry.set(executionId, new AbortController());
  }

  return signalRegistry.get(executionId).signal;
}

export function abortExecutionSignal(executionId) {
  const signal = getExecutionSignal(executionId);

  if (signal && !signal.aborted) {
    signalRegistry.get(executionId).abort();
    // 保留一段时间，让迟到的检查也能感知中止，之后回收
    setTimeout(() => signalRegistry.delete(executionId), 310000);
  }
}

export function checkExecutionSignal(signal) {
  if (!signal?.aborted) return;

  const error = new Error('执行已停止');
  error.executionStopped = true;
  throw error;
}
