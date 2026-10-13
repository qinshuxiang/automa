import objectPath from 'object-path';

export async function regexVariable({ id, data }) {
  const refVariables = this.engine.referenceData.variables;
  const variableExist = objectPath.has(refVariables, data.variableName);

  if (!variableExist) {
    throw new Error(`未找到变量“${data.variableName}”`);
  }

  const str = objectPath.get(refVariables, data.variableName);
  if (typeof str !== 'string') {
    throw new Error(`变量“${data.variableName}”的值不是字符串／文本`);
  }

  const method = data.method || 'match';
  const regex = new RegExp(data.expression, data.flag.join(''));

  let newValue = '';

  if (method === 'match') {
    const matches = str.match(regex);
    newValue = matches && !data.flag.includes('g') ? matches[0] : matches;
  } else if (method === 'replace') {
    newValue = str.replace(regex, data.replaceVal ?? '');
  }

  objectPath.set(
    this.engine.referenceData.variables,
    data.variableName,
    newValue
  );

  // $$ 前缀变量写回经 setVariable 持久化（替换后 $$ 变量不再丢更新），
  // 其余变量仅更新引用快照
  if (data.variableName.startsWith('$')) {
    await this.setVariable(
      data.variableName.split('.')[0],
      this.engine.referenceData.variables[data.variableName.split('.')[0]]
    );
  } else {
    this.engine.addRefDataSnapshot('variables');
  }

  return {
    data: newValue,
    nextBlockId: this.getBlockConnections(id),
  };
}

export default regexVariable;
