# 011 Windows Alpha 安装交付指南

**版本**：0.1.0-alpha.1  
**目标平台**：Windows 10 / 11 x64  
**打包格式**：Tauri 2 NSIS 单文件安装包（setup.exe）  
**验证状态**：本地四项门禁通过；用户于 2026-10-15 确认本地人工验收全部通过，包含全新安装、启动、alpha.0 → alpha.1 覆盖升级、布局偏好保持与卸载安全。GitHub Actions 远程构建及产物下载仍待验证。

**记录来源**：用户本轮明确确认；Agent 本轮仅更新文档，未代替用户执行安装或测试。异常信息 Toast 交互的后续改版意向已记录于规格及人工验收清单，不阻塞本次本地验收。

---

## 1. 本地交付安装包信息

为满足全新安装与覆盖升级（alpha.0 -> alpha.1）的完整人工实测需求，本地已构建出两套真实、可安装的 NSIS 安装包。

### 1.1 目标交付包（0.1.0-alpha.1）
- **产物绝对路径**：`D:\project\tool\sorakada\src-tauri\target\release\bundle\nsis\Sorakada_0.1.0-alpha.1_x64-setup.exe`
- **文件大小**：1,764,459 字节（约 1.68 MB）
- **SHA256 校验和**：`bc13e1ae083cc8eae04e4a2cc728dbbc4bf2caee4b9dbfcc4393e5c3b0f00a80`
- **源码来源**：当前 `codex/011-app-foundation` 最终交付工作区（包含全部 i18n 迁移、严格类型约束与 Debug Strip 本地化文案）
- **版本配置**：`package.json`、`Cargo.toml` 与 `tauri.conf.json` 保持为 `0.1.0-alpha.1`
- **应用标识**：`com.sorakada.editor`
- **安装模式**：`currentUser`（免 UAC 提权，默认安装路径 `%LocalAppData%\Sorakada`）

### 1.2 合成升级测试基线包（0.1.0-alpha.0）
- **产物绝对路径**：`D:\project\tool\sorakada\src-tauri\target\release\bundle\nsis\Sorakada_0.1.0-alpha.0_x64-setup.exe`
- **文件大小**：1,764,607 字节（约 1.68 MB）
- **SHA256 校验和**：`c041281065a6554ba6060edf0cf5cdf32cd81677dc98624946e8edf3501c8523`
- **源码来源**：由当前 011 未提交工作区快照在 repo 内 gitignored 临时目录 `out/temp-build-alpha-0` 隔离构建；仅将版本配置调整为 `0.1.0-alpha.0`，完全不修改最终交付 checkout 的版本
- **应用标识**：`com.sorakada.editor`（与 alpha.1 严格相同，确保 Windows 安装器识别为同一应用的升级关系）
- **安装模式**：`currentUser`（与 alpha.1 严格相同）
- **基线性质声明**：此包为**合成升级测试基线（Synthetic Upgrade Test Baseline）**，专门用于人工验证从旧版本号平滑覆盖升级到新版本号的安装器覆盖替换流程与布局偏好保持，**绝非假冒早期已发行版本或 010 历史功能版本**。
- **安装实测状态**：用户于 2026-10-15 确认安装及 alpha.0 → alpha.1 覆盖升级实测通过；沿用本节已记录的合成基线来源、版本和安装模式。

### 1.3 只读安装器脚本核验
经核验构建生成的 NSIS 脚本（`src-tauri/target/release/nsis/x64/installer.nsi`）：
- **安装模式**：`!define INSTALLMODE "currentUser"` 与 `RequestExecutionLevel user`，仅安装到当前用户空间，无需管理员提权（UAC）；
- **默认安装目录**：`StrCpy $INSTDIR "$LOCALAPPDATA\${PRODUCTNAME}"`（即 `%LocalAppData%\Sorakada`）；
- **语言与界面**：`!insertmacro MUI_LANGUAGE "SimpChinese"`，安装器语言固定为简体中文；
- **交互控制**：`displayLanguageSelector: false`，跳过语言选择对话框与安装模式选择页。

