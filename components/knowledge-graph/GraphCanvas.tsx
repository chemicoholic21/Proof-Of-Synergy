"use client";

import { useMemo, useState } from "react";
import type { GraphView, VizNode } from "@/lib/skill-graph";

/**
 * The Skill Knowledge Graph visualization. Deterministic radial layout so it is stable across
 * renders; nodes animate in on mount, weak skills glow ochre, strong skills glow sage, and
 * clicking any node explains why it exists and what it connects to. The audience literally
 * watches the learner's communication memory grow.
 */

// Muted, earthy palette - one restrained system, not a rainbow. Ink for the learner, warm bone
// for skills, quiet neutrals for the rest; semantic sage/ochre only for strong/weak states.
const KIND_STYLE: Record<string, { fill: string; ring: string; label: string }> = {
  learner: { fill: "#ece9e3", ring: "#ece9e3", label: "You" },
  skill: { fill: "#c8beac", ring: "#d8cfbe", label: "Skill" },
  category: { fill: "#8f887b", ring: "#a29c8e", label: "Category" },
  session: { fill: "#7d7466", ring: "#948b7c", label: "Session" },
};

interface Placed extends VizNode {
  x: number;
  y: number;
  r: number;
}

const W = 1000;
const H = 760;
const CX = W / 2;
const CY = H / 2;

export default function GraphCanvas({ graph, onReplay }: { graph: GraphView; onReplay?: (skill: string) => void }) {
  const [selected, setSelected] = useState<string | null>(null);

  const placed = useMemo(() => layout(graph), [graph]);
  const byId = useMemo(() => new Map(placed.map((n) => [n.id, n])), [placed]);

  const selectedNode = selected ? byId.get(selected) : null;
  const connectedIds = useMemo(() => {
    if (!selected) return new Set<string>();
    const s = new Set<string>();
    for (const e of graph.edges) {
      if (e.from === selected) s.add(e.to);
      if (e.to === selected) s.add(e.from);
    }
    return s;
  }, [selected, graph.edges]);

  const neighborLabels = selected
    ? graph.edges
        .filter((e) => e.from === selected || e.to === selected)
        .map((e) => byId.get(e.from === selected ? e.to : e.from)?.label)
        .filter((x): x is string => Boolean(x))
    : [];

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto select-none" role="img" aria-label="Skill knowledge graph">
        {/* edges */}
        <g>
          {graph.edges.map((e, i) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b) return null;
            const active = selected && (e.from === selected || e.to === selected);
            return (
              <line
                key={i}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                stroke={active ? "#c8beac" : "#3a352c"}
                strokeOpacity={selected ? (active ? 0.85 : 0.08) : 0.22}
                strokeWidth={active ? 1.8 : 1}
                style={{ transition: "stroke-opacity .3s" }}
              />
            );
          })}
        </g>
        {/* nodes */}
        <g>
          {placed.map((n, i) => {
            const st = KIND_STYLE[n.kind] ?? KIND_STYLE.category;
            const dim = selected && n.id !== selected && !connectedIds.has(n.id);
            const glow = n.weak ? "#b8965c" : n.strong ? "#7f9a78" : st.ring;
            return (
              <g
                key={n.id}
                transform={`translate(${n.x} ${n.y})`}
                onClick={() => setSelected(n.id === selected ? null : n.id)}
                style={{
                  cursor: "pointer",
                  opacity: dim ? 0.28 : 1,
                  transition: "opacity .3s",
                  animation: `nodeIn .5s ease ${Math.min(i * 18, 900)}ms both`,
                }}
              >
                {(n.weak || n.strong || n.id === selected) && (
                  <circle r={n.r + 7} fill={glow} opacity={0.18}>
                    {n.weak && <animate attributeName="opacity" values="0.1;0.32;0.1" dur="2.4s" repeatCount="indefinite" />}
                  </circle>
                )}
                <circle r={n.r} fill={st.fill} stroke={glow} strokeWidth={n.id === selected ? 3 : 1.5} />
                {n.kind === "learner" && (
                  <text textAnchor="middle" dy="0.35em" fontSize="13" fontWeight="700" fill="#1c1a15">
                    {initials(n.label)}
                  </text>
                )}
                <text
                  textAnchor="middle"
                  y={n.r + 13}
                  fontSize={n.kind === "learner" || n.kind === "skill" ? 13 : 11}
                  fontWeight={n.kind === "skill" || n.kind === "learner" ? 600 : 400}
                  fill={dim ? "#52525b" : "#d4d4d8"}
                >
                  {truncate(n.label, 18)}
                </text>
              </g>
            );
          })}
        </g>
      </svg>

      {/* Legend */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-ink-soft">
        {Object.entries(KIND_STYLE).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: v.fill }} />
            {v.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#b8965c" }} />
          Weak (practice next)
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: "#7f9a78" }} />
          Strong
        </span>
      </div>

      {/* Explainability panel */}
      {selectedNode && (
        <div className="absolute right-2 top-2 w-64 rounded-2xl border border-accent/30 bg-black/85 backdrop-blur p-4 text-sm shadow-2xl">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="text-[10px] uppercase tracking-wider text-accent font-bold">
                {(KIND_STYLE[selectedNode.kind] ?? KIND_STYLE.category).label}
              </div>
              <div className="heading-font text-lg font-bold text-white leading-tight">{selectedNode.label}</div>
            </div>
            <button onClick={() => setSelected(null)} className="text-zinc-500 hover:text-zinc-200" aria-label="Close">
              ✕
            </button>
          </div>

          {selectedNode.kind === "skill" && (
            <div className="mt-3 space-y-2">
              <Bar label="Confidence" value={selectedNode.confidence} tone={selectedNode.weak ? "ochre" : selectedNode.strong ? "sage" : "bone"} />
              <Bar label="Freshness" value={selectedNode.freshness} tone="stone" />
              <div className="text-[11px] text-zinc-400">
                {selectedNode.weak
                  ? "Weak - keep practising this in your next sessions."
                  : selectedNode.strong
                  ? "Strong - consistently well demonstrated."
                  : "Developing - keep reinforcing it."}
              </div>
            </div>
          )}
          {selectedNode.kind === "session" && (
            <div className="mt-3 space-y-2">
              <Bar label="Session confidence" value={selectedNode.confidence} tone="bone" />
            </div>
          )}

          <div className="mt-3">
            <div className="text-[10px] uppercase tracking-wider text-zinc-500 font-bold mb-1">
              Connected to ({neighborLabels.length})
            </div>
            <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
              {neighborLabels.slice(0, 12).map((l, i) => (
                <span key={i} className="rounded-full bg-white/5 border border-white/10 px-2 py-0.5 text-[10px] text-zinc-300">
                  {truncate(l, 16)}
                </span>
              ))}
            </div>
          </div>

          {onReplay && selectedNode.kind === "skill" && (
            <button
              onClick={() => onReplay(selectedNode.label)}
              className="btn-ghost mt-3 w-full text-xs py-1.5"
            >
              ▶ Replay growth on {truncate(selectedNode.label, 14)}
            </button>
          )}
        </div>
      )}

      <style jsx>{`
        @keyframes nodeIn {
          from {
            opacity: 0;
            transform: scale(0.2);
          }
        }
      `}</style>
    </div>
  );
}

