# Translation-of-GTNH-Daily 工作流重写方案

本文档为工作流全量重写的实施蓝本。废除上游 `MuXiu1997/GTNH-translation-compare`，改为自写 Bun/TypeScript CLI；减少 PT API IO 以防封禁；打包结构对齐 `C:\Users\pinky\Desktop\2.8.4` 参考包。

---

## 1. 目标

- **功能**：每日自动同步上游英文 → PT 18818 → 拉回中文译文 → 打包发版。
- **正确性**：与 PT 4964 人工校对成果同步；换行符每词条 per-entry 原样还原；去重时 daily-history 优先。
- **IO**：PT 调用量由"每日全量"降到"只读 4964 + 本地 diff"；18818 读仅限真正有差异的文件；18818 无全量拉取。
- **打包**：输出路径严格对齐参考包（根目录双 GregTech、`config/txloader/forceload` 保留 `<DisplayName>[<modid>]`、`config/amazingtrophies/` 与 `config/txloader/load/amazingtrophies/` **两份并存**、InGameInfoXML 独立路径）。

---

## 2. 架构总图

```
┌────────────────────── 上游源（只读）──────────────────────┐
│ GTNH-Translations/daily-history                          │
│ GT-New-Horizons-Modpack/config                           │
│ Kiwi233/Translation-of-GTNH/config   (InGameInfoXML·tips) │
│ PT 4964（人工校对）                                      │
└──────────────────────────┬───────────────────────────────┘
                           ▼
        ┌──────── 本 Fork（自写 Bun CLI）────────┐
        │ .github/scripts/daily/                │
        │   ├─ lib/       PT 客户端、lang 解析、  │
        │   │             路径改写、cache I/O    │
        │   ├─ fetch-en.ts                       │
        │   ├─ diff-en.ts                        │
        │   ├─ push-en.ts                        │
        │   ├─ pull-zh-4964.ts                   │
        │   ├─ diff-zh.ts                        │
        │   ├─ push-zh.ts                        │
        │   ├─ pull-final-18818.ts               │
        │   └─ restore-and-pack.ts               │
        │                                        │
        │ Cache (GitHub Actions, key 按日期)：   │
        │   ├─ en-lastrun/        上次上传的英文 │
        │   ├─ zh-lastrun/        上次推送到 PT  │
        │   │                     18818 的 snapshot│
        │   └─ file-ids/          PT 18818       │
        │                         fileId、stringId│
        │                         (按 key)        │
        │   ├─ newlines.json      逐词条换行符    │
        └────────────────────────────────────────┘
                           │
                           ▼
                     PT 18818（自动）
                           │
                           ▼
               0-nightly-build/YYYY-MM-DD Release
```

---

## 3. 源与路径去重

### 3.1 英文源清单

| # | 来源仓库 | 子路径 | 改写后（PT 18818 路径） |
|---|---|---|---|
| A | `GTNewHorizons/GTNH-Translations@master` | `daily-history/GregTech.lang` | `GregTech.lang.json` |
| B | 同上 | `daily-history/resources/<Display>[<id>]/lang/en_US.lang` | `config/txloader/forceload/<Display>[<id>]/lang/zh_CN.lang.json` |
| C | 同上 | `daily-history/config/txloader/load/betterquesting/lang/en_US.lang` | `config/txloader/load/betterquesting/lang/zh_CN.lang.json` |
| D | `GTNewHorizons/GT-New-Horizons-Modpack@master` | `config/txloader/forceload/**/en_US.lang` | `config/txloader/forceload/<segs>/zh_CN.lang.json` |
| E | 同上 | `config/txloader/load/**/en_US.lang` | `config/txloader/load/<segs>/zh_CN.lang.json` |
| F | 同上 | `config/amazingtrophies/lang/en_US.lang` | `config/amazingtrophies/lang/zh_CN.lang.json` |
| G | 同上 | `config/Betterloadingscreen/tips/en_US.txt` | `config/Betterloadingscreen/tips/zh_CN.lang.json`（合成） |

