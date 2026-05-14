# 每日流水线实现细节

面向仓库贡献者 / 想了解管道运作的读者。普通使用者请看 [README.md](README.md)。

---

## 分支策略

- **`master`**：唯一长期分支，保存工作流与同步脚本
- **Tags / Releases**：每日构建自动生成 `0-nightly-build/YYYY-MM-DD` tag 与对应 Release，过期的 Release 由 cleanup job 自动清理
- 汉化原文历史由上游 [GTNewHorizons/GTNH-Translations](https://github.com/GTNewHorizons/GTNH-Translations) 保存；校对译文由 [PT 项目 4964](https://paratranz.cn/projects/4964) 保存

---

## 数据流概览

整条流水线由 [`.github/workflows/daily.yml`](.github/workflows/daily.yml) 触发：

- 定时：中国时间每天凌晨 1 点（UTC 17:00）
- 手动：Actions 页 `workflow_dispatch`，支持 `force=true` 把合并后的所有文件重新推到 PT 18818，也支持 `skip_gt5u=true` 跳过 GT5U `runClient25` 并直接使用缓存的 GregTech.lang；此模式也跳过 Java 与 headless 客户端依赖安装，若该缓存未命中则直接失败，不会回退运行 GT5U
- Issue：Issues 页 `触发 DailySync` 模板会由 [`.github/workflows/issue-dispatch.yml`](.github/workflows/issue-dispatch.yml) 转发为 `workflow_dispatch`，支持同样的 `force` 与 `skip_gt5u` 选项；`触发 Export` 模板会转发到 [`.github/workflows/export-pt-lang-package.yml`](.github/workflows/export-pt-lang-package.yml)

设计目标：**以英文原文为准**、**尽量少打 PT API**、**换行符逐词条原样还原**、**打包结构对齐线下参考包**。

```
 ┌──────────────────────── 上游源（只读） ────────────────────────┐
 │ A0. GTNewHorizons/GT5-Unofficial         runtime GregTech.lang │
 │ A.  GTNewHorizons/GTNH-Translations      daily-history/        │
 │ B.  GTNewHorizons/GT-New-Horizons-Modpack config/              │
 │ C.  Kiwi233/Translation-of-GTNH          config/ + resources/  │
 │ D.  ParaTranz 18818 当前态                                      │
 │ E.  ParaTranz 4964 校对译文                                     │
 └───────────────────────────────┬───────────────────────────────┘
                                 ▼
 generate-gregtech-lang → fetch-en → pull-current-18818 → pull-zh-4964 → sync-terms
                                 ▼
                         merge-final → push-final
                                 ▼
                       PT 18818（整文件更新）
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
- 枚举 A–G 七类英文源（见脚本顶部说明），按 PT 18818 路径写成统一 JSON 骨架
- **去重**：同一目标路径同时来自 `daily-history` 与 `Modpack` 时，`daily-history` 胜
- **换行嗅探**：逐词条识别英文原文使用的是 `<BR>` / `<br>` / `[br]` / `%n` / 字面 `\n` / 字面 `\\n`，并逐文件统计出现最多的形式，写入 `.cache/newlines.json`
- 输出：`.build/en/<pt-path>.en.json`（所有值已归一化为真换行）

### 2. `pull-current-18818.ts` — 拉取我方 PT 当前态

- 通过 ParaTranz artifact 端点下载 18818 全量 JSON；artifact 不可用时退回逐文件 `/files/{fileId}/translation`，避免 `/strings?file=` 漏掉隐藏/未翻译阶段词条
- 顺带刷新 `.cache/file-ids/files.json`（PT 路径 → fileId 映射），后续 push/archive 靠它定位
- 输出：`.build/zh-current/<pt-path>.json`（含现网译文 + stage）

### 3. `pull-zh-4964.ts` — 拉取上游校对译文 + Kiwi 直通

- 通过 ParaTranz artifact 端点下载 4964 全量 JSON；artifact 不可用时退回逐文件 `/files/{fileId}/translation`
- 下载后统一清理 4964 旧 key 前缀（如 `lang|` / `gt-lang|`），后续合并再按 18818 目标文件解析
- 同时从 `Kiwi233/Translation-of-GTNH` 拷贝 **不进 PT** 的直通文件（见下文"直通文件"一节）到临时目录供打包用
- 输出：`.build/zh-4964/<pt-path>.json`

### 3.5 `sync-terms.ts` — 术语表同步

- `GET /projects/4964/terms` → `PUT /projects/18818/terms`
- 保证 18818 的术语表永远跟着 4964 走

### 4. `merge-final.ts` — 本地整合

输入 `.build/en/`、`.build/zh-current/`、`.build/zh-4964/`，生成最终要落的 PT 文件。规则：

- 英文 key/original 为主轴；18818 译文在 key + original 都匹配时保留
- 英文原文 `trim()` 后为空的词条在采集阶段即丢弃；若整份英文文件无有效词条，则不再作为活跃文件进入 PT，现网旧副本会走归档删除
- 若 4964 对同 key 有新鲜译文（original 与英文匹配），会填补 18818 空缺；若 18818 与 4964 已有不同译文，merge 会按需调用 `/strings?file=...` 查询两端行级时间，4964 更新或远端时间仍缺时采纳 4964，否则保留 18818
- 若英文变了而 4964 没跟上，写入 stale 标记：`${新英文}|旧译：|${旧译文}`，stage=0
- 4964 中英文侧已无的条目/文件一律忽略，不再作为 source-only 补入 18818
- 最终译文 `trim()` 后为空的条目保持空译并置 stage=0；已有 18818 译文即使等于原文也保留，因为颜色值、ID、数字等词条常以原文作合法译文
- 退役文件（英文侧消失，或已带 `.disable` / `.achive` 等旧后缀）与活跃文件内已移除词条单独记录，后续归档到仓库并从 PT 删除

输出：
- `.build/zh-final/<pt-path>.json` — 最终 PT 文件内容
- `.build/merge-plan.json` — 本轮要 push / archive 的文件清单；含 `archiveStrings{}`：活跃文件中已从英文源移除、需并入仓库 `archive/` 的旧词条。`overrideTranslations[]` 仅作兼容诊断，push 阶段不再逐词 PUT
- artifact 拉取的 JSON 通常无行级时间戳；冲突裁决才会额外走 `/strings?file=...` 查询 `createdAt/updatedAt/uid`，同文件多词冲突会复用一次查询结果

### 5. `push-final.ts` — 整文件回推 PT 18818

- 按 `merge-plan.push[]` 用 `POST /files` 上传仅含原文的 JSON；此接口只更新 original，不写译文
- 源文件上传后重新读取该文件词条，把译文/stage 有差异的行组为小 JSON，走 `POST /projects/{projectId}/files/{fileId}/translation` 导入译文；普通差异非强制导入，空译清理或仅 stage 差异用 `force=true` 片段导入
- `merge-plan.archiveStrings{}` 先按打包路径与仓库 `archive/` 旧文件合并，再由源文件更新移除 PT 内旧词条
- `merge-plan.archive[]` 先按打包路径与仓库 `archive/` 旧文件合并，再调用 `DELETE /projects/{projectId}/files/{fileId}` 从 PT 删除

### 6. `restore-and-pack.ts` — 还原换行 + 打包 7z

- 读 `.cache/newlines.json`，优先按每条原始占位还原；若该 key 没有记录且 key 含 `research_page`，优先用 `<BR>`；否则使用文件级最多占位；仍无记录才退为 `\n`
- 合成 `.lang` / `tips 的 .txt`；空译不写入包内文件（Minecraft 会回落到 `en_US.lang`）
- 并入 Kiwi 直通文件，按参考包目录结构铺好，`7z -mx=9` 打包到 `$ASSETS_PATH/$ARCHIVE_NAME`
- `PACK_ONLY=1` 环境变量可跳过重建，只重打包（手动重发版用）

随后由 workflow 负责：打 tag、`softprops/action-gh-release` 发 Release、清理过期 daily cache、清理过期 nightly Release。

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

---

## 绕过 PT 的直通文件

下列文件不进入 PT，打包时从 `Kiwi233/Translation-of-GTNH@master` 直接复制：

- `config/InGameInfoXML/InGameInfo_zh_CN.xml` — 遗留 XML，手工维护
- `config/txloader/forceload/____gtnhoverridenames_zhcn/lang/zh_CN.lang` — 汉化组中文覆盖名，绕开 PT 校对流程
- `config/Betterloadingscreen/tips/zh_CN.txt` — 中文行与英文按行同构对齐后喂给 daily 流水线
- `resources/minecraft/**` — 打包时落到 `config/txloader/forceload/minecraft/**`，用于补字库

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
│   │   ├── path-map.ts        4964 ↔ 18818 路径映射、退役后缀
│   │   ├── pt-client.ts       PT REST 客户端（429 退避 / 并发池）
│   │   └── tips-parser.ts     tips.txt ↔ 合成 .lang
│   ├── generate-gregtech-lang.ts 步骤 0
│   ├── fetch-en.ts            步骤 1
│   ├── pull-current-18818.ts  步骤 2
│   ├── pull-zh-4964.ts        步骤 3
│   ├── sync-terms.ts          步骤 3.5
│   ├── merge-final.ts         步骤 4
│   ├── push-final.ts          步骤 5
│   └── restore-and-pack.ts    步骤 6
├── workflows/
│   ├── daily.yml              每日 sync + build（含 force 手动模式）
│   ├── export-pt-lang-package.yml
│   ├── issue-dispatch.yml     Issue 表单触发固定工作流
│   └── release.yml            手动发版（含 NotEnoughCharacters 字库）
└── ISSUE_TEMPLATE/
    ├── 0-FOS.md
    ├── 1-daily-sync.yml
    └── 2-export-pt-lang-package.yml
```

---

## 必需的 Secrets

| Secret                         | 用途                                                     |
|--------------------------------|----------------------------------------------------------|
| `PARATRANZ_TOKEN`              | ParaTranz API token（需同时有 4964 和 18818 的读写权限） |
| `PARATRANZ_PROJECT_ID`         | 主翻译项目 ID（= `4964`，源）                            |
| `PARATRANZ_DAILY_PROJECT_ID`   | 每日项目 ID（= `18818`，目标）                           |

---

## 本地开发

```bash
bun install                                              # 安装 @types/bun + typescript（仅开发需要）
bun .github/scripts/daily/fetch-en.ts                    # 单步运行任意一步
npx tsc --noEmit                                         # 类型检查
```

脚本都把 `.cache/`、`.build/` 当作可写工作区；安全起见已加入 `.gitignore`。每次运行都会重拉三源并本地整合，缓存只保存必要的 PT 状态与 GT5U 语言文件兜底。
