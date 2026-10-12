# 实施与验收核对清单 (Checklist): 009 查找与替换

**状态**: Completed | **完成日期**: 2026-10-12

本清单用于逐项核对 **009: 查找与替换** 的所有功能、边界条件及验收标准，确保开发无遗漏。

---

## 1. 样式与主题 Token (Visual & Tokens)

- [x] **T1.1** 在 `src/styles/global.css` 中声明语义颜色 Token：
  - `--color-search-match: #4a3e20;`（普通匹配项暗金底色）
  - `--color-search-match-active: #dca829;`（当前选中匹配项明亮金黄底色）
  - `--color-search-match-active-text: #121317;`（当前选中匹配项文字深色）
- [x] **T1.2** 在 `src/editor/editorConfig.ts` 中将上述 Token 映射至 CodeMirror 官方类名：
  - `.cm-searchMatch` 使用 `var(--color-search-match)`
  - `.cm-searchMatch-selected` 使用 `var(--color-search-match-active)` 及文字色
- [x] **T1.3** 搜索栏面板本身样式严格采用现有的 Dark 主题 Token（`--color-bg-raised`, `--color-border`, `--color-focus-ring` 等），禁止硬编码颜色。
- [x] **T1.4** 运行静态 CSS 检查，确保通过 `src/ui/cssContract.test.ts` 零硬编码颜色断言。

---

## 2. 命令系统与键盘流 (Commands & Keyboard Flow)

- [x] **T2.1** 在 `src/app/commands/commandIds.ts` 中注册 `editor.find` 与 `editor.replace` 命令 ID。
- [x] **T2.2** 在 `src/app/commands/ideaKeymap.ts` 中绑定 IDEA 风格快捷键：
  - `Ctrl+F` -> `editor.find`
  - `Ctrl+R` -> `editor.replace`
- [x] **T2.3** 在 `src/app/App.tsx` 的全局 Keydown 捕获层实现输入框按键隔离：
  - 当 `event.target` 是搜索/替换输入框时，**放行** `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+Y`, `Ctrl+A`，让原生 `<input>` 正常撤销/重做/全选。
  - 全局命令 `Ctrl+S`（保存）、`Ctrl+W`（关闭当前文件）、`Ctrl+N`（新建）在输入框内依然能够正常派发。
- [x] **T2.4** 搜索栏内键盘操作支持：
  - 搜索框内按 `Enter`：跳转至下一个匹配项
  - 搜索框内按 `Shift+Enter`：跳转至上一个匹配项
  - 替换框内按 `Enter`：替换当前匹配项并跳至下一个
  - 按 `Alt+C`：切换大小写敏感开关 (`Cc`)
  - 按 `Alt+P`：替换当前项（Replace）
  - 按 `Alt+A`：全部替换（Replace All）
  - 按 `Esc`：关闭搜索/替换栏，**焦点立即平滑归还给 CodeMirror 编辑器**
- [x] **T2.5** 多层级全局 Esc 分发机制（`EscapeManager`）：
  - 建立统一的 Escape 分发管理器 `EscapeManager` 与分级优先级常量（`MODAL: 40`, `POPUP: 30`, `TOOL: 20`, `INLINE: 10`, `EDITOR: 0`），与 `global.css` 的 `--layer-*` 堆叠规范对齐。
  - 搜索/替换栏作为 `TOOL` 层级（优先级 20）注册。
  - 当焦点在搜索框主键之外（如 CodeMirror 编辑器、操作按钮、Tab 条等）按 `Esc` 时，平滑退出搜索/替换并清理高亮；若同时存在更高优先级的弹窗/Modal 则优先关闭上层，支持逐级退出弹窗与功能块直至只剩编辑器。

---

## 3. 状态管理与生命周期 (State & Lifecycle)

- [x] **T3.1** 状态模型设计：维护单例状态（`query`, `replacement`, `caseSensitive`, `mode: "find" | "replace" | "closed"`）。
- [x] **T3.2** 模式切换数据保留：同一文档下，在 `Ctrl+F` 和 `Ctrl+R` 之间切换时，已输入的搜索词、替换词与大小写开关状态严格保留。
- [x] **T3.3** 选区自动预填：
  - 当编辑器有单行选中文本（长度 <= 200 字符）时，按 `Ctrl+F` / `Ctrl+R` 自动将选中内容填入搜索框并全选内容。
  - 当编辑器选区跨行（包含换行符 `\n`）或长度 > 200 字符时，不予预填，保留上一次搜索词并全选。
  - 当编辑器无选区时，保留上一次搜索词并全选。
- [x] **T3.4** Tab 切换严格隔离：
  - 监听活动文档变更（`activeDocumentId` 切换）。
  - 用户切换到其他 Tab 时，**自动关闭搜索/替换栏，并清除当前高亮**，不跨文档维持或泄露搜索状态。
