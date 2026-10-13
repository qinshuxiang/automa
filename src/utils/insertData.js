import { read as readXlsx, utils as utilsXlsx } from 'xlsx';
import Papa from 'papaparse';
import getFile, { readFileAsBase64 } from '@/utils/getFile';

export const INSERT_DATA_PHASE = {
  LOAD: 'load',
  PARSE: 'parse',
  CONVERT: 'convert',
  WRITE: 'write',
};

export const INSERT_DATA_ACTIONS = ['default', 'base64', 'json', 'json-header'];

// 预览读取的行/列/字符上限
export const previewLimits = {
  rows: 100,
  columns: 50,
  chars: 2e5,
};

export class InsertDataError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = 'InsertDataError';
    this.code = options.code || 'INSERT_DATA_ERROR';
    this.itemIndex = options.itemIndex ?? null;
    this.sourceKind = options.sourceKind ?? null;
    this.format = options.format ?? null;
    this.action = options.action ?? null;
    this.sheet = options.sheet ?? null;
    this.range = options.range ?? null;
    this.phase = options.phase || INSERT_DATA_PHASE.PARSE;
    this.data = {
      code: this.code,
      itemIndex: this.itemIndex,
      sourceKind: this.sourceKind,
      format: this.format,
      action: this.action,
      sheet: this.sheet,
      range: this.range,
      phase: this.phase,
    };
  }
}

// 归一化数据项：动作白名单校验 + 目标类型/文件类型默认值
export function normalizeInsertItem(item = {}) {
  const warnings = [];
  const action = item.action || item.csvAction || 'default';

  let normalizedAction = action;
  if (typeof action !== 'string' || !INSERT_DATA_ACTIONS.includes(action)) {
    normalizedAction = 'default';
    warnings.push({
      code: 'INVALID_ACTION',
      message: `动作“${String(action)}”无效，已按“默认”处理`,
    });
  }

  return {
    item: {
      type: item.type === 'variable' ? 'variable' : 'table',
      name: item.name || '',
      value: item.value ?? '',
      isFile: Boolean(item.isFile),
      filePath: item.filePath ?? '',
      fileType: ['excel', 'csv'].includes(item.fileType)
        ? item.fileType
        : 'auto',
      action: normalizedAction,
      xlsSheet: item.xlsSheet ?? '',
      xlsRange: item.xlsRange ?? '',
    },
    warnings,
  };
}

// 从路径识别来源与格式：HTTP(S) 走 URL 路径名，本地路径取末段文件名
function detectInsertFileType(path) {
  const result = {
    sourceKind: 'local',
    format: 'unknown',
    fileName: '',
    extension: '',
  };

  if (typeof path !== 'string' || !path.trim()) return result;

  let fileName = '';
  if (/^https?:\/\//i.test(path)) {
    result.sourceKind = 'http';

    try {
      const { pathname } = new URL(path);
      fileName = pathname.split('/').pop() || '';
    } catch {
      return result;
    }
  } else {
    fileName = path.split(/[\\/]/).pop() || '';
  }

  result.fileName = fileName;

  const extensionMatch = /\.([A-Za-z0-9]+)$/.exec(fileName);
  if (!extensionMatch) return result;

  const extension = extensionMatch[1].toLowerCase();
  result.extension = extension;

  if (extension === 'xlsx' || extension === 'xls') result.format = 'excel';
  else if (extension === 'csv') result.format = 'csv';
  else if (extension === 'json') result.format = 'json';

  return result;
}

// 显式选择的文件类型（auto/excel/csv）覆盖路径识别结果
export function resolveInsertFileType(path, options = {}) {
  const result = detectInsertFileType(path);

  if (options.fileType === 'excel' || options.fileType === 'csv') {
    result.format = options.fileType;
  }

  return result;
}

export function isExcelFile(path, options = {}) {
  return resolveInsertFileType(path, options).format === 'excel';
}

export function isCsvOrExcelFile(path, options = {}) {
  const { format } = resolveInsertFileType(path, options);

  return format === 'excel' || format === 'csv';
}

// 单元格范围校验：A1 / A1:C10（可带 $），列不超过 XFD、行不超过 1048576
export function isValidCellRange(range) {
  if (typeof range !== 'string') return false;

  const parts = range.trim().split(':');
  if (parts.length > 2) return false;

  const parsed = parts.map((part) => {
    const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(part);
    if (!match) return null;

    let col = 0;
    for (const char of match[1].toUpperCase()) {
      col = 26 * col + char.charCodeAt(0) - 64;
    }

    const row = Number(match[2]);

    return col <= 16384 && row <= 1048576 ? { col, row } : null;
  });

  if (parsed.some((cell) => !cell)) return false;
  if (parsed.length === 1) return true;

  return parsed[0].col <= parsed[1].col && parsed[0].row <= parsed[1].row;
}

