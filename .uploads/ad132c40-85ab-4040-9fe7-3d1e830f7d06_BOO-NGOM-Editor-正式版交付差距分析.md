# BOO-NGOM-Editor V4.4.0 · 正式版交付差距深度分析

> **报告版本** V1.0 · **基准提交** `ed6bbad`（2026-10-22，main） · **生成日期** 2026-11-06
> **分析视角**：把「正式版」定义为 **可发布 / 可安装 / 可运行 / 可维护** 四维，逐项给出可机器判定的 DoD
> **证据基准**：本地 HEAD 镜像 `_repo_full/`（770 个文本 blob 已用 Git blob SHA-1 与 Trees API 比对，770/770 逐字节一致）+ Git 树 `api_tree.json`（1,264 blob，`truncated:false`）

---

## 0. 结论速览

**判定：不具备正式版交付条件。** 45 项交付就绪检查中 **12 项通过、6 项阻断、13 项重要、13 项次要、1 项无法验证**，加权就绪度 **37/100**，`--gate` 模式返回 **exit 2**。

最关键的判断不是"代码质量不够"，而是：

> **功能实现层基本齐备（51/51 命令、8/8 视图、3/3 编辑器、19/19 主题均已接线），但发布链从未真正跑通一次 —— HEAD 的 CI 红灯使打包、依赖验证、上传、市场发布全部 skipped，仓库 0 Tag / 0 Release / 0 可下载 VSIX，而 README 却要求用户「从 VSIX 安装」。**

更严重的是，因为 CI 从未走到「验证 VSIX 运行依赖」这一步，**至少两处打包缺陷从未被任何测试暴露**（详见 5.2、5.3）：第三方许可证文件被 `.vscodeignore` 排除在包外；仓库自带的打包验证脚本要求一个按当前打包规则根本不会存在的文件 `LICENSE.txt`。也就是说，即便明天让 `test:all` 转绿，发布流水线仍会在下一步失败。

### 0.1 六项阻断（BLOCKER）

| ID | 阻断项 | 证据 |
| --- | --- | --- |
| `ART-06` | `THIRD_PARTY_NOTICES.md` 引用的 2 个 `.txt` 许可证**不入 VSIX** | `.vscodeignore` 顺序模拟 + 修复验证 |
| `ART-09` | 0 个 Git Tag，与 `v4.4.0` 无匹配 | GitHub `/tags` |
| `ART-11` | HEAD CI `failure`，失败在「全量回归测试」 | GitHub Actions runs，exit 1，7m46s |
| `QLT-04` | `npm run test:all` 非 0（CI 与本地各自失败） | Actions + 本地复现 |
| `QLT-05` | 官方 41 项自审中 **14 项 P1 未修** | `PROJECT_OPTIMIZATION_AUDIT_2026-10-04.md` |
| `QLT-10` | 6 类写盘 / 保真缺陷在 HEAD 抽查仍存在 | 源码行号 + 官方 RD 系列 |

### 0.2 十三项重要（MAJOR）

`ART-07` CHANGELOG 缺 V4.4.0 · `ART-10` 无 Release · `ART-12` 无可下载 VSIX · `MKT-03` 未声明 `capabilities.untrustedWorkspaces` · `MKT-04` 未声明 `extensionKind: ["ui"]` · `MKT-05` 43/51 命令缺 `onCommand` 激活事件（engines 低至 1.68） · `INS-04` `xlsx` 依赖外部 CDN tarball · `INS-07` 打包验证脚本与 `LICENSE.txt` 冲突 · `INS-08` DeepSeek 依赖用户去 QQ 群手工下载 exe · `QLT-06` 4 项僵尸配置 · `QLT-07` 验收条件 0/93 · `QLT-08` 测试挂载率 19.4% · `MNT-04` `permissions: contents: read` 无法自动建 Release。

### 0.3 本次新增的、前三份报告未覆盖的硬发现

| # | 新发现 | 影响 |
| --- | --- | --- |
| 1 | `.vscodeignore` 尾部 `*.txt` 覆盖前面的 `!tools/PakBridge/bin/**` 白名单 | 冻结运行时许可证文件丢失，合规风险 |
| 2 | `verify-packaged-dependencies.js:247` 要求 `LICENSE.txt`，包内只有 `LICENSE` | CI 转绿后的**隐藏发布阻断** |
| 3 | `activationEvents` 只有 8 条 `onCommand`，43 条命令在 VS Code 1.68–1.73 下不会被命令激活 | 老版本客户端功能入口失效 |
| 4 | `capabilities` / `extensionKind` 完全缺失 | 受限工作区被禁用、远程端误装 Windows 专用组件 |
| 5 | `xlsx` 依赖 `cdn.sheetjs.com` tarball，且 `out/` 与 `node_modules/` 均被 `.gitignore` 排除 | 离线 / 内网不可复现构建；源码直打包会缺 `main` |
| 6 | VSIX 打包清单实测 **44.18 MiB / 398 文件**，其中冻结运行时 37.08 MiB / 327 文件 | 包体偏大、供应链审计面大 |
| 7 | `publish.yml` 的 `permissions: contents: read` + 无 Release 步骤 | 即便打 tag 也不会产出 GitHub Release |
| 8 | D12 的 3 个命令依赖 `%LOCALAPPDATA%` 下外置 `DeepSeekHarness.exe`，源码引导 QQ 交流群下载 | 功能不可自助开通 + 可执行文件供应链风险 |

