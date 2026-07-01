import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, RefreshCw } from "lucide-react";
import { api } from "../../api";
import type { ActionItem } from "../../types";
import { ActionCard } from "./ActionCard";

const relativeTime = (value?: string | null) => {
  if (!value) return "Not checked yet — click Refresh";
  const seconds = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return "Last checked: just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `Last checked: ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Last checked: ${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `Last checked: ${days} day${days === 1 ? "" : "s"} ago`;
};

export function RecommendationPanel({ hasCampaigns, lastSyncedAt, onNavigate }: { hasCampaigns: boolean; lastSyncedAt?: string | null; onNavigate: (url: string) => void }) {
  const qc = useQueryClient();
  const [lastChecked, setLastChecked] = useState<string | null>(lastSyncedAt || null);
  const [localActions, setLocalActions] = useState<ActionItem[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [statusIndex, setStatusIndex] = useState(0);
  const recommendations = useQuery({ queryKey: ["recommendations"], queryFn: () => api<ActionItem[]>("/recommendations"), retry: false });
  const actions = localActions ?? recommendations.data ?? [];
  const visible = useMemo(() => (expanded ? actions : actions.slice(0, 8)), [actions, expanded]);
  const generate = useMutation({
    mutationFn: () => api<{ actions: ActionItem[]; generatedAt: string }>("/recommendations/generate", { method: "POST" }),
    onSuccess: result => { setLocalActions(result.actions); setLastChecked(result.generatedAt); qc.invalidateQueries({ queryKey: ["recommendations"] }); qc.invalidateQueries({ queryKey: ["campaigns"] }); },
  });
  useEffect(() => {
    if (!generate.isPending) return;
    const id = window.setInterval(() => setStatusIndex(x => (x + 1) % 3), 2000);
    return () => window.clearInterval(id);
  }, [generate.isPending]);
  const remove = (id: string) => setLocalActions((localActions ?? actions).filter(action => action.id !== id));
  const messages = ["Syncing your ads from Facebook...", "Checking performance data...", "Generating recommendations..."];
  const empty = !hasCampaigns ? "No ads to analyse yet. Create your first ad or connect your Facebook account to import running ads." : lastChecked ? "Everything looks good — no actions needed right now. Check back after your ads have been running for a few days." : "Not checked yet — click Refresh to analyse your ads.";
  return <section className="panel recommendation-panel">
    <div className="recommendation-head"><div><h2>What needs your attention</h2><p>{relativeTime(lastChecked)}</p></div><div><button className="button secondary" disabled={generate.isPending} onClick={() => generate.mutate()}>{generate.isPending ? <RefreshCw className="spin"/> : <RefreshCw/>}{generate.isPending ? "Checking..." : "Refresh"}</button><span className="recommendation-count">{actions.length}</span></div></div>
    {generate.isError && <p className="recommendation-error">{(generate.error as Error).message}</p>}
    {generate.isPending && <><p className="recommendation-progress">{messages[statusIndex]}</p><div className="recommendation-skeletons"><i/><i/><i/></div></>}
    {!generate.isPending && actions.length > 0 && <div className="action-row">{visible.map(action => <ActionCard key={action.id} action={action} onRemove={remove} onNavigate={onNavigate}/>)}</div>}
    {!generate.isPending && actions.length === 0 && <div className="recommendation-empty">{empty}</div>}
    {!generate.isPending && actions.length > 8 && <button className="see-all-recommendations" onClick={() => setExpanded(!expanded)}>{expanded ? "Show fewer recommendations" : `See all ${actions.length} recommendations`} <ChevronRight/></button>}
  </section>;
}
