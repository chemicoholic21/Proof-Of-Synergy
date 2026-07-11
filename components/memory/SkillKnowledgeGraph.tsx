"use client";

import { useCallback, useEffect, useState } from "react";
import KnowledgeGraph from "./KnowledgeGraph";
import { loadGraphLocal } from "@/lib/candidate";
import type { Dashboard, RecallResult, ReplayEntry, SkillProgress } from "@/lib/memory";

interface GraphResponse {
  dashboard: Dashboard;
  recommendations: unknown[];
  missions: unknown[];
  recall: RecallResult;
  cogneeConfigured: boolean;
}

type Tab = "graph" | "skills" | "communication" | "timeline";

const TABS: { id: Tab; label: string }[] = [
  { id: "graph", label: "Knowledge Graph" },
  { id: "skills", label: "Skill Progress" },
  { id: "communication", label: "Growth Insights" },
  { id: "timeline", label: "Practice Timeline" },
];

export default function SkillKnowledgeGraph({ learnerId }: { learnerId: string }) {
  const [data, setData] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("graph");
  const [replay, setReplay] = useState<{ concept: string; entries: ReplayEntry[] } | null>(null);
  const [cogneeInsight, setCogneeInsight] = useState<string | null>(null);

  // Durable path: derive the dashboard from the browser-held graph so it works on serverless.
  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/memory/graph", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerId, name: null, graph: loadGraphLocal(learnerId) }),
      });
      if (!res.ok) throw new Error(`Failed to load memory (${res.status})`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load memory");
    }
  }, [learnerId]);

  const loadInsight = useCallback(async () => {
    setCogneeInsight(null);
    try {
      const res = await fetch("/api/memory/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ learnerId, graph: loadGraphLocal(learnerId) }),
      });
      if (!res.ok) return;
      const r = await res.json();
      if (r.cogneeInsight) setCogneeInsight(r.cogneeInsight);
    } catch {
      /* best-effort */
    }
  }, [learnerId]);

  useEffect(() => {
    load();
    loadInsight();
  }, [load, loadInsight]);

  const openReplay = useCallback(
    async (concept: string) => {
      setReplay({ concept, entries: [] });
      try {
        const res = await fetch("/api/memory/replay", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ learnerId, concept, graph: loadGraphLocal(learnerId) }),
        });
        const r = await res.json();
        setReplay({ concept, entries: r.entries ?? [] });
      } catch {
        setReplay({ concept, entries: [] });
      }
    },
    [learnerId]
  );

  if (error) return <div className="glass-card p-6 text-red-300">{error}</div>;
  if (!data) return <div className="glass-card p-6 text-zinc-400 animate-pulse">Loading skill memory…</div>;

  const { dashboard: d, recall, cogneeConfigured } = data;
  const isEmpty = d.sessionCount === 0 && d.skills.length === 0;

  if (isEmpty)
    return (
      <div className="glass-card p-8 text-center text-zinc-400">
        <div className="text-4xl mb-3">🧠</div>
        <h3 className="heading-font text-xl font-bold text-white">Start building your Skill Graph</h3>
        <p className="mt-2 text-sm">Complete your first practice session to see your graph grow.</p>
      </div>
    );

  return (
    <div className="flex flex-col gap-5">
      <MemoryHeader d={d} recall={recall} cogneeConfigured={cogneeConfigured} cogneeInsight={cogneeInsight} />

      {/* Tabs (progressive disclosure) */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-4 py-1.5 text-xs font-semibold border transition-colors ${
              tab === t.id
                ? "bg-purple-500/20 border-purple-500/50 text-purple-200"
                : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "graph" && (
        <section className="glass-card p-4 sm:p-6">
          <SectionTitle title="Communication Skill Graph" subtitle="Every node is earned. Click a node to see why it exists, how confident we are, and what it connects to." />
          <KnowledgeGraph graph={d.graph} onReplay={openReplay} />
        </section>
      )}

      {tab === "skills" && <SkillEvidence skills={d.skills} onReplay={openReplay} />}
      {tab === "communication" && <GrowthInsights d={d} />}
      {tab === "timeline" && <PracticeTimeline d={d} onReplay={openReplay} />}

      {replay && <ReplayModal replay={replay} onClose={() => setReplay(null)} />}
    </div>
  );
}

