# 源码重建移植清单

分支：`uos-rebuild`（基线 v1.28.27 tag）
目标：源码构建产物与 `Chromium90扩展/` 成品包行为等价。

## 阶段 1：基础重建 ✅

- [x] 官方源码 + npm 构建（Node 22，`env -u NODE_OPTIONS npm run build`）
- [x] 分支 `uos-rebuild`，逐阶段提交
- [x] getPassKey 真实实现（成品包模块 52160 反提取，固定密钥，忽略 scope）
- [x] 构建通过，密钥存在于 background/newtab bundle

## 阶段 2：定制移植

### 2a manifest 与静态资源 ✅（1074e45）

- [ ] manifest：name "自动化工具"、中文 description、version 内联
- [ ] manifest：CSP 移除谷歌域名（`script-src 'self'; object-src 'self'`）
- [ ] manifest：删除 webService 内容脚本（及 webService 入口可保留不打包引用）
- [ ] manifest：background.scripts 前置 `async-lifecycle.js`
- [ ] manifest：`minimum_chrome_version: "90"`
- [ ] 移植 `async-lifecycle.js`（成品包根目录，原样拷入并接线）
- [ ] NotoSansCJKsc-Regular.otf + OFL 许可文件，接 CSS 引用（查成品包 CSS 引用点）

### 2b 语言包品牌化 ✅（1815bcb，往返验证 0 差异）

- [ ] 从成品包 locale chunks 反提取 zh 定制文案（对照官方 `src/locales/zh/*.json`）
- [ ] en 消息内品牌替换（"Automa" → "自动化工具 Offline" 等）
- [ ] 欢迎页/关于页 credits 文案（#33 如实描述）

### 2c 行为定制（进行中，6317394 已含第一组）

- [x] 不支持节点代理：tasks 导出整体 Proxy 化，回退定义与包内模块 50660 一致
- [x] 联网块移除：google-sheets / google-drive / google-sheets-drive 块定义、编辑组件、handler、API 层全部移除（4 项标记与包对齐）
- [ ] UA/文件类型相关补丁（.filetype-patch.json 线索：Chrome/90 UA、regression 89 项）
- [ ] 疑点修正：insert-data 块为上游 v1.28.27 原有功能（此前误判为自定义），语言包新增键已随 2b 采纳；recordWorkflow 体积差异待查（可能是依赖树分包差异）
- [x] 代码级定制盘点：中文代码字面量 635 条（修复注释/报错 + 品牌串），清单在 /tmp/custom-code-msgs.txt，将随阶段 3 逐项落地

## 阶段 3：修复移植（工作量主体）

### 3a/3b 前序批次 ✅（742e442、cc4f0ec 及多个提交）

- [x] 2026-10-10 FIX-REPORT：28 项代码修复（#1-#4、#7、#8、#10-#18-#21、#22/#23、#26-#28 background；#5、#6、#16、#17、#24、#25 contentScript）+ 2 项管理页缺陷（#29、#30）+ #33 关于页
- [x] 2026-10-11 导入数据修复：5 项（范围空格、HTTP 协议大小写、隐藏范围配置、错误项序号、目标类型分支）
- [x] 2026-10-05 P1/P2 批次与 audit-21 项
- [x] 双入口一致性：background 与 newtab 管理页引擎副本同步修复

### 3c 剩余中文字符串移植与引擎对齐 ✅

- [x] shared.js 注册表中文定制：AST codemod 160 处（57 块 name/description、conditionBuilder、eventList 21 项、supportLocales、regexPresets 13 项）+ conditions 块 description「条件模块」
- [x] 引擎运行时错误中文化（对照包模块 dump）：
  - handlerSwitchTab `未找到索引为 N 的标签页`、handlerActiveTab `未找到活动标签页`
  - handlerClipboard `后台执行不支持剪贴板模块`（条件对齐包版：仅 isPopup/isMV2）
  - handlerRepeatTask 重写对齐包版：非负整数校验 `重复次数必须是非负整数` + 0 次直接结束分支
  - handlerBrowserEvent `未找到事件 X`、handlerBlockPackage `未找到输入`/`未找到此输入对应的模块`
  - handlerWaitConnections `未选择指定流程`、content handlerLink `此元素不是链接`
  - content/utils getElementPosition `未找到内嵌框架`、WorkflowWorker blockExecutionWrapper Timeout → `节点执行超时，操作结果未知；请确认页面状态后再运行`
  - helper checkCSPAndInject `无法执行代码`
