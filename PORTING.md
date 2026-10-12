# 源码重建移植清单

分支：`uos-rebuild`（基线 v1.28.27 tag）
目标：源码构建产物与 `Chromium90扩展/` 成品包行为等价。

## 阶段 1：基础重建 ✅

- [x] 官方源码 + npm 构建（Node 22，`env -u NODE_OPTIONS npm run build`）
- [x] getPassKey 真实实现（成品包模块 52160 反提取，固定密钥，忽略 scope）
- [x] 构建通过，密钥存在于 background/newtab bundle

## 阶段 2：定制移植

### 2a manifest 与静态资源

- [ ] manifest：name "自动化工具"、中文 description、version 内联
- [ ] manifest：CSP 移除谷歌域名（`script-src 'self'; object-src 'self'`）
- [ ] manifest：删除 webService 内容脚本（及 webService 入口可保留不打包引用）
- [ ] manifest：background.scripts 前置 `async-lifecycle.js`
- [ ] manifest：`minimum_chrome_version: "90"`
- [ ] 移植 `async-lifecycle.js`（成品包根目录，原样拷入并接线）
- [ ] NotoSansCJKsc-Regular.otf + OFL 许可文件，接 CSS 引用（查成品包 CSS 引用点）

### 2b 语言包品牌化

- [ ] 从成品包 locale chunks 反提取 zh 定制文案（对照官方 `src/locales/zh/*.json`）
- [ ] en 消息内品牌替换（"Automa" → "自动化工具 Offline" 等）
- [ ] 欢迎页/关于页 credits 文案（#33 如实描述）

### 2c 行为定制（从 bundle 反推）

- [ ] 不支持节点代理（模块 50660）：未知 block 返回"不支持的节点"占位（中文描述、ErrorWarningLine 图标、不可执行）——已在 readable/background.js:22390 定位
- [ ] UA/文件类型相关补丁（.filetype-patch.json 线索：Chrome/90 UA、regression 89 项）
- [ ] 逐 bundle 体积差异排查（recordWorkflow 516K vs 官方 148K 等）确认是否另有行为改动

## 阶段 3：修复移植（工作量主体）

- [ ] 2026-10-10 FIX-REPORT：28 项代码修复（#1-#4、#7、#8、#10-#18-#21、#22/#23、#26-#28 background；#5、#6、#16、#17、#24、#25 contentScript）+ 2 项管理页缺陷（#29、#30）+ #33 关于页
- [ ] 2026-10-11 导入数据修复：5 项（范围空格、HTTP 协议大小写、隐藏范围配置、错误项序号、目标类型分支）
- [ ] 重建后 `node output/code-review-2026-10-10/probes.cjs` 全过（预期 3 项 harnessError）
- [ ] 重建后 `output/import-data-fix-2026-10-11/regressions.test.cjs` 89 项全过
- [ ] 双入口一致性：background 与 newtab 管理页引擎副本同步修复

## 验证与交付

- [ ] 源码构建产物与成品包逐文件行为抽查（加载测试由用户在 UOS 真机执行）
