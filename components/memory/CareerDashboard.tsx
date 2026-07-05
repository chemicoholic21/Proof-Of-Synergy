"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import KnowledgeGraph from "./KnowledgeGraph";
import type { Dashboard, Recommendation, LearningMission, RecallResult, ReplayEntry, RealityGapItem, SkillCard } from "@/lib/memory";

interface GraphResponse {
  dashboard: Dashboard;
  recommendations: Recommendation[];
  missions: LearningMission[];
  recall: RecallResult;
  cogneeConfigured: boolean;
}

type Tab = "graph" | "reality" | "skills" | "roadmap" | "communication" | "timeline";

const TABS: { id: Tab; label: string }[] = [
  { id: "graph", label: "Knowledge Graph" },
  { id: "reality", label: "Reality Gap" },
  { id: "skills", label: "Skill Evidence" },
  { id: "roadmap", label: "Learning Roadmap" },
  { id: "communication", label: "Communication" },
  { id: "timeline", label: "Timeline" },
];

export default function CareerDashboard({ candidateId, company }: { candidateId: string; company?: string | null }) {
  const [data, setData] = useState<GraphResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("graph");
  const [replay, setReplay] = useState<{ concept: string; entries: ReplayEntry[] } | null>(null);
  const [cogneeInsight, setCogneeInsight] = useState<string | null>(null);
  const [ghUser, setGhUser] = useState("");
  const [ghBusy, setGhBusy] = useState(false);
  const [ghMsg, setGhMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const q = new URLSearchParams({ candidateId });
      if (company) q.set("company", company);
      const res = await fetch(`/api/memory/graph?${q.toString()}`);
      if (!res.ok) throw new Error(`Failed to load memory (${res.status})`);
      setData(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load memory");
    }
  }, [candidateId, company]);

  // Cognee-driven "what should I study next" — a graph-grounded answer straight from Cognee's memory.
  const loadInsight = useCallback(async () => {
    setCogneeInsight(null);
    try {
      const res = await fetch("/api/memory/recall", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId, company: company || null }),
      });
      if (!res.ok) return;
      const r = await res.json();
      if (r.cogneeInsight) setCogneeInsight(r.cogneeInsight);
    } catch {
      /* best-effort */
    }
  }, [candidateId, company]);

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
          body: JSON.stringify({ candidateId, concept }),
        });
        const r = await res.json();
        setReplay({ concept, entries: r.entries ?? [] });
      } catch {
        setReplay({ concept, entries: [] });
      }
    },
    [candidateId]
  );

  async function connectGithub() {
    if (!ghUser.trim()) return;
    setGhBusy(true);
    setGhMsg(null);
    try {
      const res = await fetch("/api/memory/github", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId, username: ghUser.trim() }),
      });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || "GitHub import failed");
      setGhMsg(`Imported @${r.profile.username}: ${r.profile.repoCount} repos, ${r.profile.technologies.length} technologies.`);
      setGhUser("");
      await load();
    } catch (e) {
      setGhMsg(e instanceof Error ? e.message : "GitHub import failed");
    } finally {
      setGhBusy(false);
    }
  }

  if (error) return <div className="glass-card p-6 text-red-300">{error}</div>;
  if (!data) return <div className="glass-card p-6 text-zinc-400 animate-pulse">Loading career memory…</div>;

  const { dashboard: d, recommendations, missions, recall, cogneeConfigured } = data;
  const isEmpty = d.interviewCount === 0 && d.skills.length === 0;

  if (isEmpty)
    return (
      <div className="glass-card p-8 text-center text-zinc-400">
        <div className="text-4xl mb-3">🧠</div>
        <h3 className="heading-font text-xl font-bold text-white">No career memory yet</h3>
        <p className="mt-2 text-sm">Upload a resume and finish an interview — or load the demo — to start building your Career Knowledge Graph.</p>
      </div>
    );

  return (
    <div className="flex flex-col gap-5">
      <MemoryHeader d={d} recall={recall} cogneeConfigured={cogneeConfigured} cogneeInsight={cogneeInsight} company={company} />

      {/* GitHub evidence import — a third, independent evidence source for the Reality Gap. */}
      <div className="glass-card p-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <span className="text-lg">🐙</span>
          <span className="font-semibold">Add GitHub evidence</span>
          <span className="text-xs text-zinc-500 hidden sm:inline">— verify resume claims against real code</span>
        </div>
        <div className="flex gap-2 flex-1 sm:justify-end">
          <input
            value={ghUser}
            onChange={(e) => setGhUser(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && connectGithub()}
            placeholder="github username"
            className="rounded-lg border border-zinc-800 bg-black/40 px-3 py-1.5 text-sm text-zinc-200 w-full sm:w-52"
          />
          <button onClick={connectGithub} disabled={ghBusy} className="btn-ghost text-xs px-4 py-1.5 border-purple-500/30 text-purple-300 hover:bg-purple-950/20 whitespace-nowrap">
            {ghBusy ? "Importing…" : "Import"}
          </button>
        </div>
        {ghMsg && <div className="text-xs text-zinc-400 w-full sm:w-auto sm:ml-3">{ghMsg}</div>}
      </div>

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
          <SectionTitle title="Career Knowledge Graph" subtitle="Every node is earned. Click a node to see why it exists, how confident we are, and what it connects to." />
          <KnowledgeGraph graph={d.graph} onReplay={openReplay} />
        </section>
      )}

      {tab === "reality" && <RealityGap items={d.realityGap} />}
      {tab === "skills" && <SkillEvidence skills={d.skills} onReplay={openReplay} />}
      {tab === "roadmap" && <Roadmap recommendations={recommendations} missions={missions} />}
      {tab === "communication" && <Communication d={d} />}
      {tab === "timeline" && <Timeline d={d} onReplay={openReplay} />}

      {replay && <ReplayModal replay={replay} onClose={() => setReplay(null)} />}
    </div>
  );
}