**说明**：
- B 路径改写沿用现 `converter-index.ts` 规则：`resources/<seg>/lang/...` → `config/txloader/forceload/<seg>/lang/...`（保留整段 `<Display>[<id>]`，不塌缩到裸 modid）。
- E 与 C 路径冲突（betterquesting 同时出现在 Modpack/load 与 daily-history）→ **daily-history 胜**。
- E 与 F 路径冲突（`config/txloader/load/amazingtrophies/...` 与 `config/amazingtrophies/...`）→ **两者均保留**，不去重（负责人确认两个都要）。
- G 为合成：按行（去 `#` 注释与空行）编号 `tip.0001 … tip.NNNN`。

### 3.2 去重算法

1. 枚举源 A–C（daily-history 源族），登记其 PT-18818 目标路径集合 `S1`。
2. 枚举源 D–E（Modpack 源族），仅当其 PT-18818 目标路径 ∉ `S1` 时保留。
3. F、G 独立，永不参与去重（它们的目标路径与任何其他源不同）。
4. InGameInfoXML 完全不走此流水线（见 §5.9）。

### 3.3 中文源清单

| 来源 | 子路径 | 用途 |
|---|---|---|
| PT 4964 | 全部文件（约 500+） | 覆盖 A–G 绝大部分 |
| `Kiwi233/Translation-of-GTNH@master` | `config/InGameInfoXML/InGameInfo_zh_CN.xml` | 绕开 PT，直连 raw |
| 同上 | `config/Betterloadingscreen/tips/zh_CN.txt` | 合成 tips 的中文源（上传 PT 之前，与英文按行同构对齐） |
| 同上 | `config/txloader/forceload/____gtnhoverridenames_zhcn/lang/zh_CN.lang` | 汉化组讨论的中文覆盖名，**绕开 PT、整包直通**（仅一个 zh_CN.lang 文件） |

---

## 4. 缓存布局

全部使用 **GitHub Actions Cache**（actions/cache@v4），retention = 7 天足够每日构建。缓存 key：`daily-YYYY-MM-DD`；fallback restore-keys：`daily-`（取最近）。

```
.cache/
├─ en-lastrun/
│  └─ <pt-path>.en.json         每文件一枚，内容 = 上次上传 PT 的
│                               {key, original, stage, context} 列表
├─ zh-lastrun/
│  └─ <pt-path>.zh.json         每文件一枚，内容 = 上次我们成功推送
│                               到 PT 18818 的 {key, translation, stage}
├─ file-ids/
│  ├─ files.json                {pt-path → fileId}
│  └─ <pt-path>.strings.json    {key → stringId} （只给我们真正 push
│                               过或最近 pull 过的文件）
├─ newlines.json                {pt-path → {key → "<BR>"|"<br>"|"\n"}}
└─ pending-update.json          {pt-path → {key → {oldOriginal, newOriginal}}}
                                步骤 2 检测到"英文更新（非新增）"时登记；
                                步骤 5 命中 4964 新汉化时移除；
                                步骤 6 把剩余条目推送"旧译占位"。
```

**不变量**：
- `en-lastrun` 只在 push-en 成功后写入；若 push 失败，上次版本保持。
- `zh-lastrun` 只在 push-zh 成功后写入。
- `file-ids/<pt-path>.strings.json` 在 pull-zh-4964 或 push-en 后可能失效——push-en 重建一个文件时 PT 会分配新 stringId，此时需标记该文件"ID 过期"，下次 push-zh 前主动 GET /strings 刷新。

---

## 5. 10 步详细流程

### 5.1 步骤 1 — `fetch-en`

**输入**：无
**输出**：`.build/en/<pt-path>` 树（每文件 = 归一化后的英文 lang JSON 格式）

**动作**：
1. Sparse-checkout 三个上游仓库到 `.repo.cache/`。
2. 枚举源 A–G，按 §3.2 去重。
3. 对每个保留的英文 `.lang`：
   - 解析为 `{key, value}` 列表（忽略 `#` 注释与纯空行）
   - **换行符嗅探**：扫描 value 找 `<BR>`/`<br>`/`\n`（字面两字符）；若找到，登记到 `newlines.json[pt-path][key]`（优先级：`<BR>` > `<br>` > `\n`，若多种共存按出现顺序取第一）
   - **归一化**：value 中所有 `<BR>`、`<br>`、`\n`（字面）替换为真正的换行 `\n`
4. tips `en_US.txt` 特殊处理：
   - 去除 `#` 注释行与空行
   - 按剩余行号顺序合成 `{key: "tip.0001", value: "<line>"}` 条目
   - 换行符嗅探不适用（tips 每行独立）
