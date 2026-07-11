/**
 * Cognee client - the single seam between the app and Cognee.
 *
 * Cognee powers the learner's SKILL KNOWLEDGE GRAPH: every completed practice session is
 * serialized into relationship-rich statements (learner -> practiced -> scenario,
 * learner -> demonstrated -> skill, learner -> weakness -> filler words) and mirrored into a
 * per-learner Cognee dataset. recall() is then enriched with Cognee's graph-grounded search so
 * "what should I practice next?" is answered from the learner's real growth history.
 *
 * Verified against Cognee Cloud's OpenAPI spec:
 *   - auth:    X-Api-Key header (NOT Bearer)
 *   - ingest:  POST /api/v1/add_text   { textData: string[], datasetName }
 *   - build:   POST /api/v1/cognify    { datasets: [name], runInBackground }
 *   - search:  POST /api/v1/search     { searchType, datasets: [name], query, topK }
 *   - list:    GET  /api/v1/datasets/  -> [{ id, name, ... }]
 *   - delete:  DELETE /api/v1/datasets/{dataset_id}
 *   - health:  GET  /health
 *
 * Design contract: the rest of the app NEVER talks to Cognee directly - it calls the skill-graph
 * module (lib/skill-graph.ts), which keeps a deterministic local graph as the source of truth AND
 * mirrors into Cognee when configured. If Cognee is unavailable, the product keeps working; it
 * only loses the extra semantic lift.
 */

import { env, cogneeConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";

export { cogneeConfigured };

export type CogneeSearchType =
  | "GRAPH_COMPLETION"
  | "RAG_COMPLETION"
  | "GRAPH_COMPLETION_COT"
  | "CHUNKS"
  | "SUMMARIES"
  | "TEMPORAL"
  | "FEELING_LUCKY";

const log = logger.child({ component: "cognee" });

async function fetchWithTimeout(url: string, init: RequestInit, ms = 20000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

function headers(): Record<string, string> {
  return {
    "content-type": "application/json",
    "X-Api-Key": env.COGNEE_API_KEY || "",
  };
}

function base(): string {
  return (env.COGNEE_API_URL || "").replace(/\/+$/, "");
}

/** Per-learner dataset name. Cognee resolves dataset names against the authenticated user. */
export function datasetFor(learnerId: string): string {
  return `${env.COGNEE_DATASET}-${learnerId}`;
}

/**
 * Ingest NORMALIZED, relationship-rich text into Cognee (`add_text`). Cognee builds its own graph
 * from what we add, so we feed subject-predicate-object statements, not raw transcripts. One retry.
 * Returns true if Cognee accepted the data.
 */
export async function cogneeAdd(nodeText: string, learnerId: string): Promise<boolean> {
  if (!cogneeConfigured() || !nodeText.trim()) return false;
  const datasetName = datasetFor(learnerId);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(`${base()}/api/v1/add_text`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ textData: [nodeText], datasetName }),
      });
      if (res.ok) return true;
      log.warn("cognee add_text non-2xx", { status: res.status, attempt });
    } catch (e) {
      log.warn("cognee add_text failed", { attempt, error: (e as Error).message });
    }
  }
  return false;
}

/** Trigger graph construction over the learner's dataset (`cognify`, background). Best-effort. */
export async function cogneeCognify(learnerId: string): Promise<boolean> {
  if (!cogneeConfigured()) return false;
  try {
    const res = await fetchWithTimeout(
      `${base()}/api/v1/cognify`,
      { method: "POST", headers: headers(), body: JSON.stringify({ datasets: [datasetFor(learnerId)], runInBackground: true }) },
      30000
    );
    return res.ok;
  } catch (e) {
    log.warn("cognee cognify failed", { error: (e as Error).message });
    return false;
  }
}

/**
 * Graph-grounded search over the learner's skill memory (`search`). Returns Cognee's answer text,
 * or null when Cognee is unavailable / the graph isn't built yet, so callers fall back to the
 * local reasoner.
 */
export async function cogneeSearch(
  query: string,
  learnerId: string,
  searchType: CogneeSearchType = "GRAPH_COMPLETION",
  topK = 5
): Promise<string | null> {
  if (!cogneeConfigured()) return null;
  try {
    const res = await fetchWithTimeout(
      `${base()}/api/v1/search`,
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ searchType, datasets: [datasetFor(learnerId)], query, topK }),
      },
      45000
    );
    if (!res.ok) {
      log.warn("cognee search non-2xx", { status: res.status });
      return null;
    }
    const data = await res.json();
    const text = normalizeSearch(data);
    return text && text.trim() ? text.trim() : null;
  } catch (e) {
    log.warn("cognee search failed", { error: (e as Error).message });
    return null;
  }
}

/** Flatten Cognee's search response into a single answer string across the tolerated shapes. */
function normalizeSearch(data: unknown): string | null {
  if (data == null) return null;
  if (typeof data === "string") return data;
  if (Array.isArray(data)) {
    // [{ search_result: string[] }] (Cloud) or a bare array of strings.
    const parts: string[] = [];
    for (const item of data) {
      if (typeof item === "string") parts.push(item);
      else if (item && Array.isArray(item.search_result)) parts.push(...item.search_result.map(String));
      else if (item && item.search_result) parts.push(String(item.search_result));
    }
    return parts.join("\n");
  }
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.search_result)) return obj.search_result.map(String).join("\n");
  return (obj.text as string) ?? (obj.result as string) ?? null;
}

/** Delete a learner's dataset from Cognee: resolve its UUID by name, then DELETE it. Best-effort. */
export async function cogneeForget(learnerId: string): Promise<boolean> {
  if (!cogneeConfigured()) return false;
  const datasetName = datasetFor(learnerId);
  try {
    const listRes = await fetchWithTimeout(`${base()}/api/v1/datasets/`, { method: "GET", headers: headers() });
    if (!listRes.ok) return false;
    const datasets = (await listRes.json()) as { id: string; name: string }[];
    const match = Array.isArray(datasets) ? datasets.find((d) => d.name === datasetName) : null;
    if (!match) return true; // nothing to delete
    const delRes = await fetchWithTimeout(`${base()}/api/v1/datasets/${encodeURIComponent(match.id)}`, {
      method: "DELETE",
      headers: headers(),
    });
    return delRes.ok;
  } catch (e) {
    log.warn("cognee forget failed", { error: (e as Error).message });
    return false;
  }
}

/** Liveness probe used by /api/health so a silent fallback can't hide during a demo. */
export async function cogneePing(): Promise<{ ok: boolean; status: number | null }> {
  if (!cogneeConfigured()) return { ok: false, status: null };
  try {
    const res = await fetchWithTimeout(`${base()}/health`, { method: "GET", headers: headers() }, 8000);
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  }
}
