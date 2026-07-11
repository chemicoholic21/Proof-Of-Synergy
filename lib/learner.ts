"use client";

const KEY = "synergy.learnerId";
const NAME_KEY = "synergy.learnerName";

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

export function setLearnerName(name: string): string {
  if (typeof window === "undefined") return "anon";
  localStorage.setItem(NAME_KEY, name);
  const id = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "learner";
  localStorage.setItem(KEY, id);
  return id;
}

export function getLearnerName(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(NAME_KEY);
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
    return JSON.parse(s);
  } catch {
    return null;
  }
}

export function clearGraphLocal(learnerId: string): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(graphKey(learnerId));
}