### 1.4 GitHub Actions 手动构建配置
- **工作流文件**：`.github/workflows/build-alpha.yml`
- **触发方式**：`workflow_dispatch` 手动点击触发（无自动推送构建）
- **构建环境与命令**：`windows-latest`，`npx tauri build --bundles nsis`，与本地构建配置严格一致
- **产物归档**：通过 `actions/upload-artifact@v4` 归档 `src-tauri/target/release/bundle/nsis/*.exe`（Artifact 名称：`sorakada-windows-alpha-nsis`）
- **状态**：静态配置核验通过；远端实际触发与产物下载仍属于待人工实测项。

---

## 2. 运行环境与依赖说明

### 2.1 Microsoft Edge WebView2 运行时依赖
- Sorakada 基于 Tauri 2，依赖系统 Microsoft Edge WebView2 Evergreen Runtime。
- 当前 Windows 10（更新版）及 Windows 11 默认已预装 WebView2。
- 安装包配置为 `downloadBootstrapper` 模式：若用户系统缺失 WebView2，安装器将在联网情况下尝试下载引导安装程序并完成安装。离线受限环境需预先部署 Evergreen 离线运行时。

### 2.2 Alpha 未签名限制说明
- 011 Alpha 阶段尚未配置商业 Authenticode 代码签名证书。
- **已知行为**：在启用 SmartScreen 的 Windows 10/11 系统上首次启动安装器时，系统可能弹出“Windows 已保护你的电脑 / 未知发布者”提示。
- **操作方式**：需用户手动点击“更多信息”并选择“仍要运行”。此属于 Alpha 预发布阶段预期行为，后续正式发布时接入签名流水线。

---

## 3. 人工实机验证记录（2026-10-15 用户确认通过）

> 本节步骤保留用于复测；勾选依据为用户于 2026-10-15 对本地全部人工项的通过确认。安装验收结果独立于构建结果；GitHub 远程构建尚未验证。

### 3.1 偏好保持与会话边界说明
- 当前 Sorakada 的 `uiPreferences` 仅持久化存储界面布局状态（如侧边栏折叠状态、侧边栏宽度）；
- **注意**：打开的编辑文档不属于会话持久化范围。覆盖安装后，应用启动时不恢复、也不应恢复上次打开的文件，仅验证侧边栏折叠/宽度等布局偏好完好保留。
- 旧包覆盖升级测试仅证明针对该已记明的合成基线平滑升级有效，不能据此声称对历史全版本发行的兼容保证。

### 3.2 全新安装与启动验证（A09，用户确认通过）
1. 确保目标机上未安装过 Sorakada。
2. 运行安装包 `Sorakada_0.1.0-alpha.1_x64-setup.exe`。
3. 验证项：
   - [x] 未弹出语言选择器对话框；
   - [x] 安装向导界面文字为清晰简体中文；
   - [x] 默认安装位置为当前用户目录（`%LocalAppData%\Sorakada`），无管理员提权弹窗；
   - [x] 安装完成后桌面与开始菜单快捷方式正常生成，且能正常启动应用与加载编辑器。

### 3.3 覆盖升级与偏好保持验证（A09，用户确认通过）
1. 在测试机上先安装合成基线包 `Sorakada_0.1.0-alpha.0_x64-setup.exe` 并启动。
2. 修改 UI 布局偏好（如折叠 Workspace Explorer 侧边栏，或拖拽调整侧边栏宽度），产生有效的本地 `uiPreferences` 存储。
3. 关闭应用后，直接运行新版本安装包 `Sorakada_0.1.0-alpha.1_x64-setup.exe` 进行覆盖安装（不事先手动卸载）。
4. 验证项：
   - [x] 覆盖安装顺利完成，未报文件占用或版本冲突错误；
   - [x] 启动新版本后，原有的侧边栏折叠状态及宽度偏好完好保留；
   - [x] 偏好损坏或异常时按既有规则安全回退默认值。

### 3.4 卸载安全性验证（A09，用户确认通过）
1. 在 Windows“设置” -> “已安装的应用”或开始菜单执行“卸载”。
2. 验证项：
   - [x] 程序本体、可执行文件与快捷方式被正确清理；
   - [x] 用户保存在工作区或任意磁盘位置的代码文件与文本文件完好无损，**绝对未被删除**。
