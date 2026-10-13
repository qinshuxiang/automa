import { parseJSON } from '@/utils/helper';
import {
  InsertDataError,
  normalizeInsertItem,
  readInsertFile,
  parseInsertData,
  INSERT_DATA_PHASE,
} from '@/utils/insertData';
import renderString from '../templating/renderString';

async function insertData({ id, data }, { refData }) {
  const replacedValueList = {};

  for (const [itemIndex, rawItem] of data.dataList.entries()) {
    // 目标类型先校验再归一化：非法显式类型直接报错，不再静默按 table 写入
    if (
      rawItem.type != null &&
      rawItem.type !== 'table' &&
      rawItem.type !== 'variable'
    ) {
      throw new InsertDataError('导入目标类型无效', {
        code: 'INVALID_TARGET_TYPE',
        itemIndex,
        phase: INSERT_DATA_PHASE.WRITE,
      });
    }

    const { item, warnings: normalizedWarnings } = normalizeInsertItem(rawItem);
    let value = '';

    if (item.isFile) {
      const renderedPath = await renderString(
        item.filePath || '',
        refData,
        this.engine.isPopup
      );
      const filePath =
        typeof renderedPath === 'string' ? renderedPath : renderedPath.value;
      Object.assign(
        replacedValueList,
        typeof renderedPath === 'string' ? {} : renderedPath.list || {}
      );

      if (!filePath || !filePath.trim()) {
        throw new InsertDataError('文件路径为空', {
          code: 'EMPTY_PATH',
          itemIndex,
          phase: INSERT_DATA_PHASE.LOAD,
        });
      }

      const normalizedItem = { ...item, filePath };
      const readResult = await readInsertFile(filePath, normalizedItem, {
        itemIndex,
      });
      const {
        value: parsedValue,
        metadata,
        warnings,
      } = await parseInsertData(readResult, normalizedItem, {
        itemIndex,
        purpose: 'execute',
      });

      [...normalizedWarnings, ...warnings].forEach((warning) => {
        console.warn('[插入数据]', warning.code, warning.message, {
          itemIndex,
          sheet: metadata.sheet,
          format: metadata.format,
        });
      });

      value = parsedValue;
    } else {
      const renderedValue = await renderString(
        item.value ?? '',
        refData,
        this.engine.isPopup
      );
      const renderedText =
        typeof renderedValue === 'string' ? renderedValue : renderedValue.value;
      value = parseJSON(renderedText ?? '', renderedText ?? '');
      Object.assign(
        replacedValueList,
        typeof renderedValue === 'string' ? {} : renderedValue.list || {}
      );
    }

    if (item.type === 'table') {
      const values = typeof value === 'string' ? value.split('||') : [value];
      values.forEach((tableValue) => {
        this.addDataToColumn(item.name, tableValue);
      });
    } else {
      const renderedName = await renderString(
        item.name ?? '',
        refData,
        this.engine.isPopup
      );
      const variableName =
        typeof renderedName === 'string' ? renderedName : renderedName.value;

      if (!variableName || !variableName.trim()) {
        throw new InsertDataError('变量名称为空', {
          code: 'EMPTY_NAME',
          itemIndex,
          phase: INSERT_DATA_PHASE.WRITE,
        });
      }

      await this.setVariable(variableName, value);
    }
  }

  return {
    data: '',
    replacedValue: replacedValueList,
    nextBlockId: this.getBlockConnections(id),
  };
}

export default insertData;
