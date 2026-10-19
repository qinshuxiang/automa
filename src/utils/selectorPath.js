// 只在引号、括号与属性表达式之外识别扩展路径分隔符。
// CSS 属性值中的 >> / |> 是普通文本，不能参与 iframe/Shadow 路由。
export function splitSelectorPath(selector, delimiter) {
  const parts = [];
  let start = 0;
  let quote = '';
  let depth = 0;
  let escaped = false;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (escaped) {
      escaped = false;
    } else if (char === '\\') {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[' || char === '(') {
      depth += 1;
    } else if (char === ']' || char === ')') {
      depth -= 1;
    } else if (depth === 0 && selector.startsWith(delimiter, index)) {
      parts.push(selector.slice(start, index).trim());
      index += delimiter.length - 1;
      start = index + 1;
    }
  }
  parts.push(selector.slice(start).trim());
  return parts;
}
