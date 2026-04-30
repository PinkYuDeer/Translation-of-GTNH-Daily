# Translation-of-GTNH-Daily

## GT New Horizons 整合包汉化（每日构建版）

本仓库 Fork 自 [Kiwi233/Translation-of-GTNH](https://github.com/Kiwi233/Translation-of-GTNH)，提供基于 **每日自动同步** 的最新汉化版本。

- 📝 **主翻译项目（人工校对）**：[ParaTranz 项目 4964](https://paratranz.cn/projects/4964) — 由 Kiwi233 团队维护，欢迎参与校对翻译
- 🔄 **每日汉化项目（自动同步）**：[ParaTranz 项目 18818](https://paratranz.cn/projects/18818) — 本仓库每日从上游拉取最新英文原文，把 4964 的校对译文整合进来后整文件同步；在此处新增的汉化不会直接同步到官方仓库，但官方仓库下方建议处会直接检索到相似汉化并一键应用，减轻后续大版本更新的汉化压力。因此也欢迎 Daily 玩家参与超前翻译，想要实时看到变化的可以提交 issue 来打包最新版本汉化。

面向贡献者 / 想了解管道内部实现的读者：请阅读 [PIPELINE.md](PIPELINE.md)（脚本分工、缓存布局、换行符处理、直通文件、Secrets、本地开发等）。

---

## 汉化使用方式

1. 在 [Releases](../../releases) 找到最新或对应日期的版本（tag 形如 `0-nightly-build/YYYY-MM-DD`）
2. 下载 7z 压缩包，覆盖解压到 `.minecraft/` 目录即可

任务书无法正确显示时，可在游戏内输入 `/bq_admin default load`，或右键整合包提供的"默认加载方块"命令方块重载。

---

## 流程图

```
  上游（只读）                       本仓库每日流水线                       产物
 ┌──────────────────────┐          ┌──────────────────────────┐       ┌─────────────────┐
 │ GTNH-Translations    │─英文──┐  │ 1. fetch-en              │       │                 │
 │ GT-New-Horizons-...  │─英文──┼▶│ 2. pull-current-18818    │       │ PT 18818        │
 │ Kiwi233/Translation  │─直通──┘  │ 3. pull-zh-4964          │──合并▶│ （整文件回推）  │
 └──────────────────────┘          │ 3.5 sync-terms           │       │                 │
                                   │ 4. merge-final           │       └────────┬────────┘
 ┌──────────────────────┐          │ 5. push-final            │                │
 │ ParaTranz 4964       │─译文──┐  │ 6. restore-and-pack      │                ▼
 │ ParaTranz 18818      │─超前──┴▶│  （还原换行、打包）       │       ┌─────────────────┐
 └──────────────────────┘          └──────────────────────────┘       │   每日 Release  │
                                                                      └─────────────────┘
```

核心思路：**以上游英文原文为主轴**、**4964 校对译文优先于 18818 存量**、**换行符逐词条原样还原**、**最终打包结构对齐线下参考包**。退役 PT 文件会按打包路径归档到仓库 `archive/` 后从 PT 删除。每日中国时间凌晨 1 点自动触发。

---

## 文件处理表

打包后的所有路径都以 `.minecraft/` 为根。

| 源（上游文件系统）                                                      | 最终落地（整合包内路径）                                                 |
|-------------------------------------------------------------------------|--------------------------------------------------------------------------|
| `GT5-Unofficial` 以 headless `runClient` 运行并关闭窗口后生成的 `GregTech.lang`（失败时用上次成功缓存兜底） | `GregTech_zh_CN.lang` / `GregTech_en_US.lang`                            |
| `daily-history/resources/<Display>[<modid>]/lang/en_US.lang`            | `config/txloader/forceload/<Display>[<modid>]/lang/zh_CN.lang`           |
| `config/txloader/load/<modid>/lang/en_US.lang`                          | `config/txloader/load/<modid>/lang/zh_CN.lang`                           |
| `config/txloader/forceload/<path>/en_US.lang`（Modpack）                | 同目录改名 `zh_CN.lang`                                                  |
| `config/amazingtrophies/lang/en_US.lang`                                | 同目录，且与 `txloader/load/amazingtrophies/...` **两份并存**            |
| `config/Betterloadingscreen/tips/en_US.txt`                             | `config/Betterloadingscreen/tips/zh_CN.txt`                              |
| `config/InGameInfoXML/InGameInfo_zh_CN.xml`（Kiwi233 直通，不进 PT）    | 同路径原样复制                                                           |
| `config/txloader/forceload/____gtnhoverridenames_zhcn/**`（Kiwi233 直通）| 同路径原样复制                                                           |
| `resources/minecraft/**`（Kiwi233 直通，字库等资源）                    | `config/txloader/forceload/minecraft/**`                                 |

> 同一目标路径同时被 `daily-history` 与 `Modpack` 覆盖时（例如 betterquesting），以 `daily-history` 为准。

---

## 主要贡献者

- `Kiwi` — 剩下的所有工作
- `MuXiu1997` — 版本更新自动化比对、PT 推送、自动化打包、每日构建框架
- `PinkYuDeer` — Fork 维护、每日流水线重写（2026/04）、换行符逐词条缓存、路径映射、打包结构对齐
- `ChromicRedBrick` — 任务书校对、汉化
- `Sky_Cat` — 任务书初步汉化
- `huajijam` — 校对 GregTech.lang、汉化 GT++、汉化魔法蜜蜂魔导手册
- `BloCamLimb` — 修改完善任务书 config 生成脚本
- `JackMeds` — 汉化标题画面
- `YPXxiao` — GTNH 介绍文本汉化
- `Wired` — 语言文件提取脚本
- `albus12138` — GT++ 手册汉化工具
- `iouter` — 添加并汉化未能本地化的流体词条
- `wumingzhiren` — igi 血魔法逗号分割

所有在 PT 上参与汉化的 [上游贡献者](https://paratranz.cn/projects/4964/members)、[Daily贡献者](https://paratranz.cn/projects/18818/members)。

老版本翻译主要贡献者：`anti`（GregTech.lang）、`Yesterday`（任务书及构建框架）、`TOCN`、`doctormdk`（早期任务书汉化）。

由于许多汉化都是在模组自带汉化基础上完善的，无法查证所有作者，一并感谢所有曾为汉化作出过贡献的人们！

---

## 关于全角标点和新元素字库

全角标点修复文件和新元素字库文件来源于 `CFPA-Team` 的 [Minecraft-Mod-Language-Package](https://github.com/CFPAOrg/Minecraft-Mod-Language-Package)。

---

## 汉化采用协议

- 汉化文本部分采用 **CC BY-NC-SA 4.0**
- 仓库内脚本与工作流采用 **GPL-3.0**

欢迎更多的人参与到汉化工作中！
