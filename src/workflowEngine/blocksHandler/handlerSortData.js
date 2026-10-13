import { objectHasKey } from '@/utils/helper';

export async function sliceData({ id, data }) {
  let dataToSort = null;

  if (data.dataSource === 'table') {
    dataToSort = this.engine.referenceData.table;
  } else if (data.dataSource === 'variable') {
    const { variables } = this.engine.referenceData;

    if (!objectHasKey(variables, data.varSourceName)) {
      throw new Error(`未找到变量“${data.varSourceName}”`);
    }

    dataToSort = variables[data.varSourceName];
  }

  if (!Array.isArray(dataToSort)) {
    const dataType = dataToSort === null ? 'null' : typeof dataToSort;

    throw new Error(`无法对“${dataType}”类型的数据进行排序`);
  }

  const getComparisonValue = ({ itemA, itemB, order = 'asc' }) => {
    let comparison = 0;

    if (itemA > itemB) {
      comparison = 1;
    } else if (itemA < itemB) {
      comparison = -1;
    }

    return order === 'desc' ? comparison * -1 : comparison;
  };
  const sortedArray = dataToSort.sort((a, b) => {
    let comparison = 0;

    if (data.sortByProperty) {
      // 多字段排序：首个非零比较结果生效，不再被后续字段覆盖
      data.itemProperties.forEach(({ name, order }) => {
        if (comparison !== 0) return;

        comparison = getComparisonValue({
          order,
          itemA: a[name] ?? a,
          itemB: b[name] ?? b,
        });
      });
    } else {
      comparison = getComparisonValue({
        itemA: a,
        itemB: b,
      });
    }

    return comparison;
  });

  // 嵌套/持久变量（$$ 前缀）排序结果写回存储
  if (data.dataSource === 'variable' && data.varSourceName.startsWith('$')) {
    await this.setVariable(data.varSourceName, sortedArray);
  }
  if (data.assignVariable) {
    await this.setVariable(data.variableName, sortedArray);
  }
  if (data.saveData) {
    this.addDataToColumn(data.dataColumn, sortedArray);
  }

  return {
    data: sortedArray,
    nextBlockId: this.getBlockConnections(id),
  };
}

export default sliceData;
