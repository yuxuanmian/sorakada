# Plan: 009-search-replace — 当前文档查找与替换 (IntelliJ IDEA 风格)

**分支**: `feature-core` | **模式**: Lean Spec | **状态**: Completed | **完成日期**: 2026-10-12

完成依据：`checklist.md` 中的功能、交互及四项验证均已记录为通过。010 接续正则表达式搜索与颜色统一；009 的排除项保留为本阶段的历史范围。

---

## 1. 目标与范围 (Scope: In & Out)

### 核心目标
在当前活动文档内实现符合 IntelliJ IDEA 风格的置顶查找与替换面板，具备就近匹配、单步撤销替换、选区预填、快捷键流畅交互、Tab 严格隔离、首帧即时高亮与 Island 悬浮卡片形态。

### 包含能力 (In)
1. **形态与布局（Island 悬浮卡片形态）**：
   - 采用 **Island 卡片设计**（非通栏拉伸），四边具备微弱描边与圆角（`border: 1px solid var(--border-island); border-radius: var(--radius-island)`）。
   - 顶部与四周留白（`margin: 8px 12px 4px 12px`），脱离 TabStrip 底线与编辑器边框，符合整体 Island 视觉语言。
   - 宽度自适应内容（`width: fit-content; max-width: calc(100% - 24px)`），内部元素紧凑成组，拒绝在宽屏下两极拉伸。
2. **模式分立与状态共享**：
   - **查找模式 (`Ctrl+F`)**：单行紧凑搜索卡片。
   - **替换模式 (`Ctrl+R`)**：双行紧凑工具卡片（上行搜索，下行替换）。
   - **同文档状态共享**：在同一活动文档内，从查找模式切换至替换模式（或反之），已输入的搜索词、替换词及 `Cc` 大小写状态**严格保留**。
3. **选区自动预填**：
   - 编辑器内有选中文本时按 `Ctrl+F` 或 `Ctrl+R`，自动将选中文本填入搜索框并全选框内文本；若无选区，则保留上一次搜索词并全选。
   - **长文本与多行选区防护**：跨多行（包含 `\n`）或长度超过 200 字符的选区不予自动预填，避免破坏单行输入框。
4. **即时渲染与就近高亮**：
   - **首帧即时高亮引擎**：通过自定义 `searchHighlighterPlugin` 接管，摆脱官方内部对 `panel` 开关状态的绑架，激活搜索或输入首字符时，视口内匹配项**首帧 100% 即时渲染高亮**。
   - 搜索起点严格为当前光标位置（Selection head），向后查找最近的一个匹配项，视口居中高亮。
   - 文档末尾自动环绕（Wrap around）至文档开头。
   - 视口内实时渲染匹配高亮（普通匹配暗金黄，当前活动匹配项高亮金黄）。
5. **匹配计数与性能保护**：
   - 实时反馈当前匹配序号与总数（如 `0 个结果` 或 `3 / 15`）。
   - 采用 100ms 防抖更新计数，匹配项超过 1000 时进行封顶截断展示（如 `1000+ 个结果`），保证大文件极速输入不掉帧。
6. **大小写匹配开关 (`Cc`)**：
   - 输入框内右侧集成 `Cc` 按钮（快捷键 `Alt+C`），开启时呈现高亮激活状态。
7. **导航与替换动作**：
   - 导航：上一个（`↑` / `Shift+Enter`）、下一个（`↓` / `Enter`）。
   - 单次替换（Replace，快捷键 `Alt+P` 或按钮）：替换当前选中的匹配项，并自动就近跳转选中下一个匹配项。
   - 全部替换（Replace All，快捷键 `Alt+A` 或按钮）：原子单事务提交，按一次 `Ctrl+Z` 可整体撤销。
   - 空文本替换：允许“替换为”输入框留空，即批量删除匹配项。
