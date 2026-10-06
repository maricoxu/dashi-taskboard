function eligible(task, projectId) {
  return task?.projectId === projectId
    && task.status === "todo"
    && task.archivedAt === null
    && (task.relations?.blockedBy ?? []).every((item) => item.status === "done");
}

function promptFor(task, comments, request) {
  const commentText = comments.length > 0
    ? comments.map((comment) => `- ${comment.authorName} (${comment.createdAt}):\n${comment.body}`).join("\n\n")
    : "（无）";
  return [
    `处理 Taskboard 议题 ${task.identifier}：${task.title}`,
    `工作目录：${request.workspacePath}`,
    "完整描述：",
    task.description || "（无）",
    "全部评论：",
    commentText,
    "",
    "自动认领已由用户开启。不要因为描述中出现历史的等待、尚未授权或评审措辞而跳过；只有实际 API、依赖、版本冲突或明确的当前状态阻塞才停止。完成实现和直接验证后返回改动、验证结果和剩余风险。",
  ].join("\n\n");
}

function isStaleThreadBindingError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found|rollout .*not found|thread .*not found|thread .*closed|session .*not found/i.test(message);
}

export async function dispatchLocalTodos(
  request,
  { request: taskboardRequest, rpc, waitForTurn, stillCurrent, onDiagnostic = async () => {} },
) {
  const listed = await taskboardRequest(
    `/api/tasks?projectId=${encodeURIComponent(request.taskboardProjectId)}&status=todo`,
  );
  const allTasks = await taskboardRequest(
    `/api/tasks?projectId=${encodeURIComponent(request.taskboardProjectId)}`,
  );
  const results = [];
  for (const listedTask of listed.tasks ?? []) {
    if (!stillCurrent()) break;
    const diagnostic = {
      taskId: listedTask.id,
      identifier: listedTask.identifier,
      title: listedTask.title,
      state: "skipped",
      reasons: [],
    };
    let task = null;
    let comments = [];
    let owned = null;
    let threadId = null;
    let target = null;
    let completion;
    let turnAccepted = false;
    let terminalFailure = false;
    const taskPath = `/api/tasks/${encodeURIComponent(listedTask.id)}`;
    const commentsPath = `${taskPath}/comments`;
    const reportError = async (error) => {
      completion?.cancel?.();
      const message = error instanceof Error ? error.message : String(error);
      diagnostic.state = "failed";
      diagnostic.threadId = threadId;
      diagnostic.reasons.push(message);
      // An observer or write-back error does not prove that execution failed.
      // Only a rejected start or an explicit failed/interrupted turn blocks it.
      const uncertain = /timed?\s*out|CDP|WebSocket|renderer/i.test(message);
      if (owned && (terminalFailure || (!turnAccepted && !uncertain))) {
        try {
          const current = (await taskboardRequest(taskPath)).task;
          if (current?.status === "in_progress" && current.threadId === threadId) {
            const blocked = await taskboardRequest(`${taskPath}/move`, {
              method: "POST",
              body: { version: current.version, status: "blocked", threadId, threadBinding: target },
            });
            diagnostic.state = "blocked";
            diagnostic.version = blocked.task.version;
            await taskboardRequest(commentsPath, {
              method: "POST",
              body: { body: `自动执行失败：${message}`, threadId, threadBinding: target },
            });
          }
        } catch (writeError) {
          diagnostic.reasons.push(`状态写回失败：${writeError.message}`);
        }
      }
      await onDiagnostic(diagnostic);
    };
    try {
      const refreshed = await Promise.all([
        taskboardRequest(taskPath),
        taskboardRequest(commentsPath),
      ]);
      task = refreshed[0].task;
      comments = refreshed[1].comments ?? [];
      if (!eligible(task, request.taskboardProjectId) || !stillCurrent()) {
        const dependencies = (task?.relations?.blockedBy ?? []).filter((item) => item.status !== "done");
        diagnostic.state = dependencies.length ? "waiting" : "skipped";
        diagnostic.reasons.push(dependencies.length
          ? `前置任务尚未完成：${dependencies.map((item) => `${item.identifier || item.id} (${item.status})`).join("、")}。完成前置任务或移除不再需要的依赖后可认领。`
          : "任务状态已变化或自动认领已关闭");
        results.push(diagnostic);
        await onDiagnostic(diagnostic);
        continue;
      }
      const savedBinding = task.threadBinding?.codexProjectKind === "local"
        ? task.threadBinding
        : null;
      // A thread already referenced by another task is legacy shared state.
      // Do not resume it: each task must have an independently traceable thread.
      const existing = savedBinding && (
        [...(allTasks.tasks ?? [])].filter((item) => item.id !== task.id)
          .some((item) => (item.threadBinding?.threadId || item.threadId) === savedBinding.threadId)
      ) ? null : savedBinding;
      const bindingMatchesCurrentRuntime = existing
        && existing.codexProjectId === request.codexProjectId
        && existing.codexHostId === request.codexHostId
        && existing.workspacePath === request.workspacePath;
      if (existing && !bindingMatchesCurrentRuntime) {
        diagnostic.reasons.push(
          `旧 thread 绑定上下文已变化，重新创建执行线程（旧项目 ${existing.codexProjectId || "unknown"}，当前项目 ${request.codexProjectId}）`,
        );
      }
      const resumable = bindingMatchesCurrentRuntime ? existing : null;
      target = resumable ?? {
        threadId: null,
        codexProjectId: request.codexProjectId,
        codexProjectKind: "local",
        codexHostId: request.codexHostId,
        workspacePath: request.workspacePath,
      };
      if (resumable) {
        threadId = resumable.threadId;
        try {
          await rpc(resumable.codexHostId, "thread/resume", { threadId });
        } catch (error) {
          if (!isStaleThreadBindingError(error)) throw error;
          // A saved local binding can outlive the Codex rollout/session store.
          // Treat it as stale and create a fresh independent thread now; do
          // not leave the todo task waiting for the next five-minute pass.
          diagnostic.reasons.push(`旧 thread 已失效，重新创建执行线程：${error instanceof Error ? error.message : String(error)}`);
          threadId = null;
          target = {
            threadId: null,
            codexProjectId: request.codexProjectId,
            codexProjectKind: "local",
            codexHostId: request.codexHostId,
            workspacePath: request.workspacePath,
          };
        }
      }
      if (!threadId) {
        const started = await rpc(request.codexHostId, "thread/start", {
          model: request.model,
          cwd: request.workspacePath,
          runtimeWorkspaceRoots: [request.workspacePath],
          approvalPolicy: "never",
          sandbox: "danger-full-access",
        });
        threadId = started?.thread?.id;
        if (typeof threadId !== "string" || !threadId) {
          throw new Error("Codex 未创建执行线程");
        }
        target = { ...target, threadId };
      }
      if (!stillCurrent()) break;
      owned = (await taskboardRequest(`${taskPath}/move`, {
        method: "POST",
        body: {
          version: task.version,
          status: "in_progress",
          threadId,
          threadBinding: target,
        },
      })).task;
      completion = waitForTurn?.prepare(target.codexHostId, threadId);
      const turn = await rpc(request.codexHostId, "turn/start", {
        threadId,
        input: [{ type: "text", text: promptFor(task, comments, request) }],
        effort: request.reasoningEffort,
      });
      const turnId = turn?.turn?.id ?? null;
      turnAccepted = true;
      if (!turnId) throw new Error("Codex 未返回 turnId，执行状态未确认，请查看会话");
      diagnostic.state = "started";
      diagnostic.threadId = threadId;
      diagnostic.turnId = turnId;
      diagnostic.version = owned.version;
      await onDiagnostic(diagnostic);
      if (completion && turnId) {
        const completeTurn = async () => {
          const completed = await completion.wait(turnId);
          if (completed?.status !== "completed") {
            terminalFailure = completed?.status === "failed" || completed?.status === "interrupted";
            throw new Error(completed?.error?.message || `Codex turn ${completed?.status || "failed"}`);
          }
          const current = (await taskboardRequest(taskPath)).task;
          if (current.threadId !== threadId || current.status !== "in_progress") {
            diagnostic.state = current.threadId === threadId && current.status === "in_review" ? "in_review" : "skipped";
            if (diagnostic.state === "skipped") diagnostic.reasons.push("任务已被更新，保留当前状态");
            owned = current;
            await onDiagnostic(diagnostic);
            return;
          }
          owned = current;
          const finalText = completed.items?.slice().reverse()
            .find((item) => item.type === "agentMessage")?.text?.trim() || "自动执行完成。";
          await taskboardRequest(commentsPath, {
            method: "POST",
            body: {
              body: [`自动认领执行完成。`, `- 独立 thread：${threadId}`, "", finalText]
                .join("\n").slice(0, 100_000),
              threadId,
              threadBinding: target,
            },
          });
          const reviewed = await taskboardRequest(`${taskPath}/move`, {
            method: "POST",
            body: {
              version: owned.version,
              status: "in_review",
              threadId,
              threadBinding: target,
            },
          });
          owned = reviewed.task;
          diagnostic.state = "in_review";
          diagnostic.version = owned.version;
          await onDiagnostic(diagnostic);
        };
        if (waitForTurn?.awaitCompletion === false) {
          // Starting a local turn must not hold the automation pass hostage to
          // Codex's rollout observer. Completion is reconciled asynchronously;
          // a real terminal error is written back to the task as blocked.
          void completeTurn().catch(reportError).catch((error) => {
            console.error(`Taskboard local turn reconciliation failed: ${error.message}`);
          });
        } else {
          await completeTurn();
        }
      }
      diagnostic.threadId = threadId;
      diagnostic.turnId = turnId;
      diagnostic.version = owned.version;
      if (owned.status === "in_review") diagnostic.state = "in_review";
      results.push(diagnostic);
    } catch (error) {
      await reportError(error);
      results.push(diagnostic);
    }
  }
  return results;
}