---

## 1. 分析口径与证据链

### 1.1 本次实际执行的核验

| 类别 | 做了什么 |
| --- | --- |
| 清单模拟 | 按 `.vscodeignore` 103 条规则**顺序**匹配 Git 树 1,264 个 blob，算出 398 文件 / 44.18 MiB 的 VSIX 内容；并对修复方案做两轮反事实模拟 |
| 元数据 | `package.json` 逐字段核对 25 个市场元数据键；`package-lock.json` 全部 437 个包的 `resolved` 来源扫描 |
| 发布链 | 完整读取 `.github/workflows/publish.yml`；核对触发条件、权限、构建/编译/lint/测试/打包/验证/上传/发布顺序与 tag 门禁 |
| 打包验证器 | 完整读取 `tools/release/verify-packaged-dependencies.js` 的必需清单、禁止清单与依赖闭包校验 |
| vsce 行为 | 读 `node_modules/@vscode/vsce/out/package.js` 的 `LicenseProcessor`，确认**不重命名** LICENSE 文件 |
| 运行时依赖 | 精确扫描 `src/` 的 `child_process` / `spawn` / `asAbsolutePath` / exe 路径，交叉核对打包白名单 |
| 兼容性 | 统计 `activationEvents` 覆盖率、`engines.vscode` 最低版本、Workspace Trust 与远程运行声明 |
| 外部事实 | GitHub API：21 commits / 0 Issue / 0 PR / 0 Tag / 0 Release / 20 次 CI 运行；本地 `tsc` / ESLint / `test:all` 实测 |

### 1.2 边界（必须说清）

- `vsce ls` / `vsce package` **未能实跑**：本地 `npm ci` 因 registry 空闲超时中断，`node_modules` 缺 `boolbase`，`vsce` 加载即失败。打包结论是**规则级模拟**，已用仓库自带的 `verify-packaged-dependencies.js` 与 vsce 源码交叉佐证，但仍需在 CI 转绿后以 `vsce ls` 复核。
- CI 失败步骤的完整日志需仓库管理员权限（403），**具体哪个测试用例失败仍未知**；本次不推测。
- 本地 `test:all` 的失败是 `database-access-browser.test.js` 缺少默认路径 Chrome（25s CDP 超时），属本地环境，**不能当作 CI 红灯原因**。
- 494 个二进制 blob 按路径 / 类型 / 体积登记，未做字节级解读；不影响本报告任何结论。
- 本报告不复述前三份报告的通用代码质量描述，只在「与正式版交付相关」处引用其结论。

### 1.3 与既有交付物的关系

| 文档 | 回答的问题 | 本报告增量 |
| --- | --- | --- |
| `BOO-NGOM-Editor-仓库全量审阅报告.md` V1.1 | 项目处于什么阶段、代码质量如何 | 补充打包链、市场元数据、合规与兼容性 |
| `BOO-NGOM-Editor-功能完整性改进方案.md` | 如何保证模块都完整实现 | 把「完整」升级为「可发布的完整」，补 DoD 与放行门禁 |
| `BOO-NGOM-Editor-功能模块全量清单.md` | 有哪些功能模块 | 把清单映射为发布就绪检查项 |
| **本报告** | **距离正式版还差什么** | 45 项检查、6 项阻断、可执行门禁与验证过的修复补丁 |

---

## 2. 「正式版」的可判定定义

本报告不把「正式版」当形容词，而是拆成 4 维 DoD：

| 维度 | 放行条件 | 本次结果 |
| --- | --- | --- |
| **A 可发布** | CI 全绿；tag 与 `manifest.version` 一致且存在 Release；VSIX 可下载；市场元数据齐全；Workspace Trust / 远程运行声明正确；第三方许可证随包交付 | **6/19 通过，3 阻断** |
| **B 可安装** | `npm ci` → 编译 → `vsce package` 可离线/稳定复现；`main`、运行时 exe、生产依赖、Webview 资产全部入包；包体合理；外部依赖有官方分发与校验 | **4/8 通过，3 重要** |
| **C 可运行** | tsc/ESLint 0 错误；`test:all` exit 0；P1 数据安全债务清零；每个声明点有挂载验收测试与书面验收条件 | **2/11 通过，3 阻断** |
| **D 可维护** | CI 无重复编译、具备 Release 自动化权限；架构可维护；反馈渠道可用；版本记录同步 | **0/7 通过，1 重要** |

