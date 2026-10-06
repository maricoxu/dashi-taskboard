# Codex Taskboard Harness

这套 Harness 用真实的 Taskboard HTTP server，加上受控的 Codex app-server simulator，验证启动、显示、阶段切换、资源观测和自动认领。

## 运行

```bash
npm run test:harness
npm run test:stress
```

也可以直接运行完整测试：

```bash
npm test
```

## 测试层

- `test/harness/taskboard-harness.mjs`：每次在临时目录启动真实 Taskboard server，验证 launcher challenge、HMAC proof、API 和释放。
- `test/harness/codex-api-simulator.mjs`：模拟当前 Taskboard 使用的 app-server 方法：`thread/start`、`thread/resume`、`thread/read`、`turn/start`、`turn/interrupt`，并发送 `turn/started`、`turn/completed`、`turn/failed` 通知。
- `test/harness/renderer-harness.mjs`：模拟 frame mount、unmount、renderer crash 和 recovery，检查重复挂载与释放。
- `test/harness/resource-sampler.mjs`：记录 RSS、heap、CPU 相关系统指标和可选 GPU 显存。macOS 没有可靠的统一显存 API 时明确输出 `unavailable-on-platform`，不伪造数值。
- `test/codex-harness-startup.test.mjs`：启动、health proof、显示挂载和释放 10 轮，以及 crash recovery。
- `test/codex-harness-stage-cycles.test.mjs`：30 轮 thread/turn 阶段循环、interrupt/resume、协议调用集合和内存增长上限。
- `test/codex-harness-auto-claim.test.mjs`：全量 todo、waiting 关键词、独立 thread、失败转 blocked、后续任务继续执行。

## 验收原则

每个场景同时记录三类事实：模拟器调用、Taskboard 实际 API 回执、最终任务/线程状态。只有 API 回执和状态写回满足条件时才算通过。单个任务失败不能结束整轮自动认领。

资源测试当前使用宽松的 RSS 增长上限，避免把 CI 或开发机的正常波动误报成泄漏；如果需要长期运行压测，应另行保存多轮采样结果。GPU 显存采样依赖 `nvidia-smi`，Apple GPU 环境会明确标记不可用。
