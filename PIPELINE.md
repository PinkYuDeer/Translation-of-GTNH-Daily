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
- 手动：Actions 页 `workflow_dispatch`，支持 `force=true` 忽略缓存并把合并后的所有文件重新推到 PT 18818

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

- 克隆/更新 `GTNewHorizons/GT5-Unofficial@master` 到 `.repo.cache/gt5u`
- 在 GitHub Actions 安装 `xvfb` / `xdotool`，用 Java 25 启动 `./gradlew runClient`
- 脚本自启虚拟 X display，侦测 `GregTech.log` 的 `GTMod: PostLoad-Phase finished!` 与客户端 ready marker（默认 `Forge Mod Loader has successfully loaded`），再用 `xdotool` 正常关闭 Minecraft 窗口，等待客户端退出后取完整 `GregTech.lang`
- 输出 `.build/generated-gregtech/GregTech.lang` 与 metadata；若此步失败，工作流直接失败，不回退 `daily-history/GregTech.lang`

### 1. `fetch-en.ts` — 英文原文收集

- Sparse-clone 三个上游仓库到 `.repo.cache/<slug>/`（已存在时只 `fetch + reset --hard`，尽量命中 Actions cache）
- `.build/generated-gregtech/GregTech.lang` 必须存在；`daily-history/GregTech.lang` 不再作为回退来源
- 枚举 A–G 七类英文源（见脚本顶部说明），按 PT 18818 路径写成统一 JSON 骨架
- **去重**：同一目标路径同时来自 `daily-history` 与 `Modpack` 时，`daily-history` 胜
- **换行嗅探**：逐词条识别英文原文使用的是 `<BR>` / `<br>` / 字面 `\n` / `%n`，写入 `.cache/newlines.json`
- 输出：`.build/en/<pt-path>.en.json`（所有值已归一化为真换行）

### 2. `pull-current-18818.ts` — 拉取我方 PT 当前态

- 通过 ParaTranz artifact 端点下载 18818 全量 JSON；artifact 不可用时退回逐文件 `/strings`
- 顺带刷新 `.cache/file-ids/files.json`（PT 路径 → fileId 映射），后续 push/archive 靠它定位
- 输出：`.build/zh-current/<pt-path>.json`（含现网译文 + stage）

### 3. `pull-zh-4964.ts` — 拉取上游校对译文 + Kiwi 直通

- 分页拉取 PT 4964 全部译文，按 18818 的路径规则重写
- 同时从 `Kiwi233/Translation-of-GTNH` 拷贝 **不进 PT** 的直通文件（见下文"直通文件"一节）到临时目录供打包用
- 输出：`.build/zh-4964/<pt-path>.json`

### 3.5 `sync-terms.ts` — 术语表同步

- `GET /projects/4964/terms` → `PUT /projects/18818/terms`
- 保证 18818 的术语表永远跟着 4964 走

### 4. `merge-final.ts` — 本地整合

输入 `.build/en/`、`.build/zh-current/`、`.build/zh-4964/`，生成最终要落的 PT 文件。规则：

- 英文 key/original 为主轴；18818 译文在 key + original 都匹配时保留
- 若 4964 对同 key 有新鲜译文（original 与英文匹配），覆盖 18818 当前译文
- 若英文变了而 4964 没跟上，写入 stale 标记：`${新英文}|旧译：|${旧译文}`，stage=0
- 4964 中英文侧已无的条目/文件一律忽略，不再作为 source-only 补入 18818
- 最终译文 `trim()` 后为空的条目，以原文填入译文并置 stage=1
- 退役文件（英文侧消失）单独记录，后续改名而非删除

输出：
- `.build/zh-final/<pt-path>.json` — 最终 PT 文件内容
- `.build/merge-plan.json` — 本轮要 push / archive 的文件清单；含 `overrideTranslations[]`：需要逐词条覆写现网译文的文件（force 模式 / 现网还带有 `<BR>` 等旧换行占位 / 合成后译文或 stage 与现网不同，都会进这个集合）

### 5. `push-final.ts` — 整文件回推 PT 18818

- 按 `merge-plan.push[]` 用 `POST /files` 整文件替换；`merge-plan.archive[]` 改名为 `*.achive.json`（PT 的归档语义）
- 新文件：先用英文原文 + 空译建文件拿到 stringId，再逐词条补译 —— 这是 PT 对全新文件最稳的路径
- `overrideTranslations[]` 中的文件会在整文件 POST 之后再逐词条覆写（PT 的文件上传接口不更新已有译文）

### 6. `restore-and-pack.ts` — 还原换行 + 打包 7z

- 读 `.cache/newlines.json`，按每条原始占位把真换行还原回 `<BR>` / `<br>` / `\n` / `%n`
- 合成 `.lang` / `tips 的 .txt`；空译写成 `key=`（Minecraft 会回落到 `en_US.lang`）
- 并入 Kiwi 直通文件，按参考包目录结构铺好，`7z -mx=9` 打包到 `$ASSETS_PATH/$ARCHIVE_NAME`
- `PACK_ONLY=1` 环境变量可跳过重建，只重打包（手动重发版用）

随后由 workflow 负责：打 tag、`softprops/action-gh-release` 发 Release、清理过期 daily cache、清理过期 nightly Release。

---

## 缓存

GitHub Actions `actions/cache@v4`，key 以 branch + 日期为作用域，同 branch 向后回溯：

```
.cache/
├─ file-ids/files.json        {pt-path → fileId}
└─ newlines.json              {pt-path → {key → "<BR>"|"<br>"|"\n"|"%n"}}

.repo.cache/
├─ translations/              GTNewHorizons/GTNH-Translations  sparse-clone
├─ modpack/                   GTNewHorizons/GT-New-Horizons-Modpack  sparse-clone
├─ kiwi/                      Kiwi233/Translation-of-GTNH  sparse-clone
└─ gt5u/                      GTNewHorizons/GT5-Unofficial checkout
```

缓存只用于提速，不承载正确性 —— 每天都会重拉三源并本地整合。

---

## 换行符处理

Minecraft 不同 mod / 文件对换行的字面写法不一：`<BR>` / `<br>` / 字面 `\n` / `%n`，PT 内部统一存真换行。为保证回游戏时渲染正确：

- **嗅探**（fetch-en）：逐词条记录英文原文用哪种形式 → `newlines.json`
- **归一化**（fetch-en + merge-final）：所有形式统一成真换行，避免"格式差异"触发假变更
- **还原**（restore-and-pack）：按每词条原形式把真换行回写成原字面，`<BR>` 的任务书仍是 `<BR>`，其他 mod 仍是 `\n`

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
│   │   ├── path-map.ts        4964 ↔ 18818 路径映射、归档后缀
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
│   └── release.yml            手动发版（含 NotEnoughCharacters 字库）
└── ISSUE_TEMPLATE/0-FOS.md
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

脚本都把 `.cache/`、`.build/`、`.repo.cache/` 当作可写工作区；安全起见已加入 `.gitignore`。每次运行都会重拉三源并本地整合，缓存仅用于提速。
