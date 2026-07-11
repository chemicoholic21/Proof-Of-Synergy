/**
 * Memory Orchestrator - owns the end-to-end pipeline so routes and UI never wire the lifecycle
 * together by hand. This is the single entry point the application uses to grow the graph.
 *
 * Persistence model: the CLIENT is the durable source of truth. Every mutation takes the caller's
 * current graph in and returns the updated graph out; the browser persists it (localStorage). This
 * is what makes memory survive on serverless hosts (Vercel), where each request may run on a
 * different instance and the on-disk `.communication-memory` file is NOT shared. When no graph is
 * provided (first call, or local dev), we fall back to the file store. Cognee remains the shared
 * semantic layer, mirrored on every remember().
 */

import { logger } from "@/lib/logger";
import { loadOrInit, saveGraph, deleteGraph } from "./graph/store";
import { CommunicationGraph, emptyGraph } from "./graph/model";
import { clock, nodesByKind } from "./graph/ops";
import { rememberSession } from "./remember";
import { improve, ImproveSummary } from "./improve";
import { forget, ForgetResult, ForgetTarget } from "./forget";
import { recall, RecallResult } from "./recall";
import { buildDashboard, Dashboard } from "./derive";
import { RecallResult, RememberSessionInput } from "./types";
import { cogneeAdd, cogneeCognify, cogneeForget, cogneeSearch, cogneeConfigured } from "./cognee/client";
import { serializeSessionForCognee } from "./cognee/serialize";

const log = logger.child({ component: "memory-orchestrator" });

/**
 * Resolve the working graph: prefer a client-provided graph (durable across serverless instances),
 * else the file store, else a fresh empty graph. A provided graph is trusted (it is the user's own
 * data) but sanity-checked so a malformed body can't crash the pipeline.
 */
async function resolve(learnerId: string, name: string | null, provided?: unknown): Promise<CommunicationGraph> {
  const g = sanitize(learnerId, name, provided);
  if (g) return g;
  return loadOrInit(learnerId, name);
}

function sanitize(learnerId: string, name: string | null, provided?: unknown): CommunicationGraph | null {
  if (!provided || typeof provided !== "object") return null;
  const p = provided as Partial<CommunicationGraph>;
  if (!p.nodes || !p.edges || typeof p.nodes !== "object" || typeof p.edges !== "object") return null;
  const now = clock();
  return {
    learnerId,
    name: name ?? p.name ?? null,
    nodes: p.nodes as CommunicationGraph["nodes"],
    edges: p.edges as CommunicationGraph["edges"],
    createdAt: p.createdAt ?? now,
    updatedAt: now,
    revision: typeof p.revision === "number" ? p.revision : 0,
    schemaVersion: emptyGraph(learnerId, name, now).schemaVersion,
  };
}

/** remember() a practice session, enrich, persist, mirror. */
export async function ingestSession(
  input: RememberSessionInput,
  provided?: unknown
): Promise<{ dashboard: Dashboard; improve: ImproveSummary; graph: CommunicationGraph }> {
  const g = await resolve(input.learnerId, null, provided);
  rememberSession(g, input);
  const summary = improve(g, { scenarioId: input.scenarioId });
  await saveGraph(g).catch(() => {}); // best-effort; the client holds the durable copy
  void mirror(input.learnerId, serializeSessionForCognee(input));
  log.info("session ingested", { learnerId: input.learnerId, scenarioId: input.scenarioId, revision: g.revision });
  return { dashboard: buildDashboard(g), improve: summary, graph: g };
}

/** The session-complete pipeline. */
export async function ingestSessionComplete(
  input: RememberSessionInput,
  provided?: unknown
): Promise<{ dashboard: Dashboard; improve: ImproveSummary; graph: CommunicationGraph }> {
  return ingestSession(input, provided);
}

/** recall() the Skill Reasoner state used to steer a practice session. When Cognee is configured
 *  and `withCognee` is set, this ALSO asks Cognee's own graph what the next session should focus on.
 */
export async function reason(
  learnerId: string,
  opts: { scenarioId?: string | null; withCognee?: boolean; provided?: unknown } = {}
): Promise<RecallResult> {
  const g = await resolve(learnerId, null, opts.provided);
  const result = recall(g, { scenarioId: opts.scenarioId });
  if (opts.withCognee && cogneeConfigured() && !result.isNew) {
    result.cogneeInsight = await cogneeSearch(
      `Based on this learner's practice history, which skills are weakest or least recently practiced, and what should their next practice session${opts.scenarioId ? ` (preparing for ${opts.scenarioId})` : ""} focus on? Answer concisely.`,
      learnerId,
      "GRAPH_COMPLETION"
    );
  }
  return result;
}

/** Full dashboard read-model. */
export async function dashboard(learnerId: string, provided?: unknown): Promise<Dashboard> {
  const g = await resolve(learnerId, null, provided);
  return buildDashboard(g);
}

/** forget() a memory, preserving consistency; wipes the whole learner on { type: "all" }. */
export async function forgetMemory(
  learnerId: string,
  target: ForgetTarget,
  provided?: unknown
): Promise<ForgetResult & { graph: CommunicationGraph | null }> {
  if (target.type === "all") {
    await deleteGraph(learnerId).catch(() => {});
    void cogneeForget(learnerId);
    return { ok: true, removedNodes: 0, removedEdges: 0, message: "All memories cleared.", graph: emptyGraph(learnerId, null, clock()) };
  }
  const g = await resolve(learnerId, null, provided);
  const res = forget(g, target);
  if (res.ok) await saveGraph(g).catch(() => {});
  return { ...res, graph: g };
}

async function mirror(learnerId: string, text: string): Promise<void> {
  try {
    if (!cogneeConfigured()) return;
    const added = await cogneeAdd(text, learnerId);
    if (added) await cogneeCognify(learnerId);
  } catch (e) {
    log.warn("cognee mirror failed (local graph remains source of truth)", { error: (e as Error).message });
  }
}