- [x] content/index.js messageToFrame 增强（对齐包版）：超时兜底 `网页框架通信超时，操作结果未知；请确认页面状态后再运行`（30s+5s 起、clamp 300s）、source/messageId 双校验、storage 写入失败 reject、signal 剥离与 checkExecutionSignal；`"…"没有对应的处理程序`（中文引号）、`模块标识为空`
- [x] sandbox automaFetch type 校验 `“type”必须为“text”或“json”`
- [x] 信号系统：content/executionSignal.js（getExecutionSignal/abortExecutionSignal/checkExecutionSignal，包内为惰性管线）+ cancel-workflow-execution 消息 case
- [x] 已记录偏差（不复制缺陷/结构差异）：
  - JS 块执行架构：源码采用 v1.28.27（background executeScript MAIN + sandbox + automaId 回执校验 + preload await），包为旧架构（content 执行 + background CSP 兜底，模块 27686）；preload 校验语义（URL 协议检查）覆盖包「网址无效」
  - `.automa.json` 文件安装流（confirm/alert）为旧版入口，v1.28.27 已移除，不移植
  - elementSelector/recordWorkflow/newtab 内联 locale vs locale chunk 分包差异（行为等价）
  - 备份/恢复完整子系统（包模块 85245 全量 + 25539 格式校验）与 SettingsBackup UI 单独排期；backupRestore.js/workflowValidation.js 已产出未接线
- [x] 验证：probes.cjs 25 项 0 confirmed（无缺陷复现）；regressions.test.cjs 42/42 通过；CJK 差集收敛至 944 项（注释残留 + 备份子系统 + locale 分包差异三类已知项）

## 阶段 4：备份/恢复完整子系统 ✅

- [x] `src/utils/backupFormat.js`（新建）：包模块 25539 全量移植——备份格式常量（`automa-local-backup` v1、storage 键表、IndexedDB 表清单）、默认状态、原型链污染/引用完整性校验、AES-GCM+PBKDF2-SHA256（310000 迭代）加密备份/解密、按 ID 状态合并（恢复后定时备份强制关闭并要求重新解锁）、快照回滚恢复
- [x] `src/utils/backupRestore.js`（重写）：包模块 85245 全量移植——门禁（isRestoreBlocked/markRestoreGateReady/checkRestoreJournal 原有导出不变）+ 完整 payload：状态收集（storage+IndexedDB+localStorage 快捷键）、doBackup（凭据解密为明文、受保护工作流附加恢复材料）、writeBackupState（整库 clear+bulkPut、storage 增删、快捷键写回）、restoreFromJournal、doRestore（新版格式 + 旧版 v1.28.27 导出兼容、恢复材料重加密、references 校验、assertIdle）
- [x] `src/background/backupService.js`（新建）：initBackup（门禁就绪 + 续恢复 + 重启锁定加密定时备份）、configureBackup（文件夹相对路径校验、downloads 权限、试备份、会话密码）、定时闹钟（schedule-local-backup，cron-parser）、rebuildAfterRestore（清工作流闹钟/上下文菜单、触发器重建、快捷键合并）
- [x] `src/background/index.js`：backup:status / backup:create / backup:configure / backup:restore 四消息；assertIdle 校验 workflowState 运行态；恢复后清空会话密码
- [x] `src/background/BackgroundEventsListeners.js`：onAlarms 定时备份分支重写（失败锁定 + lastError）、onRuntimeStartup/onInstalled(update) 接入 initBackup、install 默认值对齐包（settings.locale zh、localBackupSettings、只补缺失键）
- [x] `src/newtab/pages/settings/SettingsBackup.vue`：整页重写为包版「完整本地备份与恢复」（密码输入 + 下载/恢复 + 覆盖开关 + 定时备份卡片，恢复后 3 秒刷新）
- [x] workflows 首页菜单新增「本地备份与恢复」入口（对齐包 /backup 路由项）
- [x] 验证：构建 0 错误、eslint 0 错误、regressions 42/42、probes 0 confirmed、CJK 缺失 944 → 855（备份子系统运行时串全部收敛，余项为注释残留 + locale 分包差异两类已知项）

## 验证与交付

- [ ] 源码构建产物与成品包逐文件行为抽查（加载测试由用户在 UOS 真机执行）