// 读取文件内容：json 格式直接解析，其余按动作决定 text/blob
export async function readInsertFile(path, item, options = {}) {
  const { action } = item;
  const { format, sourceKind } = resolveInsertFileType(path, item);
  const getFileFn = options.getFile || getFile;

  let responseType = 'text';
  if (action === 'base64' || (format === 'excel' && action !== 'default')) {
    responseType = 'blob';
  }

  try {
    const result = await getFileFn(path, {
      responseType,
      returnValue: true,
      signal: options.signal,
    });

    if (format === 'json' && action !== 'base64') {
      try {
        return JSON.parse(result);
      } catch {
        throw new InsertDataError('JSON 文件解析失败，内容不是有效的 JSON', {
          code: 'JSON_PARSE_FAILED',
          itemIndex: options.itemIndex ?? null,
          sourceKind,
          format,
          action,
          phase: INSERT_DATA_PHASE.PARSE,
        });
      }
    }

    return result;
  } catch (error) {
    if (error instanceof InsertDataError) throw error;

    throw new InsertDataError(error?.message || '文件读取失败', {
      code: 'LOAD_FAILED',
      itemIndex: options.itemIndex ?? null,
      sourceKind,
      format,
      action,
      phase: INSERT_DATA_PHASE.LOAD,
    });
  }
}

function toUint8Array(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  return null;
}

// 预览时按列上限裁剪每一行（数组按元素、对象按键）
function truncateColumns(rows, maxColumns, metadata) {
  if (!Array.isArray(rows)) return rows;

  let truncated = false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];

    if (Array.isArray(row)) {
      if (row.length > maxColumns) {
        rows[index] = row.slice(0, maxColumns);
        truncated = true;
      }
    } else if (row && typeof row === 'object') {
      const keys = Object.keys(row);
      if (keys.length > maxColumns) {
        const nextRow = {};
        keys.slice(0, maxColumns).forEach((key) => {
          nextRow[key] = row[key];
        });
        rows[index] = nextRow;
        truncated = true;
      }
    }
  }

  if (truncated && metadata.truncated) metadata.truncated.columns = true;

  return rows;
}

function rangeStartRow(range) {
  if (typeof range !== 'string') return null;

  const match =
    /^\$?[A-Za-z]{1,3}\$?(\d{1,7})(?::\$?[A-Za-z]{1,3}\$?\d{1,7})?$/.exec(
      range.trim()
    );
  if (!match) return null;

  const row = parseInt(match[1], 10);

  return row > 0 ? row : null;
}

// 预览时把范围结束行钳制到已读取的行数，避免读取不存在的行
function clampRangeToRows(range, sheetRows) {
  if (typeof range !== 'string') return null;

  const parts = range.split(':');
  const cellRegex = /^\$?[A-Za-z]{1,3}\$?(\d{1,7})$/;

  const startMatch = cellRegex.exec(parts[0].trim());
  if (!startMatch) return null;

  const startRow = parseInt(startMatch[1], 10);
  if (startRow > sheetRows) return null;
  if (parts.length === 1) return parts[0].trim();

  const endMatch = cellRegex.exec(parts[1].trim());
  if (!endMatch) return null;

  const endRow = Math.min(parseInt(endMatch[1], 10), sheetRows);
  if (endRow < startRow) return null;

  return `${parts[0]}:${parts[1].replace(/\d+$/, String(endRow))}`;
}

