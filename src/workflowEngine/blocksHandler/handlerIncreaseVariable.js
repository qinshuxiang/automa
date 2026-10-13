import objectPath from 'object-path';

export async function increaseVariable({ id, data }) {
  const refVariables = this.engine.referenceData.variables;
  const variableExist = objectPath.has(refVariables, data.variableName);

  if (!variableExist) {
    throw new Error(`未找到变量“${data.variableName}”`);
  }

  const currentVar = +objectPath.get(refVariables, data.variableName);
  if (Number.isNaN(currentVar)) {
    throw new Error(`变量“${data.variableName}”的值不是数字`);
  }

  const increasedValue = currentVar + data.increaseBy;

  objectPath.set(
    this.engine.referenceData.variables,
    data.variableName,
    increasedValue
  );

  // $$ 持久变量统一走 setVariable（写库 + 更新快照），
  // 否则下次执行会从存储里读到旧值
  if (
    data.variableName.startsWith('$$') &&
    typeof this.setVariable === 'function'
  ) {
    await this.setVariable(data.variableName, increasedValue);
  }

  return {
    // 嵌套路径（a.b.c）用同路径读取，普通下标访问会取到 undefined
    data: objectPath.get(
      this.engine.referenceData.variables,
      data.variableName
    ),
    nextBlockId: this.getBlockConnections(id),
  };
}

export default increaseVariable;