function MemoryHeader({
  d,
  recall,
  cogneeConfigured,
  cogneeInsight,
}: {
  d: Dashboard;
  recall: RecallResult;
  cogneeConfigured: boolean;
  cogneeInsight: string | null;
}) {
  return (
    <div className="glass-card p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold">
            <span className="text-[#c8beac]">Communication Skill Memory</span>
            <span className={`rounded px-1.5 py-0.5 border ${cogneeConfigured ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" : "text-purple-300 border-purple-500/30 bg-purple-500/10"}`}>
              {cogneeConfigured ? "Memory backend live" : "Local graph engine"}
            </span>
          </div>
          <h2 className="heading-font text-2xl font-bold text-white mt-1">{d.name ?? "Your"} communication intelligence</h2>
          <p className="text-sm text-zinc-400 mt-1">
            {d.sessionCount} session{d.sessionCount === 1 ? "" : "s"} remembered · {d.graph.nodes.length} nodes · {d.graph.edges.length} relationships · rev {d.revision}
          </p>
        </div>
        <div className="flex gap-3">
          <Stat label="Overall confidence" value={`${d.overallConfidence}%`} />
          <Stat label="Skills tracked" value={String(d.skills.length)} />
          <Stat label="Needs practice" value={String(recall.weakSkills.length + recall.forgottenSkills.length)} />
        </div>
      </div>
      {cogneeInsight && (
        <div className="mt-4 rounded-xl border border-[#c8beac]/25 bg-[#c8beac]/5 p-3">
          <div className="text-[10px] uppercase tracking-widest font-bold text-[#c8beac] mb-1">
            Recommended focus
          </div>
          <p className="text-[13px] text-zinc-200 whitespace-pre-line">{cogneeInsight}</p>
          <p className="mt-1 text-[10px] text-zinc-500">Graph-grounded answer from memory&apos;s search() over your practice.</p>
        </div>
      )}
      {recall.focusDirectives.length > 0 && (
        <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-950/10 p-3">
          <div className="text-[10px] uppercase tracking-wider font-bold text-cyan-300 mb-1">what we will work on</div>
          <ul className="text-[13px] text-zinc-300 space-y-0.5 list-disc pl-4">
            {recall.focusDirectives.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SkillEvidence({ skills, onReplay }: { skills: SkillProgress[]; onReplay: (c: string) => void }) {
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Skill Progress" subtitle="Every skill carries its demonstrated confidence, retention and supporting evidence." />
      <div className="grid gap-3 sm:grid-cols-2">
        {skills.map((s) => (
          <div key={s.skill} className="rounded-2xl border border-zinc-800 bg-black/30 p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-bold text-white">{s.skill}</span>
                {s.claimedLevel && <span className="ml-2 text-[10px] rounded-full bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-zinc-400">claimed {s.claimedLevel}</span>}
              </div>
              <span className="font-mono text-lg font-black text-purple-300">{s.confidence}%</span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
              <Meter label="Confidence" value={s.confidence} tone="purple" />
              <Meter label="Retention" value={s.retention} tone="cyan" />
            </div>
            {s.trend.length > 1 && (
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-zinc-400">
                <span>Growth:</span>
                {s.trend.map((t, i) => (
                  <span key={i} className="font-mono">
                    {t}
                    {i < s.trend.length - 1 ? " →" : ""}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
              <span>Practiced {s.timesPracticed}×</span>
              {s.supportingMilestones.length > 0 && <span>· {s.supportingMilestones.length} milestone{s.supportingMilestones.length > 1 ? "s" : ""}</span>}
              <span>· last {s.lastSeen}</span>
              <button onClick={() => onReplay(s.skill)} className="ml-auto text-cyan-400 hover:text-cyan-300">
                ▶ replay
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function GrowthInsights({ d }: { d: Dashboard }) {
  const c = d.communication;
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Growth Insights (Communication Trends)" subtitle="Voice & language patterns tracked across every practice session - persistent, not per-session." />
      {c.length === 0 ? (
        <div className="text-sm text-zinc-500">No sessions recorded yet.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <TrendCard title="Confidence" points={c.map((x) => x.confidence)} labels={c.map((x) => `#${x.sessionIndex}`)} suffix="%" higherBetter />
          <TrendCard title="Filler words" points={c.map((x) => x.fillerCount)} labels={c.map((x) => `#${x.sessionIndex}`)} higherBetter={false} />
          <TrendCard title="Vocabulary richness" points={c.map((x) => x.vocabularyRichness)} labels={c.map((x) => `#${x.sessionIndex}`)} suffix="%" higherBetter />
          <TrendCard title="Technical depth" points={c.map((x) => x.technicalDepth)} labels={c.map((x) => `#${x.sessionIndex}`)} suffix="%" higherBetter />
          {c.some((x) => x.speechRateWpm != null) && (
            <TrendCard
              title="Speaking pace (wpm)"
              points={c.map((x) => x.speechRateWpm ?? 0)}
              labels={c.map((x) => `#${x.sessionIndex}`)}
              higherBetter
            />
          )}
        </div>
      )}
    </section>
  );
}

function PracticeTimeline({ d, onReplay }: { d: Dashboard; onReplay: (c: string) => void }) {
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Practice Timeline" subtitle="Automatically generated from the graph - practice sessions and improvement milestones." />
      <ol className="relative border-l border-zinc-800 ml-2">
        {d.timeline.map((e, i) => (
          <li key={i} className="mb-5 ml-5">
            <span
              className={`absolute -left-[7px] mt-1 h-3 w-3 rounded-full border-2 ${
                e.kind === "milestone" ? "bg-emerald-500 border-emerald-300" : "bg-amber-500 border-amber-300"
              }`}
            />
            <div className="text-[11px] text-zinc-500">{new Date(e.date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}</div>
            <div className="font-semibold text-white text-sm">{e.title}</div>
            <div className="text-[12px] text-zinc-400">{e.detail}</div>
          </li>
        ))}
      </ol>
      {d.improvement.filter((s) => s.points.length > 1).length > 0 && (
        <div className="mt-4">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-2">Improvement per skill (Digital Communication DNA)</div>
          <div className="grid gap-2 sm:grid-cols-2">
            {d.improvement
              .filter((s) => s.points.length > 1)
              .map((s) => (
                <button key={s.skill} onClick={() => onReplay(s.skill)} className="flex items-center justify-between rounded-xl border border-zinc-800 bg-black/30 px-3 py-2 hover:border-cyan-500/40 text-left">
                  <span className="text-sm text-white">{s.skill}</span>
                  <span className="font-mono text-xs text-cyan-300">{s.points.join(" → ")}</span>
                </button>
              ))}
          </div>
        </div>
      )}
    </section>
  );
}

function ReplayModal({ replay, onClose }: { replay: { concept: string; entries: ReplayEntry[] }; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onClick={onClose}>
      <div className="glass-card max-h-[85vh] w-full max-w-2xl overflow-y-auto p-6" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-[10px] uppercase tracking-widest text-cyan-300 font-bold">Memory Replay</div>
            <h3 className="heading-font text-xl font-bold text-white">Every time you answered “{replay.concept}”</h3>
          </div>
          <button onClick={onClose} className="text-zinc-500 hover:text-zinc-200">✕</button>
        </div>
        {replay.entries.length === 0 ? (
          <div className="text-sm text-zinc-500">No answers recorded for this topic yet.</div>
        ) : (
          <div className="flex flex-col gap-4">
            {replay.entries.map((e, i) => {
              const prev = replay.entries[i - 1];
              const delta = prev ? e.score - prev.score : 0;
              return (
                <div key={i} className="rounded-2xl border border-zinc-800 bg-black/30 p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-amber-300">Session #{e.sessionIndex}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-sm text-white">{e.score}%</span>
                      {delta !== 0 && <span className={`text-[11px] font-bold ${delta > 0 ? "text-emerald-400" : "text-red-400"}`}>{delta > 0 ? "▲" : "▼"} {Math.abs(delta)}</span>}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] text-zinc-400">{e.scenario}</p>
                  <p className="mt-2 text-[13px] text-zinc-300 italic">“{e.answer}”</p>
                  {e.feedback && <p className="mt-2 text-[11px] text-zinc-500 border-t border-white/5 pt-2">{e.feedback}</p>}
                </div>
              );
            })}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/10 p-3 text-[12px] text-emerald-200">
              {(() => {
                const first = replay.entries[0].score;
                const last = replay.entries[replay.entries.length - 1].score;
                const dd = last - first;
                return dd > 0
                  ? `Confidence on ${replay.concept} grew from ${first}% to ${last}% (+${dd}) across ${replay.entries.length} sessions. This is your memory working.`
                  : `Tracked across ${replay.entries.length} sessions. Keep practising to grow ${replay.concept}.`;
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
      <h3 className="heading-font text-xl font-bold text-white">{title}</h3>
      <p className="text-[13px] text-zinc-400 mt-0.5">{subtitle}</p>
    </div>
  );
}
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-black/30 px-4 py-2 text-center min-w-[92px]">
      <div className="font-mono text-xl font-black text-white">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
    </div>
  );
}
function Meter({ label, value, tone }: { label: string; value: number; tone: "purple" | "cyan" }) {
  const color = tone === "purple" ? "#c8beac" : "#a29c8e";
  return (
    <div>
      <div className="flex justify-between text-zinc-400">
        <span>{label}</span>
        <span className="font-mono text-zinc-200">{value}%</span>
      </div>
      <div className="mt-0.5 h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
    </div>
  );
}
function TrendCard({ title, points, labels, suffix = "", higherBetter }: { title: string; points: number[]; labels: string[]; suffix?: string; higherBetter: boolean }) {
  const max = Math.max(1, ...points);
  const first = points[0] ?? 0;
  const last = points[points.length - 1] ?? 0;
  const improved = higherBetter ? last >= first : last <= first;
  return (
    <div className="rounded-2xl border border-zinc-800 bg-black/30 p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-white">{title}</span>
        <span className={`text-[11px] font-bold ${improved ? "text-emerald-400" : "text-amber-400"}`}>
          {points.map((p) => `${p}${suffix}`).join(" → ")}
        </span>
      </div>
      <div className="mt-3 flex items-end gap-2 h-16">
        {points.map((p, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end gap-1">
            <div className="w-full rounded-t" style={{ height: `${(p / max) * 100}%`, minHeight: 3, background: improved ? "#7f9a78" : "#b8965c", opacity: 0.4 + (0.6 * (i + 1)) / points.length }} />
            <span className="text-[9px] text-zinc-600">{labels[i]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
