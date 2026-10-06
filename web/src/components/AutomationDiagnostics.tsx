import { useState } from "react";
import { useTaskboardI18n } from "../i18n";

export type AutomationDiagnosticReason =
  | "dependency"
  | "existing-binding"
  | "explicit-wait"
  | "execution"
  | "transport"
  | "state";

export type AutomationDiagnosticState =
  | "waiting"
  | "ready"
  | "started"
  | "in_review"
  | "failed"
  | "blocked"
  | "skipped";

export interface AutomationDiagnostic {
  taskId: string;
  identifier: string;
  title: string;
  state: AutomationDiagnosticState;
  reasons: Array<{ reasonCode: AutomationDiagnosticReason; detail: string } | string>;
}

export interface AutomationLastRun {
  state: "starting" | "completed" | "failed";
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

interface AutomationDiagnosticsProps {
  diagnostics: AutomationDiagnostic[];
  compact?: boolean;
  lastRun?: AutomationLastRun;
  error?: string | null;
}

export function AutomationDiagnostics({ diagnostics, compact = false, lastRun, error }: AutomationDiagnosticsProps) {
  const { text, locale } = useTaskboardI18n();
  const [expanded, setExpanded] = useState(!compact);
  if (diagnostics.length === 0 && !lastRun && !error) return null;
  const visible = compact ? diagnostics.slice(0, 5) : diagnostics;
  const hiddenCount = diagnostics.length - visible.length;
  const stateLabels: Record<AutomationDiagnosticState, string> = {
    waiting: text("条件未满足", "Conditions not met"),
    ready: text("待启动", "Ready to start"),
    started: text("已启动", "Started"),
    in_review: text("等你确认", "In review"),
    failed: text("出现错误", "Error"),
    blocked: text("执行受阻", "Blocked"),
    skipped: text("本轮跳过", "Skipped"),
  };
  const failures = diagnostics.filter((item) => item.state === "failed" || item.state === "blocked").length;
  const started = diagnostics.filter((item) => item.state === "started" || item.state === "in_review").length;
  const summary = lastRun?.state === "starting"
    ? text("自动认领处理中", "Auto-claim in progress")
    : lastRun?.state === "failed"
      ? text("自动认领失败", "Auto-claim failed")
      : failures > 0
        ? text(`自动认领：${failures} 项异常`, `Auto-claim: ${failures} error${failures === 1 ? "" : "s"}`)
        : started > 0
          ? text(`自动认领：${started} 项已启动`, `Auto-claim: ${started} started`)
          : text("自动认领已检查", "Auto-claim checked");
  const compactReason = (value: string) => value.split(/\r?\n/)[0].trim().slice(0, 120);
  if (compact && !expanded) {
    return (
      <section className="automation-diagnostics automation-diagnostics-compact-summary" role="status">
        <span className="automation-diagnostics-summary-label">{summary}</span>
        {error && <span className="automation-diagnostics-summary-error">{compactReason(error)}</span>}
        {lastRun?.error && <span className="automation-diagnostics-summary-error">{compactReason(lastRun.error)}</span>}
        <button
          type="button"
          className="automation-diagnostics-summary-action"
          aria-expanded="false"
          onClick={() => setExpanded(true)}
        >
          {text("查看", "Details")}
        </button>
      </section>
    );
  }
  return (
    <section className={`automation-diagnostics${compact ? " is-compact" : ""}`} role="status">
      <div className="automation-diagnostics-heading">
        <strong>{text("自动认领诊断", "Auto-claim diagnostics")}</strong>
        <div className="automation-diagnostics-heading-actions">
          <span>{text(`${diagnostics.length} 项结果`, `${diagnostics.length} results`)}</span>
          {compact && <button type="button" onClick={() => setExpanded(false)}>{text("收起", "Collapse")}</button>}
        </div>
      </div>
      {error && <div role="alert">{text("无法读取自动认领状态：", "Could not read auto-claim status: ")}{error}</div>}
      {lastRun?.state === "starting" && <div>{text("正在扫描并启动本轮任务…", "Scanning and starting tasks…")}</div>}
      {lastRun?.state === "completed" && <div>{failures
        ? text(`最近一轮扫描结束，有 ${failures} 项错误，见下方。`, `Scan finished with ${failures} errors below.`)
        : text("最近一轮扫描结束；已启动的任务继续执行。", "Scan finished; started tasks continue running.")}</div>}
      {lastRun?.state === "failed" && <div className="automation-diagnostic-reason" role="alert">{text("最近一轮失败：", "Last scan failed: ")}{lastRun.error}</div>}
      {lastRun && <time>{text("最近检查：", "Last check: ")}{new Date(lastRun.finishedAt ?? lastRun.startedAt).toLocaleTimeString(locale)}</time>}
      <div className="automation-diagnostics-list">
        {visible.map((diagnostic) => (
          <article className={`automation-diagnostic is-${diagnostic.state}`} key={diagnostic.taskId}>
            <div className="automation-diagnostic-title">
              <b>{diagnostic.identifier}</b>
              <span>{diagnostic.title}</span>
              <b>{stateLabels[diagnostic.state]}</b>
            </div>
            {diagnostic.reasons.length > 0
              ? diagnostic.reasons.map((reason, index) => (
                <div className="automation-diagnostic-reason" key={typeof reason === "string" ? `${reason}-${index}` : reason.reasonCode}>
                  {typeof reason === "string" ? reason : reason.detail}
                </div>
              ))
              : diagnostic.state === "ready" && <div className="automation-diagnostic-reason">
                  {text("满足基本认领条件，等待自动化处理。", "Eligible for the next claim pass.")}
                </div>}
          </article>
        ))}
      </div>
      {hiddenCount > 0 && (
        <div className="automation-diagnostics-more">
          {text(`还有 ${hiddenCount} 个待办未展开`, `${hiddenCount} more todos hidden`)}
        </div>
      )}
    </section>
  );
}