**加权就绪度算法**：BLOCKER=5 / MAJOR=3 / MINOR=1，得分 = 已通过项权重 / 已判定项权重 = **37/100**。GA 判定要求 **BLOCKER=0 且 MAJOR=0**（MINOR 允许带入 GA 后的迭代）。

---

## 3. 差距总表（门禁实测输出）

```
检查项 45 | PASS 12 | BLOCKER 6 | MAJOR 13 | MINOR 13 | UNKNOWN 1
加权就绪度 37/100 | GA 判定：不可发布 | VSIX 估算 44.18 MiB / 398 文件

按维度：
  可发布   6/19 通过 | 阻断 3 | 重要 6 | 次要 4
  可安装   4/8  通过 | 阻断 0 | 重要 3 | 次要 1
  可运行   2/11 通过 | 阻断 3 | 重要 3 | 次要 2
  可维护   0/7  通过 | 阻断 0 | 重要 1 | 次要 6
```

完整逐项结果（含 `detail` / `evidence` / `action`）见 `artifacts/release-readiness-baseline.json`。

**通过项不是零**：semver 合法、图标存在且为 PNG、README/LICENSE/THIRD_PARTY_NOTICES 入包、3 个运行时 exe 全部入包、生产依赖白名单齐全、VSIX 体积在阈值内、`tsc` 0 错误、ESLint 0 错误、`preview` 未误设、CI 具备编译前置、打包后不泄漏源码/测试主体——这些是项目已经做扎实的部分，报告不重复批评。

---

## 4. 深度分析 A：可发布

### 4.1 发布链断点（最核心的差距）

`publish.yml` 的实际顺序：

```
push main/master|v* 或手动
  → npm ci → pip install → build:m2-native → tsc → lint
  → test:all            ← HEAD 在此失败（exit 1）
  → vsce package         ← skipped
  → verify:packaged-dependencies  ← skipped
  → upload-artifact      ← skipped
  → vsce publish (tag)   ← skipped
  → ovsx publish  (tag)  ← skipped
```

- HEAD `ed6bbad` 的 20 次 CI 记录中最新一次为 `failure`；上次绿灯是同日稍早的 `5a0f5da`。
- 触发条件含 `tags: ["v*"]`，打包脚本也会校验 `tag == v$manifest.version`，**设计是对的**，但仓库 **0 个 Tag**，所以市场发布步骤从未执行过。
- 结果是用户侧断裂：README 写「从 VSIX 安装…选择取得的 BOO 安装包」，但仓库既无 Release 资产、也无 Marketplace 链接、也无 tag。

### 4.2 版本语义与变更记录

| 项 | 现状 |
| --- | --- |
| `package.json` | `4.4.0` |
| Git Tag | 0 |
| GitHub Release | 0 |
| CHANGELOG 最新版本 | `V4.3.9 - 2026-10-04`（**缺 V4.4.0**） |
| CHANGELOG 是否入包 | 否（`*.md` 排除，且未加入白名单） |
| `docs/releases/V4.4.0_RELEASE_20261022.md` | 存在，但只是内部发布核验记录，不是面向用户的变更记录 |

即：**版本号、变更记录、发布标签三者互不同步**，用户在 Marketplace 上看不到 4.4.0 做了什么。

### 4.3 市场元数据与兼容性声明

| 字段 | 现状 | 正式版要求 |
| --- | --- | --- |
| `capabilities.untrustedWorkspaces` | **缺失** | 本扩展读写磁盘、启动 exe、执行 PowerShell、启动本地服务；未声明时 VS Code 在受限工作区会禁用或限制扩展，Marketplace 也会标注未声明。应补 `supported: limited` + `restrictedConfigurations` |
| `extensionKind` | **缺失** | 强依赖 Windows `.exe` / Jet-ACE / PowerShell；应声明 `["ui"]`，避免 WSL/SSH 远程端误装后功能全废 |
| `activationEvents` | 17 条，其中 `onCommand` 仅 **8** 条 | `engines.vscode: ^1.68.0` 意味着最低支持 1.68；VS Code 1.74 才自动为 contributed commands 生成 `onCommand`。**43/51 命令在 1.68–1.73 下不会被命令激活**。`onLanguage:plaintext` 会缓解多数场景，但空窗口 / 非文本文件下从命令面板调用会失效。要么补齐事件，要么把 `engines` 提升到 `^1.74.0` |
| `keywords` | `[]` | 补中英文检索词 |
| `galleryBanner` / `qna` / `badges` | 缺失 | 市场页横幅、支持入口、CI 状态徽章 |
| `extensionPack` | 强制连带安装「中文语言包 + vscode-icons」 | 安装时的侵入性行为，应评估移除或改为可选推荐 |
| `preview` | 未设置（默认 false） | 正确，正式版保持 |

### 4.4 合规：第三方许可证随包交付 ★

`THIRD_PARTY_NOTICES.md` 明确写道：

