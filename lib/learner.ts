"use client";

/**
 * Client-side learner identity + the browser-held copy of the Skill Knowledge Graph.
 * The graph lives in localStorage so memory survives serverless deployments: every API call
 * sends the graph up and persists the updated graph that comes back.
 */

const KEY = "synergy.learnerId";

function randomId(): string {
  try {
    return `learner-${crypto.randomUUID().slice(0, 8)}`;
  } catch {
    return `learner-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

export function getLearnerId(): string {
  if (typeof window === "undefined") return "anon";
  let id = localStorage.getItem(KEY);
  if (!id) {
    id = randomId();
    localStorage.setItem(KEY, id);
  }
  return id;
}

const graphKey = (learnerId: string) => `synergy.graph.${learnerId}`;

export function saveGraphLocal(learnerId: string, graph: unknown): void {
  if (typeof window === "undefined" || !graph) return;
  try {
    localStorage.setItem(graphKey(learnerId), JSON.stringify(graph));
  } catch {
    /* quota exceeded - non-fatal */
  }
}

export function loadGraphLocal(learnerId: string): unknown | null {
  if (typeof window === "undefined") return null;
  const s = localStorage.getItem(graphKey(learnerId));
  if (!s) return null;
  try {
    const g = JSON.parse(s) as { skills?: unknown; sessions?: unknown } | null;
    // A graph written by an older build (or corrupted) is discarded rather than sent to the
    // server - the server responds with a fresh graph and this copy heals on the next save.
    if (!g || typeof g !== "object" || typeof g.skills !== "object" || typeof g.sessions !== "object") {
      localStorage.removeItem(graphKey(learnerId));
      return null;
    }
    return g;
  } catch {
    localStorage.removeItem(graphKey(learnerId));
    return null;
  }
}

export function clearGraphLocal(learnerId: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(graphKey(learnerId));
}
