# dsh-armor v0.2 与 dsh-purge 的对齐表

对照基准：`dsh-purge` 1.1.90（Apache-2.0）。本表只列能力项，不复制对方代码。

| 能力 | purge 1.1.90 | dsh-armor v0.2.0 | 状态 |
|---|---|---|---|
| 补丁引擎 | 70 条，加密 slot 表 | 9 条，`patches/host.json`（find/replace/marker） | 有，条数少但覆盖同类引擎点 |
| 解开目录生效 | 有 | 有（`armor apply`） | 对齐 |
| **asar 生效面** | extract-asar + 重打包 | `lib/asar.js` 全量重建 + integrity 重算 + 自校验 + `.armor.bak` | **对齐** |
| shim 启动器 | 覆盖 shim + bin-preflight | `armor shim install`（dsh.cmd/dsh.ps1/dsh/armor.cmd，带 managed 标记） | 对齐 |
| 幂等 / 回滚 | `.dshpurge.bak` + revert | `.armor.bak` + `armor revert [--asar]` | 对齐 |
| 漂移处理 | 显示 pending / 跳过 | `armor resync` 给候选锚点 + 行号 + `--write` 落盘，人工确认 | 略强（可人工重锚） |
| **行为断言** | 无（只看 marker） | `armor verify` 断言"该删的原文是否真没了"，tree / asar 两面分别判 `PATCHED` / `VANILLA` | **强（可证伪）** |
| **asar 锁冲突** | 报错，要人重来 | 自动入延迟队列 `$DSH_HOME/armor/pending.json`，`armor pending run` 补跑，`pending schedule` 注册登录计划任务 | **强** |
| 版本适配 | 声明 0.2.1-rc.2/rc.5，rc.3+ 一律 pending | 声明 0.2.0 / 0.2.1-rc.2 / 0.2.1-rc.5 / 0.2.2-rc.3，实测本机 9/9 | 强（当前宿主有实测） |
| 按模型换提示词 | 加密槽 + 面板逐个模型切 | `promptRouter.byModel` glob + `armor prompt pick` | 对齐（面板换成配置+CLI） |
| workspace baseline 三档 | strict / fallback / always | 同名三档，`lib/prompt-router.js` 纯函数可测 | 对齐 |
| 自更新 | 包更新 + 补丁表更新 | `armor update check/apply/patches`，manifest.json + sha256 + semver 门禁 | 对齐 |
| 发布流水线 | GitHub Releases + 三语文档 | GitHub Actions：测试 → tag 打 tgz → 写真 sha256 manifest → 上传 | 对齐（少 i18n） |
| 红队台账/评分/回放 | 有（redteam/ 一整套） | 无（我们的等价物是 `antigravity-armorbreak` 的 MITM + operator override） | 未做 |
| client UI 面板 | dock 面板 | 无（`dsh-purge-ui` 是给 purge 做的，不是我们的） | 未做 |
| 三语文档 | 英/中/日 | 中（+ 英文摘要） | 未做 |

## v0.3.2：重启验证（副本上真跑过）

`tools/verify-restart.mjs` 把整份安装（1473 MB / 23543 文件）复制到临时目录 → 在副本里重建 `app.asar` → 用隔离 `user-data-dir` 与干净 env 拉起副本的 exe → 观测。

实测（2026-11-18 23:46）：

```
[2/5] 重建 app.asar：补丁 9/9，变更 7 个 entry，自校验 ok（21717 entries）
[3/5] 启动副本 exe
[4/5] 主进程存活: true    致命错: false
[5/5] PASS
```

更硬的证据：副本的 `DSH_HOME` 下被真的建出了 `profiles/desktop/{cordis.yml,cordis.patch.yml,package.json}`、`sessions/`、`storages/` —— 说明 **asar 里的 dsh runtime 被读起来并执行了**，不是只起了个空 Electron 壳。

踩到的两个坑（已写进脚本）：
1. 父进程带着 `ELECTRON_RUN_AS_NODE=1`，exe 会按 node 跑并拒绝所有 Chromium 参数（`bad option: --user-data-dir=…`）。必须清空 `ELECTRON_*` 与 `DSH_*`。
2. 不带 `--user-data-dir` 会去争用正式 profile 的单实例锁 → 缓存报 0x5 后退出。

另：exe 的 fuse 位没能可靠读出来（sentinel 命中落在内嵌 JS 文本里，`ELECTRONASAR` 只在 UTF-16 资源名里出现一次），所以"会不会被拒"最后是靠实测回答的，不靠静态推断。

## v0.3.0 新增

1. **`armor verify`**：每条补丁带 `verify:{absent,present}` 断言（`lib/verify.js`），对 tree 与 asar 分别判定 `PATCHED` / `VANILLA`。这是可证伪的：本机实测 `tree 9/9 PATCHED`、`asar 8/9 仍是原版`，直接说明桌面端此刻跑的仍是官方代码。
2. **asar 锁冲突不丢状态**：宿主运行时 `rename` 会 `EPERM`，现在自动写 `pending.json` 并清掉 200MB 临时档，宿主退出后 `armor pending run` 补跑；`armor pending schedule` 注册 `ONLOGON` 计划任务，下次登录自动补。
3. **`armor dedupe`**：重锚 purge 时三条 id 指向同一段文本，导致同一行被追加多份 `/* [dsh-purge] … */`。现在折叠成一份（`.armor.dedupe.bak` 备份），本机已清 4 个文件。

## v0.2.0 新增的四件事

1. **asar 面**：`lib/asar.js` 解析 Electron asar，按 header 顺序重排 offset、重算每个 entry 的 `integrity.hash` 与 `blocks`，写临时文件后自校验（entry 数、每文件 sha256、尾部对齐），通过才备份 + rename。199 MB 原档的 roundtrip 在 `tests/run.mjs` 里跑过：21717 entry 不变、补丁可读回、无关文件 hash 不动。
2. **漂移自诊断**：`armor resync` 从当前宿主文本里抽独有 token 定位到行，给候选锚点；不自动改写——猜锚点是补丁包最容易出事的地方。
3. **shim**：`dsh` / `dsh.ps1` / `dsh` / `armor.cmd` 写进 `$DSH_HOME/bin`，跑的是解开目录那份代码，绕过 asar，CLI 与 `dsh web` 立刻生效。
4. **自更新**：`manifest.json`（version / tarball / sha256 / patchesSha256 / targets），`armor update check|apply|patches`；补丁表可以单独更新，宿主小版本漂移时不用重装包。

## 已知未做（别当成已完成）

- client UI 面板（要接 `@deepseek-ai/dsh-client-ui-*`，工作量比后端大）
- 红队台账 / 评分 / 报告回放
- 日文文档
- asar 面在宿主运行时重写：Windows 上进程锁着 `app.asar`，`rename` 会失败。所以 `--asar` 必须在宿主完全退出后跑（`armor apply --asar` 会明确报错而不是半写）。