> `tools/PakBridge/bin/` 包含 Python 冻结运行环境、cx_Freeze 启动组件和 Microsoft VC++ Runtime；相关许可证保存在 `frozen_application_license.txt`、`share/licenses/vc_redist/LICENSE.txt`、`LICENSE.RTF`。

但按 `.vscodeignore` 规则顺序模拟，**两个 `.txt` 文件都不在包内**，只有 `.RTF` 保留：

| 文件 | 树中 | 入包 | 原因 |
| --- | --- | --- | --- |
| `tools/PakBridge/bin/frozen_application_license.txt` | 是 | **否** | 被末尾 `*.txt` 排除 |
| `tools/PakBridge/bin/share/licenses/vc_redist/LICENSE.txt` | 是 | **否** | 同上 |
| `tools/PakBridge/bin/share/licenses/vc_redist/LICENSE.RTF` | 是 | 是 | `.rtf` 不受 `*.txt` 影响 |
| `media/vendor/tabulator/LICENSE` | 是 | 是 | 已核实，文档引用有效 |

这是「声明了但没交付」的合规缺口：VSIX 内带着 250 个 `.pyc`、52 个 `.pyd`、17 个 `.dll`、2 个 `.exe`，却没带其中两个许可证文本。

---

## 5. 深度分析 B：可安装

### 5.1 VSIX 打包清单实测

按 `.vscodeignore` 103 条规则顺序匹配 Git 树全部 1,264 个 blob：

| 项 | 值 |
| --- | --- |
| 入包文件 | **398** / 1,264（排除 866） |
| 入包体积 | **44.18 MiB** / 104.05 MiB |
| 主要构成 | `tools/` 327 文件 / **37.08 MiB**（PakBridge 冻结运行时）、`data/` 10 文件 / 4.75 MiB、`media/` 21 文件 / 1.62 MiB、`resources/` 9 文件 / 0.46 MiB、`themes/` 19 文件 |
| 正确排除 | `src/**`、`tests/**`（主体）、`docs/**`、`data/audit-report/**`（约 50 MB）、`out/**`（源码中无此目录） |
| 未计入 | CI 生成的 `out/`（编译产物）与 `node_modules/` 白名单依赖，二者不在 Git 树中 |

**关键资产入包核对**：图标、3 个运行时组件、根级 README/LICENSE/THIRD_PARTY_NOTICES、9 个语言数据 JSON、Tabulator 4 个文件、19 套主题、`package.json` / `package-lock.json` 全部入包；`CHANGELOG.md`、`src/`、审计基线 JSON 被正确排除。

### 5.2 `.vscodeignore` 规则顺序缺陷 ★（已验证修复）

规则顺序是问题根源：

```
tools/**                                  ← 先整体排除
!tools/PakBridge/bin/**                   ← 再放行 bin 下全部文件
...
*.md
!README.md
!THIRD_PARTY_NOTICES.md
...
*.txt                                     ← 最后又把 bin 下的 .txt 全部排除
*.py
```

`!README.md` 同样过宽：它匹配任意层级的 `README.md`，导致 `tests/README.md`、`docs/README.md` 混入发布包。

**已用反事实模拟验证的两步修复**（追加规则，不改源码）：

```gitignore
# 追加到 .vscodeignore 末尾（必须在 *.txt 之后）
!tools/PakBridge/bin/frozen_application_license.txt
!tools/PakBridge/bin/share/licenses/vc_redist/LICENSE.txt
```

并把现有的 `!README.md` 替换为 `!/README.md`（根级锚定）。

| 方案 | 入包文件 | 体积 | 两个许可证 | tests/docs README |
| --- | --- | --- | --- | --- |
| 现状 | 398 | 44.18 MiB | 不入包 | 误入包 |
| 仅追加许可证白名单 | 400 | 44.19 MiB | **入包** | 误入包 |
| 再替换 README 白名单 | **395** | **44.18 MiB** | **入包** | **排除** |

> 模拟口径：含前导 `/` 的锚定规则按仓库根解析；CI 实跑后需用 `vsce ls` 复核一次。

### 5.3 隐藏阻断：打包验证脚本要求不存在的文件 ★

`tools/release/verify-packaged-dependencies.js:247`：

```js
verifyRequiredPackagedFiles(
  packagedRoot,
  ['readme.md', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.md'],
  'Project notice'
);
```

`verifyRequiredPackagedFiles` 直接用 `fs.existsSync(path.join(root, relative))` 精确查找。事实：

- Git 树根级文件只有 `LICENSE`（无扩展名），**没有 `LICENSE.txt`**；
- `readme.md` 小写能在 Windows 大小写不敏感文件系统上匹配 `README.md`，但 `LICENSE.txt` 不会匹配 `LICENSE`；
- 已查 `node_modules/@vscode/vsce/out/package.js` 的 `LicenseProcessor`：它用 `/^extension\/licen[cs]e(\.(md|txt))?$/i` **识别** `LICENSE` / `LICENSE.md` / `LICENSE.txt`，**不会重命名**。

