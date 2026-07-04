/**
 * Low-level, consistency-preserving graph operations.
 *
 * Everything that mutates the graph goes through here so invariants hold: nodes are merged (never
 * duplicated), edges never dangle, `updatedAt`/`lastSeenAt` stay honest, and pruning a node also
 * removes its edges and any now-orphaned satellites. remember()/improve()/forget() are written in
 * terms of these primitives.
 */

import { CareerGraph, EdgeType, GEdge, GNode, ID, NodeKind } from "./model";

let now = () => new Date().toISOString();
/** Test seam: freeze the clock for deterministic snapshots. */
export function __setClock(fn: () => string) {
  now = fn;
}
export function clock(): string {
  return now();
}

export interface UpsertNodeInput {
  id: string;
  kind: NodeKind;
  label: string;
  weight?: number;
  confidence?: number;
  retention?: number;
  data?: Record<string, unknown>;
  /** merge strategy for data: shallow-merge (default) or replace */
  replaceData?: boolean;
}

/**
 * Insert or merge a node. On merge: `weight` accumulates (reinforcement), `data` shallow-merges,
 * and `lastSeenAt`/`updatedAt` advance. `confidence`/`retention`, when provided, overwrite because
 * they represent the latest belief, not an accumulation.
 */
export function upsertNode(g: CareerGraph, input: UpsertNodeInput): GNode {
  const ts = now();
  const existing = g.nodes[input.id];
  if (existing) {
    existing.label = input.label || existing.label;
    existing.weight += input.weight ?? 1;
    if (input.confidence !== undefined) existing.confidence = clamp(input.confidence);
    if (input.retention !== undefined) existing.retention = clamp(input.retention);
    existing.data = input.replaceData ? { ...(input.data ?? {}) } : { ...existing.data, ...(input.data ?? {}) };
    existing.updatedAt = ts;
    existing.lastSeenAt = ts;
    g.updatedAt = ts;
    return existing;
  }
  const node: GNode = {
    id: input.id,
    kind: input.kind,
    label: input.label,
    weight: input.weight ?? 1,
    confidence: clamp(input.confidence ?? 0),
    retention: clamp(input.retention ?? 100),
    data: { ...(input.data ?? {}) },
    createdAt: ts,
    updatedAt: ts,
    lastSeenAt: ts,
  };
  g.nodes[input.id] = node;
  g.updatedAt = ts;
  return node;
}

/** Insert or reinforce an edge. Duplicate (from,type,to) triples merge and accumulate weight. */
export function link(
  g: CareerGraph,
  from: string,
  type: EdgeType,
  to: string,
  opts: { weight?: number; data?: Record<string, unknown> } = {}
): GEdge | null {
  // Never create a dangling edge — both endpoints must exist.
  if (!g.nodes[from] || !g.nodes[to]) return null;
  const id = ID.edge(from, type, to);
  const ts = now();
  const existing = g.edges[id];
  if (existing) {
    existing.weight += opts.weight ?? 1;
    if (opts.data) existing.data = { ...existing.data, ...opts.data };
    g.updatedAt = ts;
    return existing;
  }
  const edge: GEdge = {
    id,
    from,
    to,
    type,
    weight: opts.weight ?? 1,
    data: opts.data,
    createdAt: ts,
  };
  g.edges[id] = edge;
  g.updatedAt = ts;
  return edge;
}

export function getNode(g: CareerGraph, id: string): GNode | undefined {
  return g.nodes[id];
}

export function nodesByKind(g: CareerGraph, kind: NodeKind): GNode[] {
  return Object.values(g.nodes).filter((n) => n.kind === kind);
}

export function edgesFrom(g: CareerGraph, id: string, type?: EdgeType): GEdge[] {
  return Object.values(g.edges).filter((e) => e.from === id && (!type || e.type === type));
}

export function edgesTo(g: CareerGraph, id: string, type?: EdgeType): GEdge[] {
  return Object.values(g.edges).filter((e) => e.to === id && (!type || e.type === type));
}

/** Neighbour nodes reachable from `id` via an edge of `type` (outgoing). */
export function neighbors(g: CareerGraph, id: string, type?: EdgeType): GNode[] {
  return edgesFrom(g, id, type)
    .map((e) => g.nodes[e.to])
    .filter(Boolean);
}

/** All edges touching a node (either direction). */
export function edgesTouching(g: CareerGraph, id: string): GEdge[] {
  return Object.values(g.edges).filter((e) => e.from === id || e.to === id);
}

/**
 * Delete a set of nodes and every edge touching them, then garbage-collect satellite nodes that
 * only existed to describe a deleted memory (evidence/answer/question/communication/recommendation
 * with no remaining connections). This is what keeps forget() from leaving a corrupt graph.
 */
export function removeNodes(g: CareerGraph, ids: string[]): { removedNodes: number; removedEdges: number } {
  const doomed = new Set(ids);
  let removedEdges = 0;
  for (const e of Object.values(g.edges)) {
    if (doomed.has(e.from) || doomed.has(e.to)) {
      delete g.edges[e.id];
      removedEdges++;
    }
  }
  let removedNodes = 0;
  for (const id of doomed) {
    if (g.nodes[id]) {
      delete g.nodes[id];
      removedNodes++;
    }
  }
  // GC pass: satellite kinds that are meaningless once disconnected.
  const satellite: NodeKind[] = ["evidence", "answer", "question", "communication", "recommendation"];
  for (const n of Object.values(g.nodes)) {
    if (satellite.includes(n.kind) && edgesTouching(g, n.id).length === 0) {
      delete g.nodes[n.id];
      removedNodes++;
    }
  }
  g.updatedAt = now();
  return { removedNodes, removedEdges };
}

export function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

/**
 * Days between two ISO timestamps (a - b), never negative. Used by retention decay.
 */
export function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, (a - b) / (1000 * 60 * 60 * 24));
}