function Bar({ label, value, tone }: { label: string; value: number; tone: "ochre" | "sage" | "bone" | "stone" }) {
  const color = { ochre: "#b8965c", sage: "#7f9a78", bone: "#c8beac", stone: "#a29c8e" }[tone];
  return (
    <div>
      <div className="flex justify-between text-[11px] text-zinc-400">
        <span>{label}</span>
        <span className="font-mono text-zinc-200">{value}%</span>
      </div>
      <div className="mt-0.5 h-1.5 rounded-full bg-white/5 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color, transition: "width .6s" }} />
      </div>
    </div>
  );
}

// ---- deterministic radial layout: learner center, skills ring 1, sessions/categories ring 2 ----
function layout(graph: GraphView): Placed[] {
  const nodes = graph.nodes;
  const learner = nodes.find((n) => n.kind === "learner");
  const primaries = nodes.filter((n) => n.kind === "skill");
  const secondaries = nodes.filter((n) => n.kind === "session" || n.kind === "category");

  const pos = new Map<string, { x: number; y: number }>();
  const placed: Placed[] = [];

  const radiusFor = (n: VizNode) => {
    if (n.kind === "learner") return 26;
    if (n.kind === "skill") return 15 + Math.min(8, n.weight);
    if (n.kind === "session") return 13;
    return 9;
  };

  if (learner) {
    pos.set(learner.id, { x: CX, y: CY });
    placed.push({ ...learner, x: CX, y: CY, r: radiusFor(learner) });
  }

  // Ring 1: skills evenly, alphabetical so the layout is stable.
  const ordered = [...primaries].sort((a, b) => a.label.localeCompare(b.label));
  const R1 = 205;
  ordered.forEach((n, i) => {
    const ang = (i / Math.max(1, ordered.length)) * Math.PI * 2 - Math.PI / 2;
    const x = CX + Math.cos(ang) * R1;
    const y = CY + Math.sin(ang) * R1 * 0.82;
    pos.set(n.id, { x, y });
    placed.push({ ...n, x, y, r: radiusFor(n) });
  });

  // Ring 2: each session/category near a placed neighbour (a skill it touches), else spread.
  const R2 = 330;
  const adjacency = new Map<string, string[]>();
  for (const e of graph.edges) {
    (adjacency.get(e.to) ?? adjacency.set(e.to, []).get(e.to)!).push(e.from);
    (adjacency.get(e.from) ?? adjacency.set(e.from, []).get(e.from)!).push(e.to);
  }
  let spreadIdx = 0;
  secondaries.forEach((n) => {
    const neigh = (adjacency.get(n.id) ?? []).map((id) => pos.get(id)).find(Boolean);
    let x: number, y: number;
    if (neigh) {
      const dx = neigh.x - CX;
      const dy = neigh.y - CY;
      const base = Math.atan2(dy, dx);
      const jitter = (hash(n.id) % 40 - 20) / 100;
      const ang = base + jitter;
      x = CX + Math.cos(ang) * R2;
      y = CY + Math.sin(ang) * R2 * 0.82;
    } else {
      const ang = (spreadIdx++ / Math.max(1, secondaries.length)) * Math.PI * 2;
      x = CX + Math.cos(ang) * R2;
      y = CY + Math.sin(ang) * R2 * 0.82;
    }
    pos.set(n.id, { x, y });
    placed.push({ ...n, x, y, r: radiusFor(n) });
  });

  return placed;
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff;
  return h;
}
function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
function initials(s: string): string {
  return s
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}