8. **焦点生命周期、多层级 Escape 分发与 Tab 隔离**：
   - **多层级 Escape 分发（`EscapeManager`）**：建立与 `global.css` `--layer-*` 一致的分级分发栈（`MODAL: 40`, `POPUP: 30`, `TOOL: 20`, `INLINE: 10`, `EDITOR: 0`）。搜索/替换栏注册为 `TOOL` 层级。
   - 无论焦点处于搜索框内还是处于 CodeMirror 编辑器、操作按钮或 Tab 栏等外部元素，按 `Esc` 均能平滑触发关闭并清理高亮；若有更高优先级的弹窗则逐级退出，直至只剩编辑器。
   - 按 `Esc` 关闭面板，**焦点立即平滑归还 CodeMirror 编辑器**，保留当前匹配选区与阅读位置。
   - **Tab 严格隔离**：切换到其他标签页时，自动关闭搜索条，清空当前高亮，不跨 Tab 维持搜索状态。
   - 所有文档关闭进入 EmptyState 时，面板自动隐藏。

### 明确排除 (Out / V1 裁剪)
- 暂不支持正则表达式 (`.*`)。
- 暂不支持全词匹配 (`\b`) 与选区内查找（Filter / In Selection）。
- 暂不支持跨文件 / 工作区全局搜索。
- 色彩精细微调挪至 010 统一规划。

---

## 2. 关键架构契约与红线 (Guards)

1. **样式与色彩契约**：
   - 必须遵守 `src/ui/cssContract.test.ts`：**严禁在组件 CSS 中硬编码任何颜色字面量**。
   - 所有搜索高亮与按钮色彩均在 `src/styles/global.css` 中声明语义 Token。
   - 由 `src/editor/editorConfig.ts` 接管 CodeMirror 官方类名 `.cm-searchMatch` 与 `.cm-searchMatch-selected`。
2. **即时高亮机制**：
   - 在 `editorConfig.ts` 中通过 ViewPlugin 自定义驱动 `.cm-searchMatch` 装饰集，绕过官方包依赖内部 panel 的限制。
3. **快捷键事件隔离（防按键穿透）**：
   - 在 `App.tsx` 的全局 keydown capture 中，若 target 是搜索/替换的 `<input>`，**放行 `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` / `Ctrl+A`**，交由原生输入框处理，绝不得拦截触发 CodeMirror 的文档级 Undo/Redo。
   - 全局保存 `Ctrl+S`、关闭标签 `Ctrl+W` 仍可正常在输入框中穿透生效。
4. **单事务 Undo 保护**：
   - 全部替换（Replace All）必须通过 CodeMirror 的单次 Transaction 批量更新，保证按一次 `Ctrl+Z` 即可完整恢复原样。
5. **CodeMirror 独占拥有文本真实性**：
   - 搜索面板仅维护搜索词和 UI 状态，不直接镜像文档内容到 React 状态中。

---

## 3. UI 布局原型 (IntelliJ IDEA Island 风格)

```text
查找模式 (Ctrl+F - 单行 Island 卡片，紧凑不拉伸):
┌────────────────────────────────────────────────────────┐
│ 🔍 [ 搜索关键词...       | Cc ]  3 / 15  [↑] [↓] [✕]   │
└────────────────────────────────────────────────────────┘

替换模式 (Ctrl+R - 双行 Island 卡片):
┌────────────────────────────────────────────────────────┐
│ 🔍 [ 搜索关键词...       | Cc ]  3 / 15  [↑] [↓] [✕]   │
│    [ 替换为...                ]  [ 替换 ] [ 全部替换 ] │
└────────────────────────────────────────────────────────┘
```

---

## 4. 实施阶段概览

- **Phase 1: 视觉 Token 与 CodeMirror 主题配置** (`global.css`, `editorConfig.ts`)
- **Phase 2: 命令注册与全局按键隔离** (`commandIds.ts`, `ideaKeymap.ts`, `App.tsx`)
- **Phase 3: 搜索状态模型与生命周期管理** (`searchState.ts`, Tab 切换自动收起)
- **Phase 4: CodeMirror 引擎与搜索操作桥接** (`EditorHandle`, 就近查找, 单事务替换, 计数算法, 自定义即时高亮 ViewPlugin)
- **Phase 5: SearchReplaceBar 置顶 Island 组件实现** (`SearchReplaceBar.tsx`, `search.css`, `EditorGroup.tsx`)
- **Phase 6: 自动化测试与四大门禁验证** (`typecheck`, `test`, `build`, `cargo test`)