5. 将每个文件写为 `.build/en/<pt-path>.en.json`（PT 格式：`[{key, original, translation:"", stage:0}]`）。

**去重示例**：
- daily-history 下 `config/txloader/load/betterquesting/lang/en_US.lang` 登记 `S1`
- Modpack 下 `config/txloader/load/betterquesting/lang/en_US.lang` 改写后路径相同 → 跳过

### 5.2 步骤 2 — `diff-en`（含嗅探 + 变更分类）

换行符嗅探已在步骤 1 完成。此步做 diff 并把每条变更**分类**。

**输入**：`.build/en/`、`en-lastrun/`
**输出**：
- `changed-en.json`（需 push 的文件清单：文件全量替换，粒度到文件即可）
- `pending-update.json`（**逐词条**登记"英文更新（非新增）"的 key → 留给步骤 5/6）

**动作**：
对每个 `.build/en/<pt-path>.en.json`，与 `en-lastrun/<pt-path>.en.json` 逐词条 `{key, original}` 比较，分类如下：

| 情况 | 处理 |
|---|---|
| key 仅出现在新版（新增） | 文件入 `changed-en.json`；**不入** `pending-update`（新增条目本就无旧译） |
| key 两边都有、`original` 一致 | 无变化 |
| key 两边都有、`original` 不同（**更新**） | 文件入 `changed-en.json`；该 key 入 `pending-update[pt-path]` 登记 `{oldOriginal, newOriginal}` |
| key 仅出现在旧版（删除） | 文件入 `changed-en.json`（全量替换会丢掉该条）；不入 `pending-update` |
| 整个文件新增 / 删除 | 文件入 `changed-en.json` |

`stage` 与 `context` 不计入 diff。

### 5.3 步骤 3 — `push-en`

**输入**：`changed-en.json`、`file-ids/files.json`
**输出**：更新后的 `file-ids/files.json`、`en-lastrun/`、标记"ID 过期"的文件集 `stale-ids.json`

**动作**：
对 changed 文件逐个：
- 若 `files.json` 有 fileId → `POST /projects/18818/files/{fileId}`（multipart `file=.json`）
- 否则 → `POST /projects/18818/files`（multipart `file=.json` + `path=<dirname>`）；抓新 fileId 存入 `files.json`
- 将该 pt-path 加入 `stale-ids.json`（文件替换后 stringId 会变）
- 成功后，将本次上传内容写入 `en-lastrun/<pt-path>.en.json`

**并发**：5，429 退避 60s。

### 5.4 步骤 4 — `pull-zh-4964`

**输入**：无
**输出**：`.build/zh-4964/<pt-4964-path>.json`（每文件：`[{key, original, translation, stage}]`）

**动作**：
1. `GET /projects/4964/files` 列全文件
2. 对每个文件 `GET /projects/4964/strings?file={id}&page=…`（分页拉完）
3. 结果写 `.build/zh-4964/`

**并发**：5。
**不做 18818 pull**（这是关键 IO 优化）。

另有独立子任务（并行，完全绕 PT）：
- 从 Kiwi233 raw 下 `config/InGameInfoXML/InGameInfo_zh_CN.xml` → `.build/extra/`
- 从 Kiwi233 raw 下 `config/Betterloadingscreen/tips/zh_CN.txt` → `.build/extra/`
- 从 Kiwi233 raw 下 `config/txloader/forceload/____gtnhoverridenames_zhcn/lang/zh_CN.lang` → `.build/extra/`

### 5.5 步骤 5 — `diff-zh`

**输入**：`.build/zh-4964/`、`zh-lastrun/`、`pending-update.json`、路径映射表
**输出**：
- `push-queue.json`（`[{pt-path, key, translation, stage}]`）
- `files-to-refresh-ids.json`
- 原地修改 `pending-update.json`（把已有新汉化的 key 移除）

**路径映射**（沿用现 `sync-translations-to-project.ts` 规则）：
- 4964 路径 `config/txloader/(load|forceload)/<id>/lang/...` → 18818 路径 `config/txloader/forceload/<Display>[<id>]/lang/...`（按 18818 侧 `files.json` 中 modid-in-brackets 匹配）
- 精确同名文件优先
- 找不到匹配的 4964 文件 → 跳过并记 warn

