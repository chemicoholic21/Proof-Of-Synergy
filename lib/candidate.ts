"use client";

/** Client-safe slug → stable, url-safe candidate id (mirrors candidateIdFrom in the memory layer,
 *  duplicated here so the client bundle never imports the Node-only memory internals). */
function candidateIdFrom(seed: string): string {
  const base = seed.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return (base || "candidate").slice(0, 60);
}

/**
 * Client-side candidate identity. The whole product premise is "remembers you across sessions", so
 * we persist a stable candidateId in localStorage. It keys the server-side Career Knowledge Graph.
 * A real deployment would derive this from authentication; here it is stable-per-browser (or
 * derived from the resume name once known).
 */

const KEY = "synergy.candidateId";
const NAME_KEY = "synergy.candidateName";

function randomId(): string {
  try {
    return `cand-${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `cand-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

/** Get (creating if needed) the stable candidate id for this browser. */
export function getCandidateId(): string {
  if (typeof window === "undefined") return "anon";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(KEY, id);
  }
  return id;
}

/** Once the resume reveals a name, promote the identity to a stable, human-readable id. */
export function setCandidateName(name: string, forceId?: string): string {
  if (typeof window === "undefined") return "anon";
  localStorage.setItem(NAME_KEY, name);
  const id = forceId ?? candidateIdFrom(name);
  localStorage.setItem(KEY, id);
  return id;
}

export function getCandidateName(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(NAME_KEY);
}

// ---------------------------------------------------------------------------
// Client-held Career Knowledge Graph.
//
// On serverless hosts (Vercel) the server's file store is per-instance and NOT shared between
// requests, so a graph written during an interview may be invisible when the dashboard reads it.
// The browser is therefore the durable source of truth: we cache the latest graph per candidate in
// localStorage and send it with every memory request. Cognee remains the shared semantic layer.
// ---------------------------------------------------------------------------

const graphKey = (candidateId: string) => `synergy.graph.${candidateId}`;

export function saveGraphLocal(candidateId: string, graph: unknown): void {
  if (typeof window === "undefined" || !graph) return;
  try {
    localStorage.setItem(graphKey(candidateId), JSON.stringify(graph));
  } catch {
    /* quota exceeded — non-fatal */
  }
}

export function loadGraphLocal(candidateId: string): unknown | null {
  if (typeof window === "undefined") return null;
  const s = localStorage.getItem(graphKey(candidateId));
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function clearGraphLocal(candidateId: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(graphKey(candidateId));
}