function MemoryHeader({
  d,
  recall,
  cogneeConfigured,
  cogneeInsight,
  company,
}: {
  d: Dashboard;
  recall: RecallResult;
  cogneeConfigured: boolean;
  cogneeInsight: string | null;
  company?: string | null;
}) {
  return (
    <div className="glass-card p-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold">
            <span className="text-[#c8beac]">Cognee Career Memory</span>
            <span className={`rounded px-1.5 py-0.5 border ${cogneeConfigured ? "text-emerald-300 border-emerald-500/30 bg-emerald-500/10" : "text-purple-300 border-purple-500/30 bg-purple-500/10"}`}>
              {cogneeConfigured ? "Cognee backend live" : "Local graph engine"}
            </span>
          </div>
          <h2 className="heading-font text-2xl font-bold text-white mt-1">{d.name ?? "Your"} career intelligence</h2>
          <p className="text-sm text-zinc-400 mt-1">
            {d.interviewCount} interview{d.interviewCount === 1 ? "" : "s"} remembered · {d.graph.nodes.length} nodes · {d.graph.edges.length} relationships · rev {d.revision}
          </p>
        </div>
        <div className="flex gap-3">
          <Stat label="Overall confidence" value={`${d.overallConfidence}%`} />
          <Stat label="Skills tracked" value={String(d.skills.length)} />
          <Stat label="On roadmap" value={String(recall.weakConcepts.length + recall.forgottenConcepts.length)} />
        </div>
      </div>
      {cogneeInsight && (
        <div className="mt-4 rounded-xl border border-[#c8beac]/25 bg-[#c8beac]/5 p-3">
          <div className="text-[10px] uppercase tracking-widest font-bold text-[#c8beac] mb-1">
            Ask Cognee · {company ? `what to study before ${company}` : "what should I study next"}
          </div>
          <p className="text-[13px] text-zinc-200 whitespace-pre-line">{cogneeInsight}</p>
          <p className="mt-1 text-[10px] text-zinc-500">Graph-grounded answer from Cognee&apos;s search() over your memory.</p>
        </div>
      )}
      {recall.focusDirectives.length > 0 && (
        <div className="mt-4 rounded-xl border border-cyan-500/20 bg-cyan-950/10 p-3">
          <div className="text-[10px] uppercase tracking-wider font-bold text-cyan-300 mb-1">recall() — what the next interview will focus on</div>
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

const REALITY_TIERS: { tier: RealityGapItem["tier"]; label: string; box: string; heading: string }[] = [
  { tier: "highly-demonstrated", label: "Highly Demonstrated", box: "border-emerald-500/25 bg-emerald-950/10", heading: "text-emerald-300" },
  { tier: "developing", label: "Developing", box: "border-cyan-500/25 bg-cyan-950/10", heading: "text-cyan-300" },
  { tier: "needs-evidence", label: "Needs More Evidence", box: "border-amber-500/25 bg-amber-950/10", heading: "text-amber-300" },
];

function RealityGap({ items }: { items: RealityGapItem[] }) {
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Reality Gap" subtitle="Resume claims cross-checked against demonstrated evidence — coaching, never shaming." />
      <div className="grid gap-4 md:grid-cols-3">
        {REALITY_TIERS.map((g) => {
          const list = items.filter((i) => i.tier === g.tier);
          return (
            <div key={g.tier} className={`rounded-2xl border p-4 ${g.box}`}>
              <div className={`text-xs font-bold uppercase tracking-wider ${g.heading} mb-3`}>
                {g.label} ({list.length})
              </div>
              <div className="flex flex-col gap-3">
                {list.length === 0 && <div className="text-xs text-zinc-600">—</div>}
                {list.map((i) => (
                  <div key={i.skill} className="rounded-xl bg-black/40 border border-white/5 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-white text-sm">{i.skill}</span>
                      <span className="text-xs font-mono text-zinc-400">{i.confidence}%</span>
                    </div>
                    {i.claimedLevel && <div className="text-[11px] text-zinc-500 mt-0.5">Resume: {i.claimedLevel}</div>}
                    <ul className="mt-2 space-y-0.5">
                      {i.evidence.slice(0, 3).map((e, idx) => (
                        <li key={idx} className={`text-[11px] flex gap-1.5 ${e.positive ? "text-emerald-300/80" : "text-zinc-400"}`}>
                          <span>{e.positive ? "✓" : "·"}</span>
                          <span>{e.text}</span>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-2 text-[11px] text-purple-300/90 border-t border-white/5 pt-2">→ {i.recommendedAction}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function SkillEvidence({ skills, onReplay }: { skills: SkillCard[]; onReplay: (c: string) => void }) {
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Persistent Skill Verification" subtitle="Every skill carries its claim, verified confidence, retention and supporting evidence." />
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
              <span>Tested {s.timesTested}×</span>
              {s.supportingProjects.length > 0 && <span>· {s.supportingProjects.length} project{s.supportingProjects.length > 1 ? "s" : ""}</span>}
              {s.githubEvidence > 0 && <span>· {s.githubEvidence} GitHub</span>}
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

function Roadmap({ recommendations, missions }: { recommendations: Recommendation[]; missions: LearningMission[] }) {
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Learning Roadmap" subtitle="Every weakness becomes a mission — read → practice → quiz → re-interview → improvement recorded. Each is evidence-backed." />
      <div className="flex flex-col gap-3">
        {missions.length === 0 && <div className="text-sm text-zinc-500">No weaknesses to work on — everything is well demonstrated and fresh. 🎉</div>}
        {missions.map((m) => {
          const rec = recommendations.find((r) => r.concept === m.concept);
          return (
            <div key={m.concept} className="rounded-2xl border border-zinc-800 bg-black/30 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white">{m.title}</span>
                    <span className="text-[10px] rounded-full bg-red-500/10 border border-red-500/30 text-red-300 px-2 py-0.5">priority {m.priority}</span>
                  </div>
                  <div className="text-[12px] text-zinc-400 mt-0.5">{m.reason}</div>
                </div>
                <div className="text-right shrink-0">
                  <div className="text-[11px] text-zinc-500">~{m.estimatedMinutes} min</div>
                  <div className="text-[11px] text-cyan-400">review in {m.reviewDueInDays}d</div>
                </div>
              </div>
              {rec && rec.evidence.items.length > 0 && (
                <div className="mt-2 rounded-lg bg-black/40 border border-white/5 p-2">
                  <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">Why (evidence)</div>
                  <ul className="text-[11px] text-zinc-400 space-y-0.5">
                    {rec.evidence.items.slice(0, 4).map((e, i) => (
                      <li key={i}>· {e.text}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="mt-2 flex flex-wrap gap-1.5">
                {m.steps.map((s, i) => (
                  <span key={i} className="rounded-full border border-zinc-700 bg-zinc-900/60 px-2.5 py-0.5 text-[11px] text-zinc-300">
                    {stepIcon(s.kind)} {s.title}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Communication({ d }: { d: Dashboard }) {
  const c = d.communication;
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Communication Trends (Interview DNA)" subtitle="Voice & language patterns tracked across every interview — persistent, not per-session." />
      {c.length === 0 ? (
        <div className="text-sm text-zinc-500">No interviews recorded yet.</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <TrendCard title="Confidence" points={c.map((x) => x.confidence)} labels={c.map((x) => `#${x.interviewIndex}`)} suffix="%" higherBetter />
          <TrendCard title="Filler words" points={c.map((x) => x.fillerCount)} labels={c.map((x) => `#${x.interviewIndex}`)} higherBetter={false} />
          <TrendCard title="Vocabulary richness" points={c.map((x) => x.vocabularyRichness)} labels={c.map((x) => `#${x.interviewIndex}`)} suffix="%" higherBetter />
          <TrendCard title="Technical depth" points={c.map((x) => x.technicalDepth)} labels={c.map((x) => `#${x.interviewIndex}`)} suffix="%" higherBetter />
          {c.some((x) => x.speechRateWpm != null) && (
            <TrendCard
              title="Speaking pace (wpm)"
              points={c.map((x) => x.speechRateWpm ?? 0)}
              labels={c.map((x) => `#${x.interviewIndex}`)}
              higherBetter
            />
          )}
        </div>
      )}
    </section>
  );
}

function Timeline({ d, onReplay }: { d: Dashboard; onReplay: (c: string) => void }) {
  return (
    <section className="glass-card p-6">
      <SectionTitle title="Career Timeline" subtitle="Automatically generated from the graph — resume versions, interviews and improvement milestones." />
      <ol className="relative border-l border-zinc-800 ml-2">
        {d.timeline.map((e, i) => (
          <li key={i} className="mb-5 ml-5">
            <span
              className={`absolute -left-[7px] mt-1 h-3 w-3 rounded-full border-2 ${
                e.kind === "milestone" ? "bg-emerald-500 border-emerald-300" : e.kind === "interview" ? "bg-amber-500 border-amber-300" : "bg-purple-500 border-purple-300"
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
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-2">Improvement per skill (Digital Career DNA)</div>
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
                    <span className="text-xs font-bold text-amber-300">Interview #{e.interviewIndex}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-sm text-white">{e.score}%</span>
                      {delta !== 0 && <span className={`text-[11px] font-bold ${delta > 0 ? "text-emerald-400" : "text-red-400"}`}>{delta > 0 ? "▲" : "▼"} {Math.abs(delta)}</span>}
                    </span>
                  </div>
                  <p className="mt-2 text-[13px] text-zinc-300 italic">“{e.answer}”</p>
                  {e.feedback && <p className="mt-2 text-[11px] text-zinc-500 border-t border-white/5 pt-2">{e.feedback}</p>}
                </div>
              );
            })}
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/10 p-3 text-[12px] text-emerald-200">
              {(() => {
                const first = replay.entries[0].score;
                const last = replay.entries[replay.entries.length - 1].score;
                const d = last - first;
                return d > 0
                  ? `Confidence on ${replay.concept} grew from ${first}% to ${last}% (+${d}) across ${replay.entries.length} interviews. This is your memory working.`
                  : `Tracked across ${replay.entries.length} interviews. Keep practising to grow ${replay.concept}.`;
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
function stepIcon(kind: string): string {
  return kind === "read" ? "📖" : kind === "practice" ? "🛠" : kind === "quiz" ? "❓" : "🎤";
}
