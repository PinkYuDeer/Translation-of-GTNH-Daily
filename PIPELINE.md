# 每日流水线实现细节

面向仓库贡献者 / 想了解管道运作的读者。普通使用者请看 [README.md](README.md)。

---

## 分支策略

- **`master`**：唯一长期分支，保存工作流与同步脚本
- **Tags / Releases**：每日构建自动生成 `0-nightly-build/YYYY-MM-DD` tag 与对应 Release（同日重复构建原地覆盖同 tag、不产生残留 draft），过期的 Release 由 cleanup job 自动清理
- 汉化原文历史由上游 [GTNewHorizons/GTNH-Translations](https://github.com/GTNewHorizons/GTNH-Translations) 保存；校对译文由 [PT 项目 4964](https://paratranz.cn/projects/4964) 保存

---

## 数据流概览

整条流水线由 [`.github/workflows/daily.yml`](.github/workflows/daily.yml) 触发：

- 定时：中国时间每天凌晨 1 点（UTC 17:00）
- 手动：Actions 页 `workflow_dispatch`，支持 `force=true` 把合并后的所有文件重新推到 PT 20315，也支持 `skip_gt5u=true` 跳过 GT5U `runClient25` 并直接使用缓存的 GregTech.lang；此模式也跳过 Java 与 headless 客户端依赖安装，若该缓存未命中则直接失败，不会回退运行 GT5U
- Issue：Issues 页 `触发 DailySync` 模板会由 [`.github/workflows/issue-dispatch.yml`](.github/workflows/issue-dispatch.yml) 转发为 `workflow_dispatch`，支持同样的 `force` 与 `skip_gt5u` 选项；`触发 Export` 模板会转发到 [`.github/workflows/export-pt-lang-package.yml`](.github/workflows/export-pt-lang-package.yml)

设计目标：**以英文原文为准**、**尽量少打 PT API**、**换行符逐词条原样还原**、**打包结构对齐线下参考包**。

```
 ┌──────────────────────── 上游源（只读） ────────────────────────┐
 │ A0. GTNewHorizons/GT5-Unofficial         runtime GregTech.lang │
 │ A.  GTNewHorizons/GTNH-Translations      daily-history/        │
 │ B.  GTNewHorizons/GT-New-Horizons-Modpack config/              │
 │ C.  Kiwi233/Translation-of-GTNH          config/ + resources/  │
 │ D.  ParaTranz 20315 当前态                                      │
 │ E.  ParaTranz 4964 校对译文                                     │
 └───────────────────────────────┬───────────────────────────────┘
                                 ▼
 generate-gregtech-lang → fetch-en → pull-current-18818 → pull-zh-4964 → sync-terms
                                 ▼
                         merge-final → push-final
                                 ▼
                       PT 20315（整文件更新）
                                 ▼
                        restore-and-pack
                                 ▼
                0-nightly-build/YYYY-MM-DD Release
```

---

## 步骤逐项说明

脚本都位于 `.github/scripts/daily/`。下表列出职责与关键输入 / 输出，需要更详细的规则请直接看脚本头注释。

### 0. `generate-gregtech-lang.ts` — 生成 GregTech.lang（实验）

- 克隆/更新 `GTNewHorizons/GT5-Unofficial@master` 到 `$REPO_CACHE_DIR/gt5u`（默认 `.build/repo-cache/gt5u`，不进 Actions cache）
- 在 GitHub Actions 安装 `xvfb` / Mesa 软件渲染 / OpenAL runtime，用 Java 25 启动 `./gradlew runClient25`（可用 `GT5U_RUN_CLIENT_TASK` 覆盖）
- 启动前只在临时 GT5U checkout 中补入少量 `GregTech.lang` 缺失键实际需要的 `runtimeOnlyNonPublishable` 依赖，避免全量加载 GT5U 可选依赖造成启动冲突与额外耗时；当前补入 Forestry, Gendustry, bdlib, MatterManipulator, VendingMachine
- 启动前写入 `config/CodeChickenLib.cfg` 的 `mappingDir`，指向 Gradle/RFG 解包出的 MCP `conf` 目录，避免 headless 环境弹出 MCP 文件夹选择 UI；特殊环境可用 `GT5U_MCP_CONF_DIR` 覆盖
- 启动前写入 `config/DreamCoreMod.properties` 的 `showConfirmExitWindow=false`，避免 NewHorizonsCoreMod 替换 `Minecraft.shutdown()` 后弹出退出确认窗口
- 启动前确保 Linux `XDG_DATA_HOME/applications` 存在，并写入 `config/lwjgl3ify.cfg` 的 `window.B:linuxCreateAppDesktopEntry=false`，避免 GitHub runner 缺少桌面数据目录时由 lwjgl3ify 创建 `.desktop` 入口失败
- 启动前写入 `config/AppliedEnergistics2/AppliedEnergistics2.cfg` 的 `general.B:exportItemNames=false`，避免 AE2 CSV 导出线程枚举全部物品造成额外耗时和启动风险
- 脚本默认自启虚拟 X display，并强制使用 llvmpipe 软件 OpenGL 与 null OpenAL；不依赖 GitHub runner 的真实显卡或声卡。如需本地复用已有窗口显示，设置 `GT5U_USE_EXISTING_DISPLAY=1`
- 脚本在临时 GT5U checkout 注入一次性客户端 Probe mod，持续读取并向 Actions 输出 `run/client/logs/*` 的进度；Probe 会注册轻量 `endergoo` Fluid stub 以生成 HEE 的 `Ender Goo Cell` 键，但不加载完整 HEE runtime；当客户端显示任意无世界菜单界面后，Probe 直接调用 Minecraft API 进入临时单人世界 `GTNHLangProbe`，不依赖 UI 点击或原版主菜单类名
- 进入世界并检测到玩家实体后，Probe 直接调用 Minecraft 正常 shutdown，等待客户端退出后取完整 `GregTech.lang`；如需额外停留，可用 `GT5U_WORLD_SETTLE_MS` 覆盖，默认不等待
- 若 ready marker 因日志格式变化未出现，则在 postload 后等待 `GT5U_CLOSE_AFTER_POSTLOAD_MS`（默认 180 秒）再进入临时世界，避免 workflow 长时间无输出卡住
- 输出 `.build/generated-gregtech/GregTech.lang` 与 metadata；成功后同步写入 `.cache/generated-gregtech/`
- 若最新 GT5U 构建或 `runClient25` 失败，自动尝试使用 `.cache/generated-gregtech/GregTech.lang`；若手动运行时设置 `skip_gt5u=true`，则只使用该缓存，未命中时直接报错

### 1. `fetch-en.ts` — 英文原文收集

- Sparse-clone 三个上游仓库到 `$REPO_CACHE_DIR/<slug>/`（默认 `.build/repo-cache/<slug>/`，仅当前 run 使用）
- `.build/generated-gregtech/GregTech.lang` 必须存在；`daily-history/GregTech.lang` 不再作为回退来源
- 枚举 A–G 七类英文源（见脚本顶部说明），按 PT 20315 路径写成统一 JSON 骨架
- **去重**：同一目标路径同时来自 `daily-history` 与 `Modpack` 时，`daily-history` 胜
- **任务书（betterquesting）路径迁移**：上游把 DefaultQuests lang 从 `config/txloader/load/betterquesting/lang/` 移到 `config/txloader/forceload/betterquesting/lang/`；其 `en_US.lang` 现**仅存在于 daily-history 的 forceload 目录**（Modpack 只放 `template.lang`）。`dailyHistoryToPtPath` 对**这一条** forceload 路径做窄特例收录（其余 forceload 仍由 Modpack 提供，保持「Modpack 负责 forceload」的优先级）
- **换行嗅探**：逐词条识别英文原文使用的是 `<BR>` / `<br>` / `[br]` / `%n` / 字面 `\n` / 字面 `\\n`，并逐文件统计出现最多的形式，写入 `.cache/newlines.json`
- 输出：`.build/en/<pt-path>.en.json`（所有值已归一化为真换行）

### 2. `pull-current-18818.ts` — 拉取我方 PT 当前态

- 通过 ParaTranz artifact 端点下载 20315 全量 JSON；artifact 不可用时退回逐文件 `/files/{fileId}/translation`，避免 `/strings?file=` 漏掉隐藏/未翻译阶段词条
- 顺带刷新 `.cache/file-ids/files.json`（PT 路径 → fileId 映射），后续 push/archive 靠它定位
- 输出：`.build/zh-current/<pt-path>.json`（含现网译文 + stage）

### 3. `pull-zh-4964.ts` — 拉取上游校对译文 + Kiwi 直通

- 通过 ParaTranz artifact 端点下载 4964 全量 JSON；artifact 不可用时退回逐文件 `/files/{fileId}/translation`
- 下载后统一清理 4964 旧 key 前缀（如 `lang|` / `gt-lang|`），后续合并再按 20315 目标文件解析
- 同时从 `Kiwi233/Translation-of-GTNH` 拷贝 **不进 PT** 的直通文件（见下文"直通文件"一节）到临时目录供打包用
- 输出：`.build/zh-4964/<pt-path>.json`

### 3.5 `sync-terms.ts` — 术语表同步

- 以 4964 为准，把 20315 的术语表**镜像**成 4964 的副本：按术语原文比对两边，对差异逐条走 per-term CRUD —— `POST .../terms`（4964 有、20315 无）新增、`PUT .../terms/{id}`（内容不同）更新、`DELETE .../terms/{id}`（20315 有、4964 无）删除，**增删改都同步**，无差异则一条不发
- 不再用 `PUT /projects/20315/terms`（multipart 批量导入）：它只插入新词条，不更新改动、也不删除公开源已删的词条，两边会越漂越远
- 保证 20315 的术语表永远跟着 4964 走

### 4. `merge-final.ts` — 本地整合

输入 `.build/en/`、`.build/zh-current/`、`.build/zh-4964/`，生成最终要落的 PT 文件。规则：

- 英文 key/original 为主轴；20315 译文在 key + original 都匹配时保留
- 英文原文 `trim()` 后为空的词条在采集阶段即丢弃；若整份英文文件无有效词条，则不再作为活跃文件进入 PT，现网旧副本会走归档删除
- 若 4964 对同 key 有新鲜译文（original 与英文匹配），会填补 20315 空缺；若 20315 与 4964 已有不同译文，merge 会按需调用 `/strings?file=...` 查询两端行级时间，4964 更新或远端时间仍缺时采纳 4964，否则保留 20315
- 若英文变了而 4964 没跟上，写入 stale 标记：`${新英文}\n旧译：\n${旧译文}`，stage=0；上传到 PT 时保留真实换行。其中 `旧译` payload **优先用我方 20315 的现有译文**，仅当我方无译文时才退用 4964 的旧译（20315 每日跟随 4964，我方漂移行所基于的英文不会比 4964 旧；公开源没更新时若取 4964 会把参考退回更旧的译文）
- stale 标记中 `旧译：` 后的旧译 payload 会把 Java 字符串格式占位 `%s` / `%d` / `%2$s` 等替换为 `xx`；正常译文不替换，`%n` 仍按换行规则处理
- 4964 中英文侧已无的条目/文件一律忽略，不再作为 source-only 补入 20315
- 最终译文 `trim()` 后为空的条目保持空译并置 stage=0；已有 20315 译文即使等于原文也保留，因为颜色值、ID、数字等词条常以原文作合法译文
- 退役文件（英文侧消失，或已带 `.disable` / `.achive` 等旧后缀）与活跃文件内已移除词条单独记录，后续归档到仓库并从 PT 删除

输出：
- `.build/zh-final/<pt-path>.json` — 最终 PT 文件内容
- `.build/merge-plan.json` — 本轮要 push / archive 的文件清单；含 `archiveStrings{}`：活跃文件中已从英文源移除、需并入仓库 `archive/` 的旧词条。`overrideTranslations[]` 仅作兼容诊断，push 阶段不再逐词 PUT
- artifact 拉取的 JSON 通常无行级时间戳；冲突裁决才会额外走 `/strings?file=...` 查询 `createdAt/updatedAt/uid`，同文件多词冲突会复用一次查询结果

### 5. `push-final.ts` — 整文件回推 PT 20315

- 按 `merge-plan.push[]` 用 `POST /files` 上传仅含原文的 JSON；此接口只更新 original，不写译文
- 源文件上传后重新读取该文件词条，把译文/stage 有差异的行组为小 JSON，走 `POST /projects/{projectId}/files/{fileId}/translation` 导入译文；普通差异非强制导入，空译清理或仅 stage 差异用 `force=true` 片段导入
- `merge-plan.archiveStrings{}` 先按打包路径与仓库 `archive/` 旧文件合并，再由源文件更新移除 PT 内旧词条
- `merge-plan.archive[]` 先按打包路径与仓库 `archive/` 旧文件合并，再调用 `DELETE /projects/{projectId}/files/{fileId}` 从 PT 删除

### 5.5 `build-progress.ts` — 维护 README 90 天进度图

- 跑两次，夹住 push-final，因为 PT 20315 的 stats 只在 push-final 时变化：
  - **settle（`--settle`，push-final 之前）**：此刻 PT 还是昨天推送后的状态，所以这份快照就是昨天的 `settled`（昨天译文一天后的成色）。先写它，能让一个已经完工到 100% 的日子保持绿色，不被今天 push 进来的新增未翻译英文拉低
  - **update（默认，push-final 之后）**：PT 已反映今天的合并推送，这份快照写成今天的 `updated`；今天的 `settled` 留空到明天的 settle 阶段再补
- **仅定时构建写进度**：settle / update 两步都带 `if: github.event_name == 'schedule'`。手动 `workflow_dispatch` 跳过它们——否则会把构建当时（已在定时 push 之后）的成色错当成某天快照写进 `progress.json`，污染记录；定时任务失败后用「Re-run」重跑仍是 `schedule` 事件，照常记录
- `GET /api/projects/20315`（公开端点，无需 token）读取 `stats.translated` 与 `stats.total - stats.hidden`，按可见词条计算 `percent = translated / visible`
- `progress/progress.json` 维护 90 天滚动窗口；每次 daily 动 3 天：弃用 90 天前最旧的、settle 阶段回填昨天的 `settled`、update 阶段写今天的 `updated`
- 柱高把百分比线性映射到 `[70, 100]` 视觉带（左下角有「起点 70%」断档标识），颜色 100% 绿 / ≥95% 黄 / 其余红，无数据日全高灰
- **黑白主题**：直出两份 SVG —— `progress/progress.svg`（亮色）与 `progress/progress-dark.svg`（暗色），背景透明，文字/分隔线/无数据灰柱/断档斜线的颜色按主题用**内联属性**烤死（不用 `<style>`/`class`，彩色柱子两套配色一致）。GitHub 把 README 里的 SVG 当隔离的 `<img>` 渲染，SVG 内部的 `prefers-color-scheme` 读不到页面主题，所以不靠 SVG 内媒体查询；改由 README 的 `<picture>` 在页面（主题感知）上下文里选 source
- settle 阶段只写 `progress.json`；update 阶段才落地两份 SVG 与 README，保证产物始终是今天 push 后的最终数字
- `--backfill` 一次性回填整段窗口（按内置 breakpoint 线性插值，固定 PRNG 种子生成 total 序列）；`--no-fetch` 跳过 PT 调用仅重渲 SVG/README
- README 在 `<!-- progress-chart:start/end -->` 之间由脚本每次重写为一个 `<picture>`：`<source media="(prefers-color-scheme: dark)">` 指向暗色 SVG，`<img>` 兜底亮色 SVG。`<img>` 模式（Secure Static Mode）下浏览器不会向 SVG 内部 `<rect>` 派发 hover，逐柱 `<title>` 不触发，因此 `<img title>` 带「近 3 天」整图概览作为 README 上唯一的 hover tooltip

### 6. `restore-and-pack.ts` — 还原换行 + 打包 7z

- 读 `.cache/newlines.json`，优先按每条原始占位还原；若该 key 没有记录且 key 含 `research_page`，优先用 `<BR>`；否则使用文件级最多占位；仍无记录才退为 `\n`
- 合成 `.lang`；空译不写入包内文件（Minecraft 会回落到 `en_US.lang`）
- tips `.txt` 按 `archive/tips/keymap.json` 的英文序合并（**我方 PT 译文优先、Kiwi233 仅补缺**），空行跳过
- 并入 Kiwi 直通文件，按参考包目录结构铺好，`7z -mx=9` 打包到 `$ASSETS_PATH/$ARCHIVE_NAME`
- `PACK_ONLY=1` 环境变量可跳过重建，只重打包（手动重发版用）

随后由 workflow 负责：打 tag、`softprops/action-gh-release@v2` 发 Release、清理过期 daily cache、清理过期 nightly Release。**tag 用 `git push -f` 原地移动、不再 delete+recreate**：删 tag 会把对应已发布 Release 变成 draft，而按 tag 查询的 Release API 看不到 draft，于是下次发布另起一个新 Release、旧 draft 永久残留（按日期去重的清理 job 也碰不到它）；原地移动 tag 则让 Release 留在原处被就地更新（`@v2` 默认 `overwrite_files`，覆盖同名 .7z），实现「同 tag 直接覆盖」。另有一步按 id 删除带 `0-nightly-build/*` tag 名的 draft Release，清掉历史遗留。`progress/` 与 `archive/`（含 `archive/tips/` 的 keymap 与 changelog）的变更由 commit 步骤推回 `master`。

### 手动发版 `release.yml`

发一个「仅含 tag」的 Release（tag 非 `0-nightly-build/**`）即触发。本仓库不把译文文件提交进 git（它们在 PT 上），所以发版**复用 daily 的拉取 + 打包链**、而不是打包 checkout：`generate-gregtech-lang`（`GT5U_LANG_USE_CACHE_ONLY=1`，从 gt5u-lang 缓存还原，不跑 ~40min 的 GT5U 客户端）→ `fetch-en` → `pull-current-18818` → `pull-zh-4964` → `merge-final` → `restore-and-pack`（`ARCHIVE_NAME=${tag}.7z`），产出与 daily 同结构的 7z，再附上 NeverEnoughCharacters-Rework（NEC 重制版）字库，由 `softprops/action-gh-release@v2` 挂到该 tag 的 Release 上。

与 daily 的区别：**只读 PT、不回推**——没有 `sync-terms` / `push-final` / 进度图，也不向仓库 commit 任何东西（fetch-en / pull 写到工作区 `archive/*` 的变更不提交）。缓存按 `gt5u-lang-`、`daily-` 前缀从默认分支（`master`）回退获取（tag ref 取不到自身缓存）；缓存冷时仅换行占位退化为 `\n`，而 GregTech.lang 若无可用缓存则发版失败（需先至少跑过一次 daily）。

---

## 缓存

GitHub Actions `actions/cache@v4` 有两层：

- `gt5u-lang-<branch>-<run_id>-<attempt>`：只存 `.cache/generated-gregtech/`，在 GT5U 步骤成功产出或成功从旧缓存恢复后立刻保存。这样即使后续 PT push / release 失败，也能供下一次 `skip_gt5u=true` 使用。
- `daily-<branch>-<date>`：只存 `.cache` 的其余流水线缓存，按日期保存，同 branch 向后回溯；上游仓库 checkout 不再持久化。

```
.cache/
├─ file-ids/files.json        {pt-path → fileId}
├─ generated-gregtech/
│  ├─ GregTech.lang           上次成功生成的 runtime GregTech.lang
│  └─ metadata.json
└─ newlines.json              {pt-path → {default?: form, entries: {key → form}}}

上游仓库 checkout 临时放在 `.build/repo-cache/`，包括 `translations/`、`modpack/`、`kiwi/`、`gt5u/`；它们不进入 Actions cache。
```

除 `.cache/generated-gregtech/` 可在 GT5U 最新构建失败时兜底外，缓存只用于提速；每天都会重拉 PT 与英文源并本地整合。

---

## 换行符处理

Minecraft 不同 mod / 文件对换行的字面写法不一：`<BR>` / `<br>` / `[br]` / `%n` / 字面 `\n` / 字面 `\\n`。流水线内部统一存真换行。为保证回游戏时渲染正确：

- **嗅探**（fetch-en）：逐词条记录英文原文用哪种形式，并逐文件选出出现最多的形式 → `newlines.json`
- **归一化**（fetch-en + merge-final）：所有形式统一成真换行，避免"格式差异"触发假变更
- **还原**（restore-and-pack）：按每词条原形式把真换行回写成原字面；若 key 包含 `questing.quest` 或 `betterquesting`，优先使用 `%n`；若 key 缺少逐词条记录且包含 `research_page`，优先退到 `<BR>`；其余退到该文件最多的形式。`<BR>` 的任务书仍是 `<BR>`，使用 `[br]` 的仍是 `[br]`，使用 `%n` 的仍是 `%n`，使用 `\n` 的仍是 `\n`，使用 `\\n` 的仍是 `\\n`

### `@LineBreak=` context 标记与"假变更"收敛

上传 PT 时每个词条都带一条 `@LineBreak=<形式>` 的 context 标记，方便校对者看出该词条用哪种换行；**没有嗅到形式的词条统一退到 `\n`**，保证全项目每条都有该标记。

但这条标记是 **由 key + 嗅探形式纯派生出来的元数据**，而 PT 的 artifact 导出（`pull-current-18818` 的主路径）并不回传 context。若把它纳入变更比对，含换行的那批文件（约 67 个）会因为"现网无标记、本地有标记"被永远判为变更，每天空推、并触发上万次 `forced` 译文导入。

因此：**变更检测一律忽略 `@LineBreak=` 标记**——`merge-final` 的 `itemsEqual` 与 `push-final` 的 `importChangedTranslations` 都用 `stripLineBreakContext` 只比对 context 的人工部分。标记本身仍随 source 上传写入 PT，但不再单独驱动推送/导入。校对者新加的真实 context 仍能被检测到。

---

## 绕过 PT 的直通文件

下列文件不进入 PT，打包时从 `Kiwi233/Translation-of-GTNH@master` 直接复制：

- `config/InGameInfoXML/InGameInfo_zh_CN.xml` — 遗留 XML，手工维护
- `config/txloader/forceload/____gtnhoverridenames_zhcn/lang/zh_CN.lang` — 汉化组中文覆盖名，绕开 PT 校对流程
- `resources/minecraft/**` — 打包时落到 `config/txloader/forceload/minecraft/**`，用于补字库

> `config/Betterloadingscreen/tips/zh_CN.txt` 不再是纯直通：它会进入 PT 20315（合成 .lang）；同步与打包都以**我方 PT 译文为准、Kiwi233 仅补缺**。详见下节「tips 稳定 key 注册表」。

---

## tips 稳定 key 注册表

loading-screen 的 tips 是一行一句的纯文本，PT 只能存 key/value。过去按行号给键（`tip.0001…`），英文插入/删除一行就会把后面所有行的内容挪到别的键上，PT 把整条尾巴当成「原文变了」，逐条历史错位、每次同步都要重对齐。

现在改为 **稳定 key 注册表**（`archive/tips/keymap.json`，纳入 git 跟踪、随 daily commit 回推）：

- 每个 tip 首见即分配单调递增、永不复用的 `id`（key = `tip.<id 补零>`）。
- 每次 `fetch-en` 用 LCS 对齐「上次英文序」（`registry.order`）与本次英文：未变保留 key；纯插入分配新 id（或复活文本完全相同的 retired 项）；纯删除标记 retired（保留以备复活）；**同位置一删一增且相似度 ≥ 0.5 判为「改写」**——保留原 key、更新英文，于是 PT 看到「同 key、original 变了」，`merge-final` 的 stale 标记自动保住旧译。
- **两套顺序解耦**：上传 PT 按 `id` 升序（新词条天然追加在末尾，已有行槽位不动，PT diff 最干净）；打包 / 生成 `.txt` 按英文原文序（`registry.order`）。
- 增删改写的人读日志写到 `archive/tips/changelog.md`。

### tips 归属权与新鲜度判定

Kiwi233 的 zh_CN.txt 无逐行原文/时间戳，无法直接判断它的同位行是否过期。因此 `pull-zh-4964` 维护一份快照 `archive/tips/kiwi-seen.json`（每个 key 上次见到的 Kiwi233 行），逐 key 决策：

- 20315 无译文 → Kiwi233 补空缺；
- 20315 与 Kiwi233 一致 → 无冲突；
- 二者不一致、且 Kiwi233 的行相对快照变了 → 采用公开源的新译；
- 二者不一致、但 Kiwi233 的行没变 → 保留我方译文，避免旧译覆盖 PT 上的修正。

首次运行无快照时所有冲突都保留我方。tips 以 Daily 项目为准，仅在本仓库和 PT 20315 中维护，不建立用于回推原汉化仓库的分支。

---

## 仓库结构

```
.github/
├── scripts/daily/
│   ├── lib/
│   │   ├── cache.ts           缓存 I/O（fileIds / newlines / JSON 读写）
│   │   ├── config.ts          常量 / 环境变量
│   │   ├── lang-parser.ts     .lang ↔ PT JSON
│   │   ├── newlines.ts        嗅探 / 归一 / 还原
│   │   ├── path-map.ts        4964 ↔ Daily PT 路径映射、退役后缀
│   │   ├── pt-client.ts       PT REST 客户端（429 退避 / 并发池）
│   │   ├── tips-parser.ts     tips.txt ↔ 合成 .lang
│   │   └── tips-registry.ts   tips 稳定 key 注册表 + LCS 对齐（增删/改写/复活）
│   ├── generate-gregtech-lang.ts 步骤 0
│   ├── fetch-en.ts            步骤 1
│   ├── pull-current-18818.ts  步骤 2
│   ├── pull-zh-4964.ts        步骤 3
│   ├── sync-terms.ts          步骤 3.5
│   ├── merge-final.ts         步骤 4
│   ├── push-final.ts          步骤 5
│   ├── build-progress.ts      步骤 5.5（progress/ 进度图）
│   └── restore-and-pack.ts    步骤 6
├── workflows/
│   ├── daily.yml              每日 sync + build（含 force 手动模式）
│   ├── export-pt-lang-package.yml
│   ├── issue-dispatch.yml     Issue 表单触发固定工作流
│   └── release.yml            手动发版：复用 daily 拉取+打包链（只读 PT）+ NEC 重制版字库
└── ISSUE_TEMPLATE/
    ├── 0-FOS.md
    ├── 1-daily-sync.yml
    └── 2-export-pt-lang-package.yml
```

---

## 必需的 Secrets

| Secret                         | 用途                                                     |
|--------------------------------|----------------------------------------------------------|
| `PARATRANZ_TOKEN`              | ParaTranz API token（需同时有 4964 和 20315 的读写权限） |
| `PARATRANZ_PROJECT_ID`         | 主翻译项目 ID（= `4964`，源）                            |
| `PARATRANZ_DAILY_PROJECT_ID`   | 每日项目 ID（= `20315`，目标）                           |

---

## 本地开发

```bash
bun install                                              # 安装 @types/bun + typescript（仅开发需要）
bun .github/scripts/daily/fetch-en.ts                    # 单步运行任意一步
npx tsc --noEmit                                         # 类型检查
```

脚本都把 `.cache/`、`.build/` 当作可写工作区；安全起见已加入 `.gitignore`。每次运行都会重拉三源并本地整合，缓存只保存必要的 PT 状态与 GT5U 语言文件兜底。
