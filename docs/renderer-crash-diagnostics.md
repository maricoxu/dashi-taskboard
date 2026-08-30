# Codex Renderer Crash Diagnostics

这份文档记录 Codex Taskboard 内嵌面板导致 renderer 高内存、CDP 断开和自动重启时的标准排查方式。

## 已定位的根因

问题不是单纯的 HTTP 冲突。一次实际事件中，manual profile 的 Codex renderer RSS 在约 44 秒内从 2.1 GB 增长到 14.7 GB，随后 Crashpad 生成 renderer sidecar，并收到 `Inspector.targetCrashed`。系统的 Jetsam 报告也曾记录单个 Codex renderer 约 6.4 GB footprint。

放大回路有三部分：

1. injector 的 heartbeat 每次都调用 `Page.createIsolatedWorld`，重复创建 binding 和 `window.message` listener。
2. heartbeat 超时原先会主动 `cdp.close()`，下一轮又对同一个 renderer 重新注入，进一步累积上下文和监听。
3. Codex 每秒推送全量 host context，Taskboard App 无条件写入新对象，触发 automation reconcile 高频重跑。

现在的实现会复用 execution context；只有 `Runtime.executionContextDestroyed` 或 `Runtime.executionContextsCleared` 才重建。heartbeat 只保留一个 in-flight 操作并指数退避，超时不再主动关闭 CDP；只有 renderer 真正 crash/断开才重连。App 对 host context 做内容去重。

## 标准启动

在同一个源码目录 `/Users/xuyehua/Code/dashi-taskboard` 操作。只保留一个 injector 实例。

1. 启动带 CDP 的 Codex debug profile：

   ```bash
   open -n -a '/Applications/ChatGPT.app' --args \
     '--user-data-dir=/Users/xuyehua/Library/Application Support/Codex Taskboard Manual Debug' \
     --remote-debugging-port=9232 \
     --remote-allow-origins=http://127.0.0.1:9232
   ```

2. 启动 observer（单独终端，持续运行）：

   ```bash
   cd /Users/xuyehua/Code/dashi-taskboard
   npm run codex:observe -- \
     --port 9232 \
     --log-file '/Users/xuyehua/Library/Logs/Codex Taskboard/codex-renderer-diagnostic.log'
   ```

3. 启动源码 injector（另一个终端，持续运行）：

   ```bash
   cd /Users/xuyehua/Code/dashi-taskboard
   npm run codex:inject -- --port 9232 --open --attach-existing
   ```

如果 injector 已经在运行，第二次执行只应复用已有 resident；不要再启动第二个 watcher。需要打开面板时使用已有 injector 的 `--open` 信号即可。

## 修改代码后的流程

修改 `web/src` 后先构建：

```bash
cd /Users/xuyehua/Code/dashi-taskboard
npm run build:web
```

然后让 resident injector 重新加载源码。最稳妥的方式是停止旧 watcher 后重新执行上面的 injector 命令；如果只需要刷新已打开的面板，可以执行：

```bash
node scripts/codex-injector.mjs --refresh-if-running --port 9232
```

resident 启动路径会自动带 `--source-log`，因此无论通过 launcher、daemon 还是 refresh 拉起，都会写 source log。

## 日志位置和判读

- observer：`~/Library/Logs/Codex Taskboard/codex-renderer-diagnostic.log`
- injector/source：`~/Library/Logs/Codex Taskboard/codex-taskboard-source.log`
- Crashpad：`~/Library/Application Support/Codex Taskboard Manual Debug/Crashpad/pending/*.json`
- 系统 Jetsam：`/Library/Logs/DiagnosticReports/JetsamEvent-*.ips`

重点事件：

- `renderer.memory-snapshot`：按 PID 查看 RSS/CPU 是否持续上升。
- `renderer.started` / `renderer.exited`：确认 renderer 是否被替换。
- `crashpad.new`：确认新的 Crashpad renderer sidecar 及 profile。
- `inspector.target-crashed`：确认 CDP 看到的 renderer crash。
- `heartbeat-timeout` / `heartbeat-failed` / `heartbeat-recovered`：确认 host bridge 是否超时、退避和恢复。
- `cdp.closed`：查看 close code/reason 及 `intentional`。heartbeat 超时不应再产生主动 close。
- `network.failed`：带 URL、方法和 resourceType；`/api/events` 或 `/api/local/codex-thread-progress` 的 `ERR_CONNECTION_REFUSED` 表示 Taskboard 服务不可用，需和 renderer 内存事件按时间排序，不能单独当作根因。

日志字段和单行长度已做限制，`data:text/javascript;base64,...` 栈会被压缩，不要删除旧日志，它们用于和新时间窗口对照。

## 在另一个 Codex 窗口继续

可以在另一个 Codex 窗口继续编辑同一份源码，但不要复制启动命令再开一个 watcher。建议顺序是：先确认 `9232` 和现有 resident injector 是否存在，再使用 `npm run build:web` 和 `node scripts/codex-injector.mjs --refresh-if-running --port 9232` 让当前实例加载改动。只有在 Codex debug profile 已退出、确认没有旧 injector 后，才按“标准启动”重新开一套。