- [x] **T3.5** 空状态处理：当关闭最后一个文档（处于 EmptyState）时，搜索栏自动收起隐藏；无打开文档时 `editor.find` 和 `editor.replace` 处于禁用状态。

---

## 4. CodeMirror 搜索与替换引擎 (Engine & Operations)

- [x] **T4.1** 在 `EditorHandle` 中引入 `@codemirror/search` 的基础扩展（`search()`），并通过 dispatch `setSearchQuery` 驱动视口高亮。
- [x] **T4.2** 就近查找算法：
  - 搜索起点从当前主光标位置向后查找，找到第一个匹配项并移动选区高亮，视口居中。
  - 末尾环绕：若光标后无匹配，自动回到文档顶部环绕查找第一个匹配项。
  - 反向查找：`Shift+Enter` 向前查找，到顶部自动环绕至末尾。
- [x] **T4.3** 单次替换（Replace）：
  - 若当前光标正选中一个匹配项，将其替换为 `replacement`，并自动就近定位并跳转至下一个匹配项。
  - 若当前光标不在匹配项上，则先跳转选中下一个匹配项。
- [x] **T4.4** 全部替换（Replace All）：
  - 所有匹配项在 CodeMirror 中作为**单次原子事务（Single Transaction）**批量替换。
  - 验收标准：执行“全部替换”后，按一次 `Ctrl+Z` 必须能完整撤销本次全部替换。
- [x] **T4.5** 空替换支持：支持 `replacement` 为空字符串（即批量删除匹配项）。
- [x] **T4.6** 匹配计数与防抖算法：
  - 实时计算匹配当前选中序号与总数（如 `3 / 15` 或 `0 个结果`）。
  - 100ms 防抖更新总数，避免大文件连续快速打字卡顿。
  - 匹配项达到 1000 个时进行封顶截断展示（显示 `1000+` 或 `>1000`）。
- [x] **T4.8** 首帧高亮即时渲染引擎（Immediate Highlighting Engine）：
  - 在 `src/editor/editorConfig.ts` 中通过自定义 `searchDecorationPlugin` ViewPlugin 监听 `getSearchQuery`。
  - 在当前视口 `visibleRanges` 中直接计算并添加 `.cm-searchMatch` 与 `.cm-searchMatch-selected` 装饰。
  - 彻底摆脱 CodeMirror 官方 `searchHighlighter` 强制要求内部 `panel != null` 的约束，保证用户激活搜索、预填或键入首字符时，视口内所有匹配项首帧即刻渲染高亮。

---

## 5. UI 组件与交互细节 (UI & Controls)

- [x] **T5.1** 在 `src/app/shell/EditorGroup.tsx` 中嵌入 `SearchReplaceBar`。
- [x] **T5.2** 查找模式（单行布局）：
  - 搜索图标 + 搜索输入框（聚焦时外围高亮环）
  - 输入框内右侧 `Cc` 按钮（激活状态高亮）
  - 计数文本（如 `3 / 15` 或 `0 个结果`）
  - 上一个 `↑` 按钮与下一个 `↓` 按钮（无结果时置灰 disabled）
  - 关闭 `✕` 按钮
- [x] **T5.3** 替换模式（双行布局）：
  - 上行为搜索行（与单行布局一致）。
  - 下行为替换行：替换输入框 + “替换”按钮 + “全部替换”按钮（无匹配时按钮置灰 disabled）。
- [x] **T5.4** 焦点控制：
  - 唤起搜索时，自动聚焦搜索输入框并全选已有内容。
  - 唤起替换时，自动聚焦替换输入框（若搜索框已有词）或聚焦搜索框。
  - 按 `Esc` 或点关闭按钮，搜索条关闭，**CodeMirror 立即重新获得焦点**。
- [x] **T5.5** 悬浮岛式布局（Island Layout）：
  - 搜索栏不贴死顶部 TabStrip，上下四周留白边距（`margin: 6px 12px;`）。
  - 圆角与描边统一继承现有 Island 规范（`border: 1px solid var(--border-island); border-radius: var(--radius-island);`）。
  - 宽度自适应内容宽度（`width: fit-content; max-width: calc(100% - 24px);`），右侧按钮紧贴计数区域（无宽屏两极拉伸）。

---

## 6. 自动化测试与全量门禁 (Verification)

- [x] **T6.1** 编写单元测试 `src/app/search/searchController.test.ts`：测试状态切换、搜索词保留、选区预填、Tab 隔离。
- [x] **T6.2** 编写快捷键与命令测试：验证 `Ctrl+F` / `Ctrl+R` 映射及输入框按键穿透放行。
- [x] **T6.3** 编写 CodeMirror 替换事务测试 `src/app/search/searchEngine.test.ts`：验证 Replace All 产生单事务并可通过单次 Undo 完整还原。
- [x] **T6.4** 全量通过全项目四大门禁：
  - `npm run typecheck` (PASS)
  - `npm run test` (55 files, 1234 passed)
  - `npm run build` (PASS)
  - `cargo test` (145 passed)

