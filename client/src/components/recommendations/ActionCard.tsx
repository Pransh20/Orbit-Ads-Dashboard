import { useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { api } from "../../api";
import type { ActionItem } from "../../types";

const verdictLabel: Record<string, string> = { GOOD: "Good", AVERAGE: "Average", POOR: "Poor" };

export function ActionCard({ action, onRemove, onNavigate }: { action: ActionItem; onRemove: (id: string) => void; onNavigate: (url: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const act = async () => {
    setError("");
    setLoading(true);
    try {
      const result = await api<{ redirectTo?: string }>(`/recommendations/${action.id}/act`, { method: "POST" });
      onRemove(action.id);
      if (result.redirectTo) onNavigate(result.redirectTo);
    } catch (err: any) {
      setError(err.message || "Could not complete this action");
    } finally {
      setLoading(false);
    }
  };
  const dismiss = async () => {
    onRemove(action.id);
    try { await api(`/recommendations/${action.id}/dismiss`, { method: "POST" }); } catch { /* optimistic dismiss */ }
  };
  return <article className={`action-card priority-${action.priority.toLowerCase()}`}>
    <button className="action-dismiss" onClick={dismiss} aria-label="Dismiss recommendation"><X/></button>
    <span className="priority-badge">{action.priority}</span>
    <h3>{action.headline}</h3>
    <p className="action-campaign">"{action.campaign?.name || "This goal"}"</p>
    {action.keyMetric && <div className="action-metric"><span>{action.keyMetric}</span><b>{action.keyMetricValue || "—"}</b>{action.keyMetricVerdict && <em className={`verdict-${action.keyMetricVerdict.toLowerCase()}`}><i/> {verdictLabel[action.keyMetricVerdict]}</em>}</div>}
    <p>{action.bodyText}</p>
    {error && <small className="action-error">{error}</small>}
    <button className="button primary full" disabled={loading} onClick={act}>{loading ? <RefreshCw className="spin"/> : null}{loading ? "Working..." : action.actionLabel}</button>
  </article>;
}
