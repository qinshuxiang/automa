import objectPath from 'object-path';

export async function sliceData({ id, data }) {
  const variable = objectPath.get(
    this.engine.referenceData.variables,
    data.variableName
  );
  const payload = {
    data: variable,
    nextBlockId: this.getBlockConnections(id),
  };

  if (!variable || !variable?.slice) return payload;

  let startIndex = 0;
  let endIndex = variable.length;

  if (data.startIdxEnabled) {
    startIndex = data.startIndex;
  }
  if (data.endIdxEnabled) {
    endIndex = data.endIndex;
  }

  const slicedVariable = variable.slice(startIndex, endIndex);
  payload.data = slicedVariable;
  objectPath.set(
    this.engine.referenceData.variables,
    data.variableName,
    slicedVariable
  );

  // $$ 前缀变量写回经 setVariable 持久化（截取后 $$ 变量不再丢更新），
  // 其余变量仅更新引用快照
  if (data.variableName.startsWith('$')) {
    await this.setVariable(
      data.variableName.split('.')[0],
      this.engine.referenceData.variables[data.variableName.split('.')[0]]
    );
  } else {
    this.engine.addRefDataSnapshot('variables');
  }

  return payload;
}

export default sliceData;
