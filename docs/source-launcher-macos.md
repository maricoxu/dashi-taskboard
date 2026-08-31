# macOS 源码启动器

源码启动器由 launchd 负责常驻。安装器生成的登录项启用 KeepAlive，并设置 5 秒 ThrottleInterval：injector 或 Taskboard 服务异常退出时会自动重启；执行 Taskboard Handoff 前必须先 bootout 该登录项，接收完成后再启动。

源码启动器用于直接运行当前 Git 工作副本，不在 App 中复制第二份 Taskboard 代码，也不创建第二套数据库。适合本地修改、调试和在多台 Mac 上复用同一套安装方法。

## 运行关系

```text
登录启动 / 双击 App
  -> /Applications/Codex Taskboard Source.app
  -> 当前仓库 scripts/codex-injector.mjs
  -> 当前仓库 .data/taskboard.sqlite
  -> ~/Library/Logs/Codex Taskboard/codex-taskboard-source.log
  -> Codex 原生浏览面板或注入入口
```

App 只保存源码目录位置。双击时如果启动器已运行，会发送打开 Taskboard 的信号；没有运行时才启动新实例。

手动执行 `npm run codex:inject -- --watch` 时也会按“仓库 + CDP 端口”复用已有 injector；重复执行不会创建第二个 host，也不会让同一个 iframe 被多个进程同时重载。

## 本机安装

要求：macOS 14+、Node.js 22.5+、已安装官方 ChatGPT/Codex App。

```bash
cd /Users/xuyehua/Code/dashi-taskboard
npm ci
npm run source-launcher:install
```

安装产物：

- App：`/Applications/Codex Taskboard Source.app`
- 登录启动项：`~/Library/LaunchAgents/com.xuyehua.codex-taskboard-source.plist`
- 业务数据：仓库内 `.data/`
- 启动器日志：`~/Library/Logs/Codex Taskboard/codex-taskboard-source.log`
- App 外壳错误：`~/Library/Logs/Codex Taskboard/source-launcher-bootstrap.log`

启动器外壳日志使用本机时区并带 UTC 偏移（例如 `+0800`）；旧记录里以 `Z` 结尾的时间是 UTC 历史日志。

安装完成后会立即启动，并在以后登录 macOS 时自动启动。平时只需要打开 `Codex Taskboard Source.app`。

## 更新源码

先停止并提交自己的修改，再按 fork/upstream 策略同步。依赖或前端变化后执行：

```bash
cd /Users/xuyehua/Code/dashi-taskboard
npm ci
npm run source-launcher:install
```

后端和注入器从仓库直接读取；`source-launcher:install` 会先构建前端，再更新 App 中的源码路径、图标和登录启动项。重新执行安装脚本不会改动 `.data`。

## 复制到另一台 Mac

1. 在目标 Mac 安装官方 ChatGPT/Codex App、Node.js 22.5+ 和 Git。
2. 克隆自己的 fork 到目标 Mac，例如 `~/Code/dashi-taskboard`。
3. 在仓库中运行 `npm ci`、`npm run source-launcher:install`。
4. Taskboard 活动数据库不要直接放进 iCloud。需要迁移任务时，使用现有 Taskboard Handoff 快照流程。

安装脚本会把目标 Mac 的实际仓库路径写入 App 的 `Contents/Resources/source-root`，因此不要求两台机器使用完全相同的用户目录。

## 查看状态

```bash
launchctl print "gui/$UID/com.xuyehua.codex-taskboard-source"
tail -f "$HOME/Library/Logs/Codex Taskboard/codex-taskboard-source.log"
taskctl project list --json
```

调试内嵌面板时，observer 可单独写入新日志文件：

```bash
npm run codex:observe -- --port 9232 \
  --log-file "$HOME/Library/Logs/Codex Taskboard/codex-embed-observer-clean.log"
```

重点查看 `frameReady: true`、`taskboardHostRequest` 和 `taskboardBridge`；iframe 替换时产生的 `ERR_ABORTED` 取消请求属于正常现象。

如果出现 `Taskboard service identity conflict`，说明另一个 launcher 已占用 47823。supervisor 会停止本次启动而不会强杀已有服务；关闭重复的 launcher 后再重试即可。

不要同时运行 `npm run dev`、手动 `npm run codex` 和源码启动器；它们默认共享 `47823`、`.data` 和 runtime 描述。
