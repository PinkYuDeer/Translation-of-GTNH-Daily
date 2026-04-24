# Translation-of-GTNH-Daily

## GT New Horizons 整合包汉化（每日构建版）

本仓库 Fork 自 [Kiwi233/Translation-of-GTNH](https://github.com/Kiwi233/Translation-of-GTNH)，提供基于 **每日自动同步** 的最新汉化版本。

- 📝 **主翻译项目（人工校对）**：[ParaTranz 项目 4964](https://paratranz.cn/projects/4964) — 由 Kiwi233 团队维护，欢迎参与校对翻译
- 🔄 **每日汉化项目（自动同步）**：[ParaTranz 项目 18818](https://paratranz.cn/projects/18818) — 本仓库每日从上游拉取最新英文原文并同步最新译文

---

## 汉化使用方式

1. 在 [Releases](../../releases) 找到对应日期版本（tag 形如 `0-nightly-build/YYYY-MM-DD`）
2. 下载 7z 压缩包，覆盖解压到 MC 目录

任务书无法正确显示时，可输入 `/bq_admin default load` 或右键"默认加载方块"命令方块重载。

---

## 分支策略

- **`master`**：唯一长期分支，保存工作流与同步脚本
- **Tags / Releases**：每日构建自动生成 `0-nightly-build/YYYY-MM-DD` tag 与对应 Release；超过 7 天的旧 Release 由 cleanup job 自动删除
- 汉化原文历史由上游 [GTNewHorizons/GTNH-Translations](https://github.com/GTNewHorizons/GTNH-Translations) 保存；校对译文由 [PT 项目 4964](https://paratranz.cn/projects/4964) 保存

---

## 自动化同步架构

整条每日流水线由 `daily.yml` 触发，现行为“三源拉取 → 本地整合 → 整文件回推 → 本地打包”。设计目标：**以英文原文为准**、**尽量少打 PT API**、**换行符逐词条原样还原**、**打包结构对齐线下参考包**。

### 数据流

```
 ┌──────────── 上游源（只读、每日 sparse-clone / API 拉取）────────────┐
 │ A. GTNewHorizons/GTNH-Translations  daily-history/                   │
 │ B. GTNewHorizons/GT-New-Horizons-Modpack  config/                    │
 │ C. Kiwi233/Translation-of-GTNH  config/ + resources/minecraft/       │
 │ D. ParaTranz 18818 当前态                                            │
 │ E. ParaTranz 4964 校对译文                                            │
 └────────────────────────────┬─────────────────────────────────────────┘
                              ▼
 ┌──── fetch-en → pull-current-18818 → pull-zh-4964 ────┐
 │ 拉三源：英文、我方 PT 当前态、上游 PT 4964 + 直通文件 │
 └──────────────────────┬────────────────────────────────┘
                        ▼
 ┌────────────── merge-final → push-final ───────────────┐
 │ 以英文 key/original 为准，本地整合我方 PT 与 4964 译文 │
 └──────────────────────┬───────────────────────────────┘
                        ▼
            PT 18818（自动同步项目，整文件更新）
                        ▼
 ┌────────────── restore-and-pack ──────────────┐
 │ 逐词条还原换行符 → 合成 .lang/.txt → 7z 打包 │
 └──────────────────────┬───────────────────────┘
                        ▼
              0-nightly-build/YYYY-MM-DD Release
```

### 6 个步骤

| # | 脚本 | 作用 |
|---|---|---|
| 1 | `fetch-en.ts` | sparse-clone 三个上游 → 枚举英文源 A–G → 去重（daily-history 胜）→ 嗅探换行符写缓存 → 归一化 `\\n` → 输出 `.build/en/` |
| 2 | `pull-current-18818.ts` | 拉取我方 PT 18818 当前文件与词条 → 输出 `.build/zh-current/`，并刷新 `file-ids/files.json` |
| 3 | `pull-zh-4964.ts` | 分页拉取 PT 4964 全部译文 → 输出 `.build/zh-4964/`；并从 Kiwi233 拉直通文件（InGameInfoXML、overridenames_zhcn、tips 中文源、`resources/minecraft`） |
| 4 | `merge-final.ts` | 以英文为准，本地整合 `.build/en/`、`.build/zh-current/`、`.build/zh-4964/` → 生成 `.build/zh-final/` 与 `merge-plan.json` |
| 5 | `push-final.ts` | 按 `merge-plan.json` 整文件回推 PT 18818；新增文件先建英文原文，再逐词条补译；退役文件改名 `*.achive.json` |
| 6 | `restore-and-pack.ts` | 按缓存还原换行符 → 生成 `.lang`/`.txt` → 并入 Kiwi 直通文件 → 7z `-mx=9` |

### 缓存（GitHub Actions `actions/cache@v4`）

```
.cache/
├─ file-ids/files.json                {pt-path → fileId}
└─ newlines.json                      {pt-path → {key → "<BR>"|"<br>"|"\\n"}}

.repo.cache/
├─ translations/                      GTNH-Translations sparse-clone
├─ modpack/                           GT-New-Horizons-Modpack sparse-clone
└─ kiwi/                              Kiwi233/Translation-of-GTNH sparse-clone
```

### 换行符处理

Minecraft 不同 mod/文件对换行的写法不一样：`<BR>` / `<br>` / 字面 `\\n`。PT 内部存真换行。为保证回游戏时渲染正确：

- **嗅探**（fetch-en）：逐词条记录英文原文使用哪种形式 → `newlines.json`
- **归一化**（fetch-en + merge-final）：所有形式统一成真换行，避免格式差触发假变更
- **还原**（restore-and-pack）：按每词条的原形式把真换行回写成原始字面，`<BR>` 的任务书依然 `<BR>`，其他 mod 依然 `\\n`

### 路径重写与去重

| 源（文件系统）                                                   | 目标（PT 18818 路径）                                              |
|------------------------------------------------------------------|--------------------------------------------------------------------|
| `resources/<Display>[<modid>]/lang/en_US.lang`（daily-history）  | `config/txloader/forceload/<Display>[<modid>]/lang/zh_CN.lang.json` |
| `config/txloader/load/<modid>/lang/en_US.lang`                   | 同名改 `zh_CN.lang.json`                                           |
| `config/txloader/forceload/<path>/en_US.lang`（Modpack）         | 同名改 `zh_CN.lang.json`                                           |
| `config/amazingtrophies/lang/en_US.lang`                         | `config/amazingtrophies/lang/zh_CN.lang.json`（与 load/ 两份并存） |
| `config/Betterloadingscreen/tips/en_US.txt`                      | 合成 `tip.0001 … tip.NNNN` 键后按普通文件对待                       |

**去重规则**：如果同一目标路径被 daily-history 与 Modpack 同时产生（例如 betterquesting），**daily-history 胜**。`amazingtrophies` 的根目录版与 `load/` 版各自独立，永远两份并存。

### 绕过 PT 的直通文件

以下文件不进入 PT，打包时从 Kiwi233 master 直接复制：

- `config/InGameInfoXML/InGameInfo_zh_CN.xml`（遗留 XML，手工维护）
- `config/txloader/forceload/____gtnhoverridenames_zhcn/lang/zh_CN.lang`（汉化组中文覆盖名，绕开 PT 校对流程）
- `config/Betterloadingscreen/tips/zh_CN.txt` 的中文行（与英文按行同构对齐后喂给 daily 流水线）
- `resources/minecraft/**`（打包时落到 `config/txloader/forceload/minecraft/**`，用于补字库）

---

## 仓库结构

```
.github/
├── scripts/daily/
│   ├── lib/
│   │   ├── cache.ts           缓存 I/O
│   │   ├── config.ts          常量/环境
│   │   ├── lang-parser.ts     .lang ↔ PT JSON
│   │   ├── newlines.ts        嗅探 / 归一 / 还原
│   │   ├── path-map.ts        4964 ↔ 18818 路径映射
│   │   ├── pt-client.ts       PT REST 客户端（429 退避 / 并发池）
│   │   └── tips-parser.ts     tips.txt ↔ 合成 .lang
│   ├── fetch-en.ts            步骤 1
│   ├── pull-current-18818.ts  步骤 2
│   ├── pull-zh-4964.ts        步骤 3
│   ├── merge-final.ts         步骤 4
│   ├── push-final.ts          步骤 5
│   └── restore-and-pack.ts    步骤 6
├── workflows/
│   ├── daily.yml              每日 sync + build
│   └── release.yml            手动发版（含 NotEnoughCharacters 字库）
└── ISSUE_TEMPLATE/0-FOS.md
```

### 必需的 Secrets

| Secret | 用途 |
|---|---|
| `PARATRANZ_TOKEN` | ParaTranz API token（需同时有 4964 和 18818 的读写权限） |
| `PARATRANZ_PROJECT_ID` | 主翻译项目 ID（= `4964`，源） |
| `PARATRANZ_DAILY_PROJECT_ID` | 每日项目 ID（= `18818`，目标） |

### 本地开发

```bash
bun install          # 仅开发环境需要（@types/bun + typescript）
bun .github/scripts/daily/fetch-en.ts    # 单步运行
npx tsc --noEmit     # 类型检查
```

大部分脚本都接受 `.cache/`、`.build/` 与 `.repo.cache/` 作为可写工作区。每次运行都会重拉三源并本地整合；缓存仅用于提速，不承载正确性。

---

## 主要贡献者

`Kiwi` 剩下的所有工作

`MuXiu1997` 版本更新自动化比对脚本、PT 推送脚本、自动化打包脚本、自动化每日构建脚本

`PinkYuDeer` Fork 维护、每日流水线重写（2026/04）、换行符缓存、路径映射、打包结构对齐

`ChromicRedBrick` 任务书校对、汉化

`Sky_Cat` 任务书初步汉化

`huajijam` 校对 GregTech.lang、汉化 GT++ mod、汉化魔法蜜蜂魔导手册

`BloCamLimb` 修改完善任务书 config 生成脚本

`JackMeds` 汉化标题画面

`YPXxiao` GTNH 介绍文本汉化

`Wired` 语言文件提取脚本

`albus12138` GT++ 手册汉化工具

`iouter` 添加并汉化未能本地化的流体词条

`wumingzhiren` igi 血魔法逗号分割

所有在 PT 上参与汉化工作的 [贡献者](https://paratranz.cn/projects/4964/members)

以及老版本翻译主要贡献者：`anti` 翻译 GregTech.lang、`Yesterday` 汉化任务书及构建框架、`TOCN`、`doctormdk` 早期版本任务书汉化

另外，由于许多汉化都是在模组自带汉化基础上完善的，所以无法得知作者，只能在此一并感谢所有为汉化工作作出过贡献的人们！

---

## 关于全角标点和新元素字库

全角标点修复文件和新元素字库文件来源于 `CFPA-Team` 的 [Minecraft-Mod-Language-Package](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package)

大部分输入法不能输入这些新元素汉字，所以补丁包自带搜索 Mod（`vfyjxf` 提供），可用全拼 + 声调精确搜索。

---

## 汉化采用协议

汉化部分采用 CC-BY-NC-SA 协议

仓库内脚本与工作流采用 GPL-3.0 协议

欢迎更多的人参与到汉化工作中！
