import { useTaskboardI18n } from "../i18n";

export type AutomationDiagnosticReason = "dependency" | "existing-binding" | "explicit-wait";

export interface AutomationDiagnostic {
  taskId: string;
  identifier: string;
  title: string;
  state: "waiting" | "ready";
  reasons: Array<{ reasonCode: AutomationDiagnosticReason; detail: string }>;
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
}

export function AutomationDiagnostics({ diagnostics, compact = false, lastRun }: AutomationDiagnosticsProps) {
  const { text } = useTaskboardI18n();
  if (diagnostics.length === 0) return null;
  const visible = compact ? diagnostics.slice(0, 5) : diagnostics;
  const hiddenCount = diagnostics.length - visible.length;
  return (
    <section className={`automation-diagnostics${compact ? " is-compact" : ""}`} role="status">
      <div className="automation-diagnostics-heading">
        <strong>{text("自动认领诊断", "Auto-claim diagnostics")}</strong>
        <span>{text(`${diagnostics.length} 个待办`, `${diagnostics.length} todos`)}</span>
      </div>
      {lastRun?.state === "starting" && <div>正在启动本轮自动认领…</div>}
      {lastRun?.state === "completed" && <div>最近一轮已完成。</div>}
      {lastRun?.state === "failed" && <div className="automation-diagnostic-reason">最近一轮失败：{lastRun.error}</div>}
      <div className="automation-diagnostics-list">
        {visible.map((diagnostic) => (
          <article className={`automation-diagnostic is-${diagnostic.state}`} key={diagnostic.taskId}>
            <div className="automation-diagnostic-title">
              <b>{diagnostic.identifier}</b>
              <span>{diagnostic.title}</span>
            </div>
            {diagnostic.reasons.length > 0
              ? diagnostic.reasons.map((reason) => (
                <div className="automation-diagnostic-reason" key={reason.reasonCode}>
                  {reason.detail}
                </div>
              ))
              : <div className="automation-diagnostic-reason">
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