**diff 逻辑**（对每个 4964 文件的每条 string `s`）：
```
target-path := map(4964-path)
lastrun     := zh-lastrun/<target-path>.zh.json 中 key==s.key 的条目（可能 undefined）

if s.stage < 1 || !s.translation: skip

# 必须 4964 的 original 与步骤 1 归一后的 18818 新英文一致才采用（避免 4964 滞后）
if normalize(s.original) != normalize(.build/en/<target-path>[key].original): skip

# 命中该 key 的新英文，说明 4964 已有对应新译文 → 从 pending-update 移除
pending-update[target-path] 删 s.key

if normalize(s.translation) == normalize(lastrun?.translation) && s.stage == lastrun?.stage:
    skip   # 译文与上次 push 相同，无需再 push

push-queue ← {target-path, key: s.key, translation: normalize(s.translation), stage: s.stage}
```

`normalize` = 把 `<BR>`/`<br>`/字面 `\n` 全部替换为真换行 `\n`（与步骤 1 英文归一一致）。

收集 `push-queue` 中所有唯一的 `target-path` ∪ `pending-update` 中剩余条目所在 pt-path → `files-to-refresh-ids.json`（步骤 6 推"旧译占位"时同样需要 stringId）。

### 5.6 步骤 5.5 — `refresh-ids`

对 `files-to-refresh-ids.json` ∪ `stale-ids.json` 中每个 pt-path：
- `GET /projects/18818/strings?file={fileId}&page=…`（分页）
- 写入 `file-ids/<pt-path>.strings.json` = `{key → id}`

**并发**：5。
**IO 估算**：稳态日若 4964 少量变更 + 少量英文新增 → 每天 10–50 次调用；首次运行则全量（约 500）。

### 5.7 步骤 6 — `push-zh`（含正常 push + 旧译占位 push）

**输入**：`push-queue.json`、`pending-update.json`、`file-ids/<pt-path>.strings.json`、`zh-lastrun/`
**输出**：更新后的 `zh-lastrun/`

**动作**：

**(a) 正常 push**：先把 `push-queue` 逐条补足 `stringId/fileId/original`，再**按批（建议 100 条）**走 strings 批量更新接口：
- 从 `file-ids/<pt-path>.strings.json` 取 `stringId`
- 从 `files.json` 取 `fileId`
- 从 `.build/en/<pt-path>.en.json` 取该 key 的 `original`
- `PUT /projects/18818/strings`，body 为数组：`[{id, key, original, translation, file, stage, context?}]`
- 若批量接口临时异常，再回退单条 `PUT /projects/18818/strings/{stringId}`
- 成功后，更新本地 `zh-lastrun/<pt-path>.zh.json` 的对应条目

**(b) 旧译占位 push**：步骤 5 完成后，`pending-update` 中**剩余**的条目就是"英文更新、但 4964 尚无新译文"。对每条 `{pt-path, key, oldOriginal, newOriginal}`：
- 查 `zh-lastrun/<pt-path>.zh.json` 中该 key 的 `translation`（旧译）。若不存在（曾经无译），跳过并记 warn。
- 组合占位字符串：
  ```
  marker := `${newOriginal}|旧译|${oldChinese}`
  ```
  其中 `oldChinese` 为上次 push 的归一化译文（`\n` 形态）。`newOriginal` 亦为归一化后的新英文。
- 同样补足 `stringId/fileId/original` 后并入批量 `PUT /projects/18818/strings`
- 若批量接口临时异常，再回退单条 `PUT /projects/18818/strings/{stringId}`，body `{key, original, translation: marker, file, stage: 0, context?}`（`stage=0` 以使其进入 PT "未翻译/待审"队列，引人工注意）
- 成功后更新 `zh-lastrun` 对应条目的 `translation = marker, stage = 0`

**并发**：5，429 退避 60s。
**无 ID**：跳过并记 warn（可能是英文刚新增但 ID 尚未 refresh，下次跑会自愈）。

### 5.8 步骤 7 — `pull-final-18818`（含超前翻译）

**PT 18818 允许超前翻译**——译者可能在 18818 上直接编辑、尚未回流 4964。因此终稿**必须**以 18818 现态为准，不能本地合成。