因此在 CI 转绿、走到「验证 VSIX 运行依赖」步骤时，这一步极可能直接抛 `Project notice packaged runtime files are missing: LICENSE.txt`。**它之所以从未被发现，正是因为 `test:all` 先挂了。**

修复二选一：把验证清单里的 `'LICENSE.txt'` 改成 `'LICENSE'`（推荐，最小改动）；或在仓库根补一个 `LICENSE.txt` 并在 `.vscodeignore` 末尾 `!LICENSE.txt` 放行。**必须在 CI 转绿后实跑 `npm run verify:packaged-dependencies -- <解包目录>` 做最终确认。**

### 5.4 构建可复现性

| 项 | 现状 | 风险 |
| --- | --- | --- |
| `xlsx` 依赖 | `"https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"`（lockfile 中唯一非 registry 来源） | `npm ci` 强依赖第三方 CDN 可达；内网 / 离线 / CDN 变更都会让构建失败。应改 registry 版本或 vendor 化 tarball |
| `out/` | 被 `.gitignore` 排除，Git 树 0 个文件 | 从源码 ZIP 直接 `vsce package` 会产出缺 `./out/extension.js` 的坏包；必须先 `npm ci && npm run compile`。CI 做对了，README 未对终端用户说明 |
| `node_modules/` | 同上 | `.vscodeignore` 用 60+ 条 `!node_modules/xxx/**` 白名单放行生产依赖与传递依赖，已覆盖 4 个直接依赖，仓库自带验证脚本会做依赖闭包校验 |
| 二进制入库 | 494 个 blob（250 `.pyc` / 52 `.pyd` / 17 `.dll` / 2 `.exe` / 165 `.webp` 等） | 冻结运行时 37 MiB 随包分发，供应链审计面大；建议改为 Release 资产 + 校验和 |
| Python 依赖 | `requirements-test.txt` 固定 PyCryptodome 3.23.0 / Unicorn 2.1.4 | 仅测试用，不进 VSIX，`THIRD_PARTY_NOTICES.md` 已声明，处理正确 |

### 5.5 运行时外部依赖

| 组件 | 路径 | 调用点 | 入包 |
| --- | --- | --- | --- |
| `boo-pak-bridge.exe` | `tools/PakBridge/bin/` | `src/utils/gm-bridge.ts:70-71` | 是 |
| `M2Reloader.exe` | `tools/M2Reloader/runtime/native-win-x64/` | `src/reload.ts:54-56`（找不到时明确告警） | 是 |
| `access-bridge.ps1` | `tools/AccessBridge/` | 验证脚本要求 | 是 |
| **DeepSeek Harness** | `%LOCALAPPDATA%\DeepSeekHarnessPortable`（外置） | `src/providers/deepseek-view.ts:17` `spawn` | **否** |

D12 的 3 个命令（`deepseek.openPanel` / `openInBrowser` / `startServer`）在用户未手工安装 Harness 时不可用；源码注释直接引导「QQ 交流群 58505745 下载 `DeepSeekHarness.exe` 并运行一次」。对一个正式上架的扩展，这既是**功能不可自助开通**，也是**可执行文件来源不可校验**的供应链风险。应提供官方分发 / 哈希校验，或把该域明确降级为可选集成并在市场页说明前置条件。

---

## 6. 深度分析 C：可运行

### 6.1 静态质量基线（这部分是强项）

| 项 | 实测 |
| --- | --- |
| TypeScript | 162 文件 / 67,166 行；`tsc --noEmit` **0 错误** |
| ESLint | **0 错误 / 51 警告**，全部 `require-atomic-updates` 竞态，集中 10 个 Provider（`resource-editor.ts` 24 条） |
| 代码卫生 | `@ts-ignore` 0、`eslint-disable` 1、TODO 1、空 catch 0、`any` 33 处；`strict: true`，但 `no-explicit-any` 关闭、lint 忽略 `media/tests/tools` |
| 注释率 | 2.5% |
| 超大模块 | 11 个 >1,000 行，最大 `ui-dialog/source-parser.ts` **12,872 行** |

### 6.2 测试与验收

| 项 | 现状 | 差距 |
| --- | --- | --- |
| HEAD CI | `test:all` exit 1（7m46s） | 阻断发布；具体用例因日志 403 未知 |
| 本地 `test:all` | 5m43s 后 exit 1，`database-access-browser.test.js` → `Error: DOM test did not complete`（`chromium-dom.js:120`，25s CDP 超时，本机仅 Edge） | **本地环境限制，非 CI 红灯原因**；但暴露验收链对外部浏览器敏感、错误信息不区分「启动失败/页面未加载/脚本报错/超时」 |
| 测试规模 | 395 个 `.js` / 78,364 行，官方称 25 套既有测试 + 2 套 Chrome 渲染回归 | 规模不小，但无覆盖率统计 |
| 挂载率 | 93 个声明点仅 **18 个**有已挂载验收测试（19.4%）；51 命令中仅 17 个在 `tests/` 出现命令 ID，34 个无挂载测试 | 大部分功能「能跑」但回归链覆盖不到 |
| 书面验收条件 | **0/93** | 无法机器判定「完整」 |
| CI 效率 | `test:all` 中 19 个子脚本重复 `npm run compile` | 无谓拉长全量回归，放大超时概率 |

