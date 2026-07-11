"use client";

import { useCallback, useEffect, useState } from "react";
import GraphCanvas from "./GraphCanvas";
import { loadGraphLocal, saveGraphLocal, clearGraphLocal } from "@/lib/learner";
import type { Dashboard, ReplayEntry, SkillNode, SkillRecallResult } from "@/lib/skill-graph";

interface GraphResponse {
  dashboard: Dashboard;
  recall: SkillRecallResult;
  cogneeConfigured: boolean;
  graph: unknown;
}

type Tab = "graph" | "skills" | "growth" | "sessions";

const TABS: { id: Tab; label: string }[] = [
  { id: "graph", label: "Knowledge Graph" },
  { id: "skills", label: "Skills" },
  { id: "growth", label: "Growth" },
  { id: "sessions", label: "Sessions" },
];

export default function SkillGraphExplorer({ learnerId }: { learnerId: string }) {
  const [data, setData] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("graph");
  const [replay, setReplay] = useState<{ skill: string; entries: ReplayEntry[] } | null>(null);
  const [cogneeInsight, setCogneeInsight] = useState<string | null>(null);

  // Marker semantics: absent = never seeded; a version number = seeded with that baseline
  // version; "forgotten" = the learner explicitly wiped everything (never auto-populate again).
  const seededKey = `synergy.seeded.${learnerId}`;
  const SEED_VERSION = "2";
  // The v1 baseline had 3 sessions; more than that means real practice was added on top,
  // and a baseline upgrade must never overwrite real history.
  const OLD_SEED_MAX_SESSIONS = 3;

  const fetchDashboard = useCallback(
    async (graph: unknown): Promise<GraphResponse> => {
      const res = await fetch("/api/skill-graph", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerId, graph: graph ?? undefined }),
      });
      if (!res.ok) throw new Error(`Failed to load your skill graph (${res.status})`);
      return res.json();
    },
    [learnerId]
  );

  // Durable path: derive the dashboard from the browser-held graph so it works on serverless.
  // A first visit with no history is quietly given a starter practice baseline so the graph
  // never opens empty; real sessions fold into the same graph from then on.
  const load = useCallback(async () => {
    try {
      let d = await fetchDashboard(loadGraphLocal(learnerId));
      const marker = localStorage.getItem(seededKey);
      const isEmpty = d.dashboard.sessionCount === 0 && d.dashboard.skillCount === 0;
      // Seed a first visit; also upgrade a previously-seeded-but-unused graph when the
      // baseline improves (never after an explicit forget, never over real practice history).
      const firstVisit = isEmpty && !marker;
      const staleSeed =
        !isEmpty &&
        !!marker &&
        marker !== "forgotten" &&
        marker !== SEED_VERSION &&
        d.dashboard.sessionCount <= OLD_SEED_MAX_SESSIONS;
      if ((firstVisit || staleSeed) && learnerId !== "anon") {
        const seeded = await fetch("/api/skill-graph/seed", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ learnerId }),
        });
        if (seeded.ok) {
          const s = await seeded.json();
          localStorage.setItem(seededKey, SEED_VERSION);
          saveGraphLocal(learnerId, s.graph);
          d = await fetchDashboard(s.graph);
        }
      }
      setData(d);
      if (d.graph) saveGraphLocal(learnerId, d.graph);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load your skill graph");
    }
  }, [learnerId, seededKey, fetchDashboard]);

  const loadInsight = useCallback(async () => {
    setCogneeInsight(null);
    try {
      const res = await fetch("/api/skill-graph/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerId, graph: loadGraphLocal(learnerId) ?? undefined }),
      });
      if (!res.ok) return;
      const r = await res.json();
      if (r.cogneeInsight) setCogneeInsight(r.cogneeInsight);
    } catch {
      /* best-effort */
    }
  }, [learnerId]);

  useEffect(() => {
    // Sequential so the insight query sees the (possibly just-populated) graph.
    load().then(loadInsight);
  }, [load, loadInsight]);

  const forgetAll = useCallback(async () => {
    if (!window.confirm("Delete your entire skill graph? This clears local memory and your Cognee dataset.")) return;
    setBusy(true);
    try {
      await fetch("/api/skill-graph/forget", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerId, target: { type: "all" } }),
      });
      clearGraphLocal(learnerId);
      // Forgetting is final: the starter baseline never reappears.
      localStorage.setItem(seededKey, "forgotten");
      setData(null);
      await load();
    } finally {
      setBusy(false);
    }
  }, [learnerId, load]);

  const openReplay = useCallback(
    async (skill: string) => {
      setReplay({ skill, entries: [] });
      try {
        const res = await fetch("/api/skill-graph/replay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ learnerId, skill, graph: loadGraphLocal(learnerId) ?? undefined }),
        });
        const r = await res.json();
        setReplay({ skill, entries: r.entries ?? [] });
      } catch {
        setReplay({ skill, entries: [] });
      }
    },
    [learnerId]
  );

  if (error) return <div className="glass-card p-6 text-red-300">{error}</div>;
  if (!data) return <div className="glass-card p-6 text-ink-soft animate-pulse">Loading your skill graph…</div>;

  const { dashboard: d, recall, cogneeConfigured } = data;
  const isEmpty = d.sessionCount === 0 && d.skillCount === 0;

  if (isEmpty)
    return (
      <div className="glass-card p-10 text-center text-ink-soft">
        <h3 className="heading-font text-2xl font-bold text-ink">Your skill graph starts with your first rep</h3>
        <p className="mt-3 text-[15px] max-w-md mx-auto">
          Complete a practice session and every skill you exercise appears here - growing, connecting
          and remembered across visits.
        </p>
        <div className="mt-6 flex items-center justify-center">
          <a href="/practice" className="btn-primary px-6 py-2.5 text-sm">Start practising</a>
        </div>
      </div>
    );

  return (
    <div className="flex flex-col gap-5">
      <GraphHeader d={d} recall={recall} cogneeConfigured={cogneeConfigured} cogneeInsight={cogneeInsight} onForgetAll={forgetAll} busy={busy} />

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold border transition-colors ${
              tab === t.id
                ? "bg-accent/15 border-accent/50 text-ink"
                : "border-line text-ink-soft hover:border-accent/30 hover:text-ink"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "graph" && (
        <section className="glass-card p-4 sm:p-6">
          <SectionTitle
            title="Skill Knowledge Graph"
            subtitle="Every node is earned through practice. Click a node to see how confident you are and what it connects to."
          />
          <GraphCanvas graph={d.graph} onReplay={openReplay} />
        </section>
      )}

      {tab === "skills" && <SkillList skills={d.skills} onReplay={openReplay} />}
      {tab === "growth" && <GrowthTrends d={d} />}
      {tab === "sessions" && <SessionTimeline d={d} />}

      {replay && <ReplayModal replay={replay} onClose={() => setReplay(null)} />}
    </div>
  );
}

