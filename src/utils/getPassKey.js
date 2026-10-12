// 从现有成品包（Chromium90扩展）模块 52160 反提取的真实实现。
// 原包实现为固定密钥：忽略 scope 参数，统一返回同一密钥。
// 与官方源码的调用约定兼容（官方按 scope 传参，如 getPassKey('credential')）。
export default function getPassKey() {
  return 'beb1b4e0762ad5ddcc0dce752caab0ae7d1ee7311f3f6d3a62519efe197852f1';
}