### 6.3 官方 41 项自审与 P1 债务

`docs/reports/PROJECT_OPTIMIZATION_AUDIT_2026-10-04.md` 给出 41 项（P1 14 / P2 20 / P3 7）与 40 项功能覆盖台账（RDF01–RDF40）。V4.4.0 实际只修了 MDB 记录编辑、变量程序点分析、DELAYGOTO/MapInfo 导航、图标缩到 512px——**14 项 P1 的主体未纳入本轮**。维护者自己在自审里写明：「最值得优化的不是继续加按钮，而是保存安全、编辑保真、目标身份和结果一致性」。

### 6.4 写盘安全专章（最高优先级）

| 缺陷 | 证据 | 后果 |
| --- | --- | --- |
| RD01 SQLite 普通保存静默覆盖外部修改 | `utils/database-browser.ts:836 / 777 / 798 / 519`；官方夹具：外部改 `Name`、扩展改 `Price` 保存后磁盘变回 `Name=initial` | 运行中的 M2 / 第二编辑器写入被旧快照回写覆盖。`sql.js` 的 `BEGIN IMMEDIATE` 只锁内存库 |
| `.vscode/settings.json` 被 `JSON.parse` + 重写 | `src/extension.ts:200-212` | 破坏 JSONC（注释、尾逗号） |
| 折叠 / CodeLens 开关不读配置 | `src/assistant.ts:1634/1637` 与 `providers/{folding,codelens}.ts` | 4 项僵尸配置中的 2 项 |
| 6 处模板用 `{1:…}` 而非 Snippet `${1:…}` | `src/assistant.ts:3639-3654` | 插入后占位符不跳转 |
| 区服同步目标侧缺逐级 realpath 围栏 | `src/utils/zone-sync.ts:320-350` | 符号链接 / junction 可越出目标根 |
| XLS 发布最后副本 / 范围原点 / `backupId` 三个反例 | 官方 RD02/RD03/RD04 | 编辑保真不足 |
| WAL、崩溃恢复、草稿持久化 | 官方台账列为缺口 | 断电 / 崩溃后数据状态不确定 |

**这 6 类缺陷直接决定「能不能让用户拿真实服务端数据用」**，比任何 UI 优化都优先。

### 6.5 功能完整性（引用既有结论，不重复展开）

- 51/51 命令、8/8 视图、3/3 自定义编辑器、19/19 主题全部有注册实现；另有 7 条已注册未声明的内部命令。
- 4 项配置是「声明了没实现」：`completionCase` / `enableCodeLens` / `enableFolding` / `diagnosticSeverity` 无任何 `.get()` 读取；注意 `deepseek.host` / `deepseek.port` 是 `cfg.get('deepseek.host')` 读取的，**已接线**，不要误判。
- 门禁四环齐全率 18/93 = 19.4%；`_improvement_kit/` 已提供可运行的 93 条功能契约与分层门禁，可直接接到本报告的 P2 阶段。

---

## 7. 深度分析 D：可维护

| 项 | 现状 | 影响 |
| --- | --- | --- |
| `permissions: contents: read` | publish.yml 只有只读权限，且**无创建 Release 的步骤** | 即使打 tag，也只会把 VSIX 传到 Marketplace / Open VSX 与 90 天过期的 Actions artifact，不会产出可长期下载的 GitHub Release。若以 Release 附带 VSIX 为目标，需 `contents: write` + `gh release create` |
| 发布凭证 | `VSCE_PAT` / `OVSX_PAT` 两个 secret，脚本有空值检查 | 是否已配置无法从外部验证（本报告列为 UNKNOWN 边界，不计入失败） |
| 重复编译 | 19 次 `npm run compile` | 全量回归耗时长、超时风险高 |
| 单人维护 | 21 commits 全部同一作者，0 Issue / 0 PR | README 却把「问题反馈」指向 issues；缺少模板、回归渠道与Bus factor |
| 架构 | `source-parser.ts` 12,872 行、注释率 2.5%、494 个二进制入库、50 MB 审计基线 | 复杂度超单人维护边界；但属 GA 后 P4 事项，不作为首发阻断 |
| 版本文档 | CHANGELOG 停在 V4.3.9 | 与 4.4.0 不同步 |

---

## 8. 根因归纳