function GraphHeader({
  d,
  recall,
  cogneeConfigured,
  cogneeInsight,
  onForgetAll,
  busy,
}: {
  d: Dashboard;
  recall: SkillRecallResult;
  cogneeConfigured: boolean;
  cogneeInsight: string | null;
  onForgetAll: () => void;
  busy: boolean;
}) {
  return (
    <div className="glass-card p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold">
            <span className="text-accent">Skill memory</span>
            <span className={`rounded px-1.5 py-0.5 border ${cogneeConfigured ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" : "text-ink-soft border-line bg-white/5"}`}>
              {cogneeConfigured ? "Cognee live" : "Local graph"}
            </span>
          </div>
          <h2 className="heading-font text-2xl font-bold text-ink mt-1">{d.name ? `${d.name}'s growth` : "Your growth"}</h2>
          <p className="text-sm text-ink-soft mt-1">
            {d.sessionCount} session{d.sessionCount === 1 ? "" : "s"} remembered · {d.graph.nodes.length} nodes · {d.graph.edges.length} relationships
          </p>
        </div>
        <div className="flex gap-3 items-center">
          <Stat label="Confidence" value={`${d.overallConfidence}%`} />
          <Stat label="Skills" value={String(d.skillCount)} />
          <Stat label="To practice" value={String(recall.weak.length)} />
        </div>
      </div>
      {cogneeInsight && (
        <div className="mt-4 rounded-xl border border-accent/25 bg-accent/5 p-3">
          <div className="text-[10px] uppercase tracking-widest font-bold text-accent mb-1">Recommended focus</div>
          <p className="text-[13px] text-ink whitespace-pre-line">{cogneeInsight}</p>
          <p className="mt-1 text-[10px] text-ink-soft">Graph-grounded answer from Cognee&apos;s search over your practice history.</p>
        </div>
      )}
      {recall.suggestedNext && !cogneeInsight && (
        <div className="mt-4 rounded-xl border border-line bg-white/5 p-3 text-[13px] text-ink-soft">
          Next up: practise <span className="text-ink font-semibold">{recall.suggestedNext.name}</span> - it is your
          lowest-confidence skill at {recall.suggestedNext.confidence}%.
        </div>
      )}
      <div className="mt-4 flex justify-end">
        <button onClick={onForgetAll} disabled={busy} className="text-[11px] text-ink-soft hover:text-red-300 underline underline-offset-2 disabled:opacity-40">
          Forget everything (privacy)
        </button>
      </div>
    </div>
  );
}

