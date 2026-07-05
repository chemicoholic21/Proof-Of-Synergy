/**
 * Cognee service client — the single seam between the app and Cognee.
 *
 * Design contract: the rest of the application NEVER talks to Cognee directly. It calls the memory
 * layer (remember/recall/improve/forget); the memory layer keeps a local Career Knowledge Graph as
 * the deterministic source of truth AND, when a real Cognee backend is configured, mirrors every
 * remember() into Cognee (add + cognify) and can enrich recall() with Cognee's semantic + graph
 * search. If Cognee is not configured, or a call fails, the local engine already produced a correct
 * answer, so the product never breaks — it only loses the extra semantic lift.
 *
 * This mirrors the whole codebase's posture (see lib/env.ts DEMO_MODE): degrade gracefully, never
 * fabricate, never crash a request because an optional dependency is down.
 */

import { env, cogneeConfigured } from "@/lib/env";
import { logger } from "@/lib/logger";

export { cogneeConfigured };

export type CogneeSearchType = "GRAPH_COMPLETION" | "RAG_COMPLETION" | "INSIGHTS" | "CHUNKS" | "SUMMARIES";

const log = logger.child({ component: "cognee-client" });

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
    authorization: `Bearer ${env.COGNEE_API_KEY}`,
  };
}

function base(): string {
  return (env.COGNEE_API_URL || "").replace(/\/+$/, "");
}

/**
 * Ingest text into Cognee (`add`). One retry, best-effort. Returns true if Cognee accepted it.
 * `nodeText` should be the NORMALIZED, relationship-rich serialization of a memory (see
 * serializeForCognee) — not a raw transcript — so Cognee builds meaning, not chunks.
 */
export async function cogneeAdd(nodeText: string, candidateId: string): Promise<boolean> {
  if (!cogneeConfigured()) return false;
  const dataset = `${env.COGNEE_DATASET}-${candidateId}`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchWithTimeout(`${base()}/api/v1/add`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ data: nodeText, datasetName: dataset }),
      });
      if (res.ok) return true;
      log.warn("cognee add non-2xx", { status: res.status, attempt });
    } catch (e) {
      log.warn("cognee add failed", { attempt, error: (e as Error).message });
    }
  }
  return false;
}

/** Trigger graph construction over the candidate's dataset (`cognify`). Best-effort. */
export async function cogneeCognify(candidateId: string): Promise<boolean> {
  if (!cogneeConfigured()) return false;
  const dataset = `${env.COGNEE_DATASET}-${candidateId}`;
  try {
    const res = await fetchWithTimeout(
      `${base()}/api/v1/cognify`,
      { method: "POST", headers: headers(), body: JSON.stringify({ datasets: [dataset] }) },
      60000
    );
    return res.ok;
  } catch (e) {
    log.warn("cognee cognify failed", { error: (e as Error).message });
    return false;
  }
}

/**
 * Semantic + graph search over the candidate's memory (`search`). Returns Cognee's answer text, or
 * null when Cognee is unavailable so the caller falls back to the local reasoner.
 */
export async function cogneeSearch(
  query: string,
  candidateId: string,
  searchType: CogneeSearchType = "GRAPH_COMPLETION"
): Promise<string | null> {
  if (!cogneeConfigured()) return null;
  const dataset = `${env.COGNEE_DATASET}-${candidateId}`;
  try {
    const res = await fetchWithTimeout(`${base()}/api/v1/search`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ query, searchType, datasets: [dataset] }),
    });
    if (!res.ok) {
      log.warn("cognee search non-2xx", { status: res.status });
      return null;
    }
    const data = await res.json();
    // Cognee returns an array of results or a { results } envelope depending on version.
    if (typeof data === "string") return data;
    if (Array.isArray(data)) return data.map(String).join("\n");
    return data?.text ?? data?.result ?? (data?.results ? JSON.stringify(data.results) : null);
  } catch (e) {
    log.warn("cognee search failed", { error: (e as Error).message });
    return null;
  }
}

/** Delete a candidate's dataset from Cognee (`delete`/`prune`). Best-effort; local forget() owns truth. */
export async function cogneeForget(candidateId: string): Promise<boolean> {
  if (!cogneeConfigured()) return false;
  const dataset = `${env.COGNEE_DATASET}-${candidateId}`;
  try {
    const res = await fetchWithTimeout(`${base()}/api/v1/datasets/${encodeURIComponent(dataset)}`, {
      method: "DELETE",
      headers: headers(),
    });
    return res.ok;
  } catch (e) {
    log.warn("cognee forget failed", { error: (e as Error).message });
    return false;
  }
}