1. **发布链从未端到端跑通**：CI 红灯卡在第一步，后面所有打包 / 验证 / 发布步骤都是未验证代码路径，累积了两处从未暴露的打包缺陷。
2. **"实现完成"被当成"交付完成"**：51 命令 / 8 视图 / 19 主题都做完了，但 Tag、Release、VSIX、CHANGELOG、市场元数据、验收条件这一层几乎空白。
3. **合规与打包规则靠人工维护、没有端到端断言**：`.vscodeignore` 103 条规则的先后顺序会改变许可证是否入包；仓库有 `verify-packaged-dependencies.js` 却因 CI 未走到而形同虚设，且其自身的 `LICENSE.txt` 断言与实际文件名冲突。
4. **数据写入安全是唯一真正的功能性风险**：官方 14 项 P1 全部指向保存 / 恢复 / 一致性，而不是功能缺失；在这类扩展里，「写错用户数据」比「少一个按钮」严重得多。

---

## 9. GA 路线图（每阶段 DoD 可机器判定）

### P0 · 止血与发布链打通（必须先做）

| 动作 | DoD |
| --- | --- |
| 逐子脚本定位 CI 红灯并修复 | `npm run test:all` 在 CI exit 0；需管理员导出失败日志确认用例 |
| 修复 `.vscodeignore` 两条许可证白名单 + README 根级锚定 | `vsce ls` 输出含两个 `.txt` 许可证，且不含 `tests/README.md` / `docs/README.md` |
| 解决 `LICENSE.txt` 冲突 | CI「验证 VSIX 运行依赖」步骤 exit 0 |
| 补 CHANGELOG V4.4.0 + 入包白名单 | CHANGELOG 含 `V4.4.0` 且 `vsce ls` 含 `CHANGELOG.md` |
| `xlsx` 依赖 registry 化 / vendor 化 | 断网或仅访问 registry 时 `npm ci` 成功 |
| 打 `v4.4.0` Tag + 创建 Release 附 VSIX | `/tags` 与 `/releases` 非空，Release 有可下载 VSIX 资产 |
| 补 `capabilities` / `extensionKind` / `activationEvents` | 门禁 `MKT-03/04/05` 转 PASS |
| 把 `permissions` 提升到 `contents: write` 并加 Release 步骤（若采用 Release 分发） | 门禁 `MNT-04` 转 PASS |

**P0 完成判据**：`node check-release-readiness.mjs --gate` 的 **BLOCKER = 0**（此时仍允许 MAJOR 存在，避免一接入就全红被绕过）。

### P1 · 数据安全与质量

14 项 P1 按官方 A 批处理，每项「先写红测 → 再修绿 → 再补验收条件」：外部修改检测与冲突拒绝、原子发布、目标侧逐级 realpath、`.vscode/settings.json` 走 `workspace.getConfiguration().update()`、模板改 `${1:}` + `insertSnippet`、XLS 三反例、WAL / 崩溃恢复。同时接通 4 项僵尸配置。

**P1 完成判据**：`QLT-05/06/10` 转 PASS；每个 P1 有对应回归用例与验收条件。

### P2 · 完整性与可安装性

接入 `_improvement_kit/` 的 93 条功能契约与分层门禁，逐域 `--require-ring mountedTest` 收紧至 ≥80%；补 93 条书面验收条件；DeepSeek Harness 提供官方分发与哈希校验或降级为可选集成；收敛 51 条竞态警告；把 19 次 compile 收敛为 1 次；接覆盖率采集。

**P2 完成判据**：`QLT-07/08`、`INS-08` 转 PASS；`test:all` 时长明显下降。

### GA · 放行

`node check-release-readiness.mjs --gate --min-severity minor` 中 BLOCKER=0 且 MAJOR=0；CI 全绿；Tag/Release/VSIX 三者版本一致；市场页元数据齐全；Windows 干净机器 + VS Code 1.68 / 最新稳定版各跑一次安装冒烟（51 命令可见、8 视图可打开、3 编辑器可打开、写盘路径在备份副本上验证）。

### P4 · GA 后（明确不作为首发阻断）

拆分 `source-parser.ts` 12,872 行、补关键算法注释、把冻结运行时改为 Release 资产 + 校验和、建立 issue 模板与多人协作。

---

## 10. GA 放行检查表（可直接复制）

```
[ ] CI 全绿（tsc / lint / test:all / vsce package / verify / upload）
[ ] 失败日志可读或已由管理员导出并确认根因
[ ] tag v4.4.0 存在且与 manifest.version 一致
[ ] GitHub Release 存在，附可下载 VSIX 与校验和
[ ] CHANGELOG 含 V4.4.0，且随包交付
[ ] README 安装路径改为 Marketplace / Release 链接
[ ] 19 套主题、图标、51 命令、8 视图、3 编辑器在干净机器冒烟通过
[ ] 两个冻结运行时 .txt 许可证入包；THIRD_PARTY_NOTICES 与包内容一致
[ ] verify-packaged-dependencies 实跑通过（含 LICENSE 文件名修正）
[ ] npm ci 不依赖第三方 CDN 即可完成
[ ] capabilities.untrustedWorkspaces / extensionKind 已声明
[ ] activationEvents 覆盖 51 命令，或 engines 提升到 ^1.74.0
[ ] 14 项 P1 清零，写盘路径在备份副本上验证
[ ] 4 项僵尸配置接通或移除
[ ] 每个声明点有挂载验收测试与书面验收条件
[ ] DeepSeek 域有官方分发/校验，或市场页明确标注可选前置
[ ] VSCE_PAT / OVSX_PAT 已配置并做过一次预演发布
[ ] check-release-readiness.mjs --gate 返回 exit 0
```