function SkillList({ skills, onReplay }: { skills: SkillNode[]; onReplay: (s: string) => void }) {
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Skills" subtitle="Rolling confidence per skill, built from every session that exercised it." />
      <div className="grid gap-3 sm:grid-cols-2">
        {skills.map((s) => (
          <div key={s.id} className="rounded-2xl border border-line bg-black/30 p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-bold text-ink">{s.name}</span>
                <span className="ml-2 text-[10px] rounded-full bg-white/5 border border-line px-2 py-0.5 text-ink-soft">{s.level}</span>
              </div>
              <span className="font-mono text-lg font-black text-accent">{s.confidence}%</span>
            </div>
            <div className="mt-3 h-1.5 rounded-full bg-white/5 overflow-hidden">
              <div className="h-full rounded-full bg-accent/80" style={{ width: `${s.confidence}%` }} />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-soft">
              <span>Practised {s.sessions}×</span>
              <span>· {s.category}</span>
              <button onClick={() => onReplay(s.name)} className="ml-auto text-accent hover:text-ink">
                ▶ replay
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GrowthTrends({ d }: { d: Dashboard }) {
  const t = d.trend;
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Growth over time" subtitle="Session-by-session signals - persistent across visits, not per-session." />
      {t.length === 0 ? (
        <div className="text-sm text-ink-soft">No sessions recorded yet.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <TrendCard title="Confidence" points={t.map((x) => x.confidence)} labels={t.map((x) => `#${x.index}`)} suffix="%" higherBetter />
          <TrendCard title="Filler words" points={t.map((x) => x.fillerCount)} labels={t.map((x) => `#${x.index}`)} higherBetter={false} />
          <TrendCard title="Words spoken" points={t.map((x) => x.wordCount)} labels={t.map((x) => `#${x.index}`)} higherBetter />
        </div>
      )}
    </section>
  );
}

function SessionTimeline({ d }: { d: Dashboard }) {
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Practice timeline" subtitle="Every session, in order, with its coaching summary." />
      <ol className="relative border-l border-line ml-2">
        {d.sessions.map((s) => (
          <li key={s.id} className="mb-6 ml-5">
            <span className="absolute -left-[7px] mt-1 h-3 w-3 rounded-full border-2 bg-accent border-accent/50" />
            <div className="text-[11px] text-ink-soft">
              {new Date(s.completedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
            </div>
            <div className="font-semibold text-ink text-sm">{s.scenarioTitle}</div>
            <div className="text-[12px] text-ink-soft">
              Confidence {s.confidence}% · {s.wordCount} words · {s.fillerCount} fillers · {s.coachingEvents} coaching moments
            </div>
            {s.topics?.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {s.topics.map((t) => (
                  <span key={t} className="rounded-full border border-line bg-white/5 px-2 py-0.5 text-[10px] text-ink-soft">
                    {t}
                  </span>
                ))}
              </div>
            )}
            {s.summary && <p className="mt-1.5 text-[12px] leading-relaxed text-ink-soft/90 max-w-xl">{s.summary}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}

function ReplayModal({ replay, onClose }: { replay: { skill: string; entries: ReplayEntry[] }; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="glass-card max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-accent font-bold">Practice replay</div>
            <h3 className="heading-font text-xl font-bold text-ink">How “{replay.skill}” grew</h3>
          </div>
          <button onClick={onClose} className="text-ink-soft hover:text-ink">✕</button>
        </div>
        {replay.entries.length === 0 ? (
          <div className="text-sm text-ink-soft">No sessions have exercised this skill yet.</div>
        ) : (
          <div className="flex flex-col gap-4">
            {replay.entries.map((e, i) => {
              const prev = replay.entries[i - 1];
              const delta = prev ? e.confidence - prev.confidence : 0;
              return (
                <div key={e.sessionId} className="rounded-2xl border border-line bg-black/30 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-accent">{e.scenarioTitle}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-sm text-ink">{e.confidence}%</span>
                      {delta !== 0 && (
                        <span className={`text-[11px] font-bold ${delta > 0 ? "text-emerald-400" : "text-amber-400"}`}>
                          {delta > 0 ? "▲" : "▼"} {Math.abs(delta)}
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="mt-2 text-[12px] text-ink-soft">
                    {new Date(e.completedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })} ·{" "}
                    {e.wordCount} words · {e.fillerCount} fillers
                  </p>
                </div>
              );
            })}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/10 p-3 text-[12px] text-emerald-200">
              {(() => {
                const first = replay.entries[0].confidence;
                const last = replay.entries[replay.entries.length - 1].confidence;
                const dd = last - first;
                return dd > 0
                  ? `Confidence on ${replay.skill} grew from ${first}% to ${last}% (+${dd}) across ${replay.entries.length} sessions. This is your memory working.`
                  : `Tracked across ${replay.entries.length} session${replay.entries.length > 1 ? "s" : ""}. Keep practising to grow ${replay.skill}.`;
              })()}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- small shared UI ----
function SectionTitle({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-4">
      <h3 className="heading-font text-xl font-bold text-ink">{title}</h3>
      <p className="text-[13px] text-ink-soft mt-0.5">{subtitle}</p>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-black/30 px-4 py-2 text-center min-w-[92px]">
      <div className="font-mono text-xl font-black text-ink">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-ink-soft">{label}</div>
    </div>
  );
}
function TrendCard({
  title,
  points,
  labels,
  suffix = "",
  higherBetter,
}: {
  title: string;
  points: number[];
  labels: string[];
  suffix?: string;
  higherBetter: boolean;
}) {
  const max = Math.max(1, ...points);
  const first = points[0] ?? 0;
  const last = points[points.length - 1] ?? 0;
  const improved = higherBetter ? last >= first : last <= first;
  return (
    <div className="rounded-2xl border border-line bg-black/30 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">{title}</span>
        <span className={`text-[11px] font-bold ${improved ? "text-emerald-400" : "text-amber-400"}`}>
          {points.map((p) => `${p}${suffix}`).join(" → ")}
        </span>
      </div>
      <div className="mt-3 flex items-end gap-2 h-16">
        {points.map((p, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1">
            <div
              className="w-full rounded-t"
              style={{
                height: `${(p / max) * 100}%`,
                minHeight: 3,
                background: improved ? "#7f9a78" : "#b8965c",
                opacity: 0.4 + (0.6 * (i + 1)) / points.length,
              }}
            />
            <span className="text-[9px] text-ink-soft/70">{labels[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