**输入**：PT 18818 当前状态
**输出**：`.build/zh-final/<pt-path>.json`（PT 格式 `[{key, original, translation, stage}]`）

**动作**（走 artifact 以减 IO）：
1. `POST /projects/18818/artifacts` 触发构建，返回 task/artifact 信息
2. 轮询 `GET /projects/18818/artifacts`（或同一接口）直到 `status == completed`；轮询间隔 15s，最多 20 次（5min 超时）
3. `GET /projects/18818/artifacts/download` 下 zip
4. 本地解压 zip 到 `.build/zh-final/`

**若 artifact 接口不可用或失败**：降级方案——对所有 `files.json` 中文件并发 `GET /strings`（约 500 次调用，与 refresh-ids 相同逻辑），重建 `.build/zh-final/`。

### 5.85 步骤 7.5 — 本地重建 .lang（还原换行符）

**输入**：`.build/zh-final/`（步骤 7 产物）、`newlines.json`
**输出**：`.build/zh-lang/<pt-path>.lang`（真·Minecraft lang 文件）

**动作**（**不再用英文做 fallback**）：
对每个 `.build/zh-final/<pt-path>.json`：
- 遍历其中每条 `{key, translation}`
- 查 `newlines.json[pt-path][key]`，把 `translation` 中的 `\n` 替换回该键登记的换行符形态（`<BR>` / `<br>` / `\n`；无登记则保留 `\n`）
- **空译处理**：`translation` 为空字符串或 null → **写出 `key=`（值为空）**，不回退为英文原文；Minecraft 遇空值自会 fallback 到 en_US.lang，这是期望行为
- 文件内 key 顺序沿用 `.build/en/<pt-path>.en.json` 的顺序（保持与英文源一致，便于肉眼 diff）
- 写出 `key=value` 每行

### 5.9 步骤 8 — `restore-and-pack`

**打包结构**（对齐参考包 2.8.4）：

```
<archive>/
├── GregTech_en_US.lang                     ← daily-history/GregTech.lang
├── GregTech_zh_CN.lang                     ← .build/zh-final/GregTech.lang
└── config/
    ├── InGameInfoXML/
    │   └── InGameInfo_zh_CN.xml            ← .build/extra/  (Kiwi233 直拉)
    ├── Betterloadingscreen/
    │   └── tips/
    │       └── zh_CN.txt                   ← .build/zh-final 中 tips 的 lang 回写为 txt
    ├── amazingtrophies/
    │   └── lang/
    │       └── zh_CN.lang                  ← .build/zh-final（Modpack 根 path 源 F）
    └── txloader/
        ├── forceload/
        │   ├── <Display>[<id>]/lang/zh_CN.lang           ← .build/zh-final（源 B、D）
        │   └── ____gtnhoverridenames_zhcn/lang/zh_CN.lang ← .build/extra/（Kiwi233 直拉，
        │                                                    绕 PT，汉化组中文覆盖名）
        └── load/
            └── <segs>/zh_CN.lang           ← .build/zh-final（源 C、E，含
                                               amazingtrophies、customtooltips、
                                               custommainmenu、betterquesting）
```

**注意**：
- amazingtrophies 双份并存（`config/amazingtrophies/` 与 `config/txloader/load/amazingtrophies/`），两路径内容不同。
- customtooltips 只有 `config/txloader/load/customtooltips/lang/zh_CN.lang` 一份；旧 `config/GTNewHorizons/CustomToolTips_zh_CN.xml` **不再生成**。
- 7z 压缩，`-mx=9`；outname = `daily-YYYY-MM-DD.7z`。
- 推 tag `daily-build/YYYY-MM-DD`，发 Release。
- 更新除.github内的所有文件。
- 清理 >7 天的旧 nightly Release / tag。

---

## 6. daily.yml 新骨架

```yaml
name: 0. Daily Sync & Build
on:
  workflow_dispatch:
  schedule:
    - cron: '0 17 * * *'

jobs:
  daily:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - uses: actions/cache@v4
        with:
          path: .cache
          key: daily-${{ env.DATE }}
          restore-keys: daily-

      - run: bun .github/scripts/daily/fetch-en.ts
      - run: bun .github/scripts/daily/diff-en.ts
      - run: bun .github/scripts/daily/push-en.ts
      - run: bun .github/scripts/daily/pull-zh-4964.ts
      - run: bun .github/scripts/daily/diff-zh.ts
      - run: bun .github/scripts/daily/refresh-ids.ts
      - run: bun .github/scripts/daily/push-zh.ts
      - run: bun .github/scripts/daily/pull-final-18818.ts
      - run: bun .github/scripts/daily/restore-and-pack.ts

      - name: Push Tag & Release
        # 沿用现逻辑

  cleanup:
    needs: daily
    # 沿用现 cleanup-outdated-daily-builds 逻辑
```