// 解析读取结果：JSON 直通 / CSV 解析 / Excel 转换，预览模式带截断与警告
export async function parseInsertData(input, item, options = {}) {
  const normalizedItem = {
    ...item,
    xlsRange: (item.xlsRange || '').trim(),
  };
  const { action } = normalizedItem;
  const { format, sourceKind } = resolveInsertFileType(
    normalizedItem.filePath,
    normalizedItem
  );

  // 范围仅适用于 Excel + json/json-header，隐藏的旧范围不再阻止其他动作
  const cellRange =
    format === 'excel' && ['json', 'json-header'].includes(action)
      ? normalizedItem.xlsRange
      : '';
  if (cellRange && !isValidCellRange(cellRange)) {
    throw new InsertDataError(`单元格范围“${cellRange}”无效（示例：A1:C10）`, {
      code: 'INVALID_CELL_RANGE',
      itemIndex: options.itemIndex ?? null,
      phase: INSERT_DATA_PHASE.PARSE,
      sourceKind,
      format,
      action,
      range: cellRange,
    });
  }

  const warnings = [];
  const isPreview = options.purpose === 'preview';
  const limits = { ...previewLimits, ...(options.limits || {}) };
  const metadata = {
    sourceKind,
    format,
    action,
    sheet: null,
    sheetFallback: false,
    range: null,
    decodeMode: null,
    previewRows: null,
    truncated: null,
  };
  const errorContext = {
    itemIndex: options.itemIndex ?? null,
    sourceKind,
    format,
    action,
  };

  if (action === 'base64') {
    const readBase64 = options.readFileAsBase64 || readFileAsBase64;
    if (typeof readBase64 !== 'function') {
      throw new InsertDataError('Base64 读取能力不可用', {
        code: 'BASE64_UNAVAILABLE',
        ...errorContext,
        phase: INSERT_DATA_PHASE.CONVERT,
      });
    }

    let base64;
    try {
      base64 = await readBase64(input);
    } catch (error) {
      throw new InsertDataError(error?.message || 'Base64 读取失败', {
        code: 'BASE64_READ_FAILED',
        ...errorContext,
        phase: INSERT_DATA_PHASE.CONVERT,
      });
    }

    return { value: base64, metadata, warnings };
  }

  if (format === 'json') {
    if (isPreview && Array.isArray(input)) {
      const rowsTruncated = input.length > limits.rows;
      const value = input.slice(0, limits.rows);

      metadata.previewRows = limits.rows;
      metadata.truncated = {
        rows: rowsTruncated,
        columns: false,
        rowsKnown: !rowsTruncated,
      };

      return {
        value: truncateColumns(value, limits.columns, metadata),
        metadata,
        warnings,
      };
    }

    return { value: input, metadata, warnings };
  }

  if (format === 'csv' && (action === 'json' || action === 'json-header')) {
    const papa = options.Papa || Papa;
    const parseOptions = { header: action === 'json-header' };

    if (isPreview) {
      parseOptions.preview = limits.rows;
      metadata.previewRows = limits.rows;
      metadata.truncated = {
        rows: true,
        columns: false,
        rowsKnown: false,
      };
    }

    const parsed = papa.parse(String(input), parseOptions);

    (parsed.errors || []).forEach((error) => {
      warnings.push({
        code: 'CSV_PARSE_ERROR',
        message: `CSV 第 ${error.row ?? '未知'} 行解析出现问题：${
          error.message || error.code || '未知错误'
        }`,
        row: error.row ?? null,
        index: error.index ?? null,
        csvCode: error.code ?? null,
      });
    });

    const value = parsed.data || [];
    if (isPreview) truncateColumns(value, limits.columns, metadata);

    return { value, metadata, warnings };
  }

  if (format === 'excel' && (action === 'json' || action === 'json-header')) {
    const readBase64 = options.readFileAsBase64 || readFileAsBase64;
    const readWorkbook = options.readXlsx || readXlsx;
    const xlsxUtils = options.utilsXlsx || utilsXlsx;

    let bytes = toUint8Array(input);
    if (!bytes && input && typeof input.arrayBuffer === 'function') {
      try {
        bytes = toUint8Array(await input.arrayBuffer());
      } catch (error) {
        throw new InsertDataError(error?.message || 'Excel 文件读取失败', {
          ...errorContext,
          code: 'EXCEL_READ_FAILED',
          phase: INSERT_DATA_PHASE.CONVERT,
        });
      }
    }

    let workbookData;
    const workbookOptions = {};
    if (bytes) {
      workbookData = bytes;
      workbookOptions.type = 'array';
      metadata.decodeMode = 'array';
    } else {
      let base64;
      try {
        base64 = await readBase64(input);
      } catch (error) {
        throw new InsertDataError(error?.message || 'Excel 文件读取失败', {
          ...errorContext,
          code: 'EXCEL_READ_FAILED',
          phase: INSERT_DATA_PHASE.CONVERT,
        });
      }

      const base64Str = String(base64);
      workbookData = base64Str.slice(base64Str.indexOf(',') + 1);
      workbookOptions.type = 'base64';
      metadata.decodeMode = 'base64';
    }

    if (isPreview) {
      const headerOffset = action === 'json-header' ? 1 : 0;
      const startRow = rangeStartRow(normalizedItem.xlsRange) || 1;
      workbookOptions.sheetRows = startRow + limits.rows - 1 + headerOffset;
      metadata.previewRows = limits.rows;
      metadata.truncated = {
        rows: true,
        columns: false,
        rowsKnown: false,
      };
    }

    let workbook;
    try {
      workbook = readWorkbook(workbookData, workbookOptions);
    } catch (error) {
      throw new InsertDataError(error?.message || 'Excel 文件解析失败', {
        ...errorContext,
        code: 'EXCEL_PARSE_FAILED',
        phase: INSERT_DATA_PHASE.CONVERT,
      });
    }

    const inputtedSheet = (normalizedItem.xlsSheet || '').trim();
    let sheetName = '';
    if (inputtedSheet && workbook.SheetNames.includes(inputtedSheet)) {
      sheetName = inputtedSheet;
    } else if (inputtedSheet) {
      sheetName = workbook.SheetNames[0] || '';
      metadata.sheetFallback = true;
      warnings.push({
        code: 'SHEET_FALLBACK',
        message: `找不到工作表“${inputtedSheet}”，已回退到第一个工作表${
          sheetName ? `“${sheetName}”` : ''
        }`,
        sheet: inputtedSheet,
        fallbackSheet: sheetName || null,
      });
    } else {
      sheetName = workbook.SheetNames[0] || '';
    }

    metadata.sheet = sheetName || null;
    metadata.range = normalizedItem.xlsRange || null;

    let worksheet = sheetName ? workbook.Sheets[sheetName] : undefined;
    if (!worksheet) {
      throw new InsertDataError(
        workbook.SheetNames.length
          ? `无法读取工作表“${sheetName}”的数据`
          : '文件中没有可读取的工作表',
        {
          ...errorContext,
          code: 'NO_WORKSHEET',
          sheet: inputtedSheet || null,
          phase: INSERT_DATA_PHASE.PARSE,
        }
      );
    }

    // 未指定范围的预览：按 !ref 估算需要的行数，不足则扩大片段重读
    if (isPreview && !normalizedItem.xlsRange) {
      const ref = worksheet['!fullref'] || worksheet['!ref'];
      if (ref) {
        const { s } = xlsxUtils.decode_range(ref);
        const headerOffset = action === 'json-header' ? 1 : 0;
        const neededRows = s.r + limits.rows + headerOffset;

        if (neededRows > workbookOptions.sheetRows) {
          workbookOptions.sheetRows = neededRows;
          try {
            workbook = readWorkbook(workbookData, workbookOptions);
            worksheet = workbook.Sheets[sheetName];
          } catch (error) {
            throw new InsertDataError(error?.message || 'Excel 文件解析失败', {
              ...errorContext,
              code: 'EXCEL_PARSE_FAILED',
              sheet: sheetName,
              range: ref,
              phase: INSERT_DATA_PHASE.CONVERT,
            });
          }
        }
      }
    }

    const convertOptions = {};
    if (normalizedItem.xlsRange) convertOptions.range = normalizedItem.xlsRange;
    if (action !== 'json-header') convertOptions.header = 1;

    if (isPreview && convertOptions.range) {
      const clamped = clampRangeToRows(
        convertOptions.range,
        workbookOptions.sheetRows
      );
      if (!clamped) {
        return { value: [], metadata, warnings };
      }
      convertOptions.range = clamped;
    }

    let value;
    try {
      value = xlsxUtils.sheet_to_json(worksheet, convertOptions);
    } catch (error) {
      throw new InsertDataError(error?.message || 'Excel 数据转换失败', {
        ...errorContext,
        code: 'EXCEL_CONVERT_FAILED',
        sheet: metadata.sheet,
        range: normalizedItem.xlsRange || null,
        phase: INSERT_DATA_PHASE.CONVERT,
      });
    }

    if (isPreview) truncateColumns(value, limits.columns, metadata);

    return { value, metadata, warnings };
  }

  if (format === 'excel') {
    warnings.push({
      code: 'EXCEL_DEFAULT_TEXT',
      message: 'Excel 文件已按文本读取；如需解析为表格数据，请把动作改为“JSON”',
    });
  }

  return { value: input, metadata, warnings };
}

export default {
  INSERT_DATA_PHASE,
  INSERT_DATA_ACTIONS,
  previewLimits,
  InsertDataError,
  normalizeInsertItem,
  resolveInsertFileType,
  isExcelFile,
  isCsvOrExcelFile,
  isValidCellRange,
  readInsertFile,
  parseInsertData,
};