---

## 11. 可运行门禁交付说明

| 文件 | 作用 |
| --- | --- |
| `check-release-readiness.mjs` | 零依赖 Node 20+ 门禁，45 项检查；能从源码/清单重扫的一律重扫，只有外部状态读 facts |
| `release-facts.json` | 外部事实基线（CI / Tag / Release / 实测质量数据），逐项带来源与时间戳 |
| `artifacts/release-readiness-baseline.json` | 本次实测基线，含每项 `detail` / `evidence` / `action` |

```bash
# 报告模式（永远 exit 0，输出差距清单与基线 JSON）
node check-release-readiness.mjs --root _repo_full --tree api_tree.json

# GA 门禁：有 BLOCKER → exit 2；仅有 MAJOR → exit 1；全清 → exit 0
node check-release-readiness.mjs --gate

# 最严格：MINOR 也阻断
node check-release-readiness.mjs --gate --min-severity minor
```

本次三种模式实测：默认 `exit 0`，`--gate` `exit 2`，`--gate --min-severity minor` `exit 2`。建议接入 `publish.yml` 的「全量回归测试」之后、「打包 VSIX」之前，先用 `--gate` 只卡 BLOCKER，再随 P1/P2 逐阶段收紧到 `--min-severity minor`。

脚本内的打包模拟与本次 Python 核验使用同一套 glob 语义（支持 `**/`、结尾 `/**`、无斜杠模式匹配 basename、前导 `/` 锚定），并已对修复方案做过反事实验证。

---

## 12. 边界与免责

- 打包清单为**规则级模拟**，不是 `vsce package` 实跑产物；`vsce ls` 因本地 `npm ci` 不完整（缺 `boolbase`）失败，属本次环境限制。
- CI 失败用例、发布 secret 是否已配置、Marketplace / Open VSX 账号状态均无法从外部验证，本报告分别标为 UNKNOWN 或【边界】，未作推测性结论。
- 494 个二进制资源未做字节级解读；功能清单结论基于 770 个已 SHA 校验的文本文件。
- 加权就绪度 37/100 是**本检查表的相对分数**，不是通用代码质量评分；与审阅报告 V1.1 的「综合 6.8/10」口径不同，不可直接比较。
- 本报告未改动 `_repo_full/` 镜像中的任何仓库文件；所有修复以补丁建议形式给出，需由维护者在真实仓库应用并在 CI 实跑确认。

---

## 13. 附录

### 13.1 建议的 `.vscodeignore` 补丁

```diff
-!README.md
+!/README.md
 !THIRD_PARTY_NOTICES.md
 ...
 *.txt
 *.py
 scripts/**
+
+# 冻结运行时与 VC++ Runtime 的许可证必须随包交付
+!tools/PakBridge/bin/frozen_application_license.txt
+!tools/PakBridge/bin/share/licenses/vc_redist/LICENSE.txt
+# 如需保留变更记录，再补：!CHANGELOG.md
```

### 13.2 建议的验证器补丁

```diff
-  ['readme.md', 'LICENSE.txt', 'THIRD_PARTY_NOTICES.md'],
+  ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md'],
```

### 13.3 证据索引

| 结论 | 来源 |
| --- | --- |
| 打包文件清单 / 体积 / 许可证缺失 | `api_tree.json` + `_repo_full/.vscodeignore` 顺序模拟（含两轮修复反事实验证） |
| `LICENSE.txt` 冲突 | `tools/release/verify-packaged-dependencies.js:247` + Git 树根级文件列表 + `vsce/out/package.js` `LicenseProcessor` |
| 市场元数据 / 激活事件 / 依赖来源 | `_repo_full/package.json` + `package-lock.json` |
| 发布链顺序与权限 | `.github/workflows/publish.yml` |
| 运行时外部组件 | `src/utils/gm-bridge.ts:70`、`src/reload.ts:54`、`src/providers/deepseek-view.ts:17` |
| CI / Tag / Release / Issue | GitHub REST API（前次审阅已取，本次复用并标注时间） |
| 质量与缺陷 | 本地 `tsc` / ESLint / `test:all`，`docs/reports/PROJECT_OPTIMIZATION_AUDIT_2026-10-04.md`，三份既有交付物 |