所有脚本共享环境变量：`PARATRANZ_TOKEN`、`PARATRANZ_PROJECT_ID=4964`、`PARATRANZ_DAILY_PROJECT_ID=18818`、`CACHE_DIR=.cache`、`BUILD_DIR=.build`、`DATE`。

---

## 7. 文件清单

### 7.1 新增
- `.github/scripts/daily/lib/pt-client.ts` — PT API 封装（GET/POST + 429 退避 + 并发池）
- `.github/scripts/daily/lib/lang-parser.ts` — `.lang` ↔ PT JSON 互转
- `.github/scripts/daily/lib/tips-parser.ts` — `tips/*.txt` ↔ 合成 lang
- `.github/scripts/daily/lib/path-map.ts` — 路径去重、路径改写、4964↔18818 映射
- `.github/scripts/daily/lib/cache.ts` — cache I/O
- `.github/scripts/daily/lib/newlines.ts` — 嗅探、归一、还原
- `.github/scripts/daily/fetch-en.ts`
- `.github/scripts/daily/diff-en.ts`
- `.github/scripts/daily/push-en.ts`
- `.github/scripts/daily/pull-zh-4964.ts`
- `.github/scripts/daily/diff-zh.ts`
- `.github/scripts/daily/refresh-ids.ts`
- `.github/scripts/daily/push-zh.ts`
- `.github/scripts/daily/pull-final-18818.ts`
- `.github/scripts/daily/restore-and-pack.ts`

### 7.2 删除
- `.github/scripts/extra-files/` 整目录（xml/tips 合成老逻辑）
- `.github/gtnh-compare-patches/` 整目录（上游 CLI 废除）
- `.github/workflows/purge-workflows.yml` — 逻辑失修，移除
- `.github/scripts/release.ts`（逻辑移入 `restore-and-pack.ts`）
- `.github/scripts/sniff-lang-newlines.ts`（逻辑移入 `lib/newlines.ts`，调用改在 fetch-en 内）
- `.github/scripts/sync-translations-to-project.ts`（由 diff-zh + push-zh 替代）
- `.github/data/lang-newline-cache.json`（改放 GitHub Actions cache）

### 7.3 保留/修改
- `.github/workflows/daily.yml` — 重写
- `.github/workflows/release.yml` — 非 nightly 手动发版仍保留，但重写以用新 pack 脚本
- `.github/ISSUE_TEMPLATE/0-FOS.md` — 不动
- `README.md` — 重写

---

## 8. 开发顺序与 PR 策略

**分支**：新开 `feat/rewrite-daily-pipeline`（从 master 切），PR #7 的 `fix/revert-forceload-rewrite` 关掉即可。

**里程碑**：
1. 搭 `lib/`（6 个模块）+ 单元测试
2. `fetch-en.ts` + `diff-en.ts`（本地跑通：正确枚举、去重、嗅探、合成 tips）
3. `push-en.ts`（**手动 workflow 先跑一次**验证 PT 18818 路径对齐 PT 4964；不要立即覆盖生产）
4. `pull-zh-4964.ts` + `diff-zh.ts`（本地 dry-run：打印 push-queue 长度）
5. `refresh-ids.ts` + `push-zh.ts`（**分批小步快跑**，每批 100 条）
6. `restore-and-pack.ts`（与参考包 `2.8.4` 做 tree diff 验收）
7. 新 `daily.yml` 串全流程，手动跑一次完整 dry-run
8. 写 `README.md`
9. 删除旧文件
10. PR review、合并
11. 更新许可为GPL3.0

**验收红线**：
- 打包输出与 `2.8.4` 参考包的目录树一致（允许部分 lang 文件内容有更新）
- 换行符逐词条原样还原（抽样比对 GregTech.lang 前 20 条和一个长任务书条目）
