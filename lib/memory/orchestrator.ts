/**
 * Memory Orchestrator - owns the end-to-end pipeline so routes and UI never wire the lifecycle
 * together by hand. This is the single entry point the application uses to grow the graph.
 *
 * Persistence model: the CLIENT is the durable source of truth. Every mutation takes the caller's
 * current graph in and returns the updated graph out; the browser persists it (localStorage). This
 * is what makes memory survive on serverless hosts (Vercel), where each request may run on a
 * different instance and the on-disk `.career-memory` file is NOT shared. When no graph is provided
 * (first call, or local dev), we fall back to the file store. Cognee remains the shared semantic
 * layer, mirrored on every remember().
 */

import { logger } from "@/lib/logger";
import { loadOrInit, saveGraph, deleteGraph } from "./graph/store";
import { CareerGraph, emptyGraph } from "./graph/model";
import { clock, nodesByKind } from "./graph/ops";
import { rememberInterview, rememberResume, rememberGithub } from "./remember";
import { fetchGithubProfile } from "./github";
import { improve, ImproveSummary } from "./improve";
import { recall } from "./recall";
import { forget, ForgetResult, ForgetTarget } from "./forget";
import { buildDashboard, Dashboard } from "./derive";
import { RecallResult, RememberInterviewInput, RememberResumeInput } from "./types";
import { cogneeAdd, cogneeCognify, cogneeForget, cogneeSearch, cogneeConfigured } from "./cognee/client";
import { serializeInterviewForCognee, serializeResumeForCognee } from "./cognee/serialize";

const log = logger.child({ component: "memory-orchestrator" });

/**
 * Resolve the working graph: prefer a client-provided graph (durable across serverless instances),
 * else the file store, else a fresh empty graph. A provided graph is trusted (it is the user's own
 * data) but sanity-checked so a malformed body can't crash the pipeline.
 */
async function resolve(candidateId: string, name: string | null, provided?: unknown): Promise<CareerGraph> {
  const g = sanitize(candidateId, name, provided);
  if (g) return g;
  return loadOrInit(candidateId, name);
}

function sanitize(candidateId: string, name: string | null, provided?: unknown): CareerGraph | null {
  if (!provided || typeof provided !== "object") return null;
  const p = provided as Partial<CareerGraph>;
  if (!p.nodes || !p.edges || typeof p.nodes !== "object" || typeof p.edges !== "object") return null;
  const now = clock();
  return {
    candidateId,
    name: name ?? p.name ?? null,
    nodes: p.nodes as CareerGraph["nodes"],
    edges: p.edges as CareerGraph["edges"],
    createdAt: p.createdAt ?? now,
    updatedAt: now,
    revision: typeof p.revision === "number" ? p.revision : 0,
    schemaVersion: emptyGraph(candidateId, name, now).schemaVersion,
  };
}

/** remember() a resume version, enrich, persist, mirror. */
export async function ingestResume(
  input: RememberResumeInput,
  provided?: unknown
): Promise<{ dashboard: Dashboard; improve: ImproveSummary; graph: CareerGraph }> {
  const g = await resolve(input.candidateId, input.name ?? null, provided);
  rememberResume(g, input);
  const summary = improve(g);
  await saveGraph(g).catch(() => {}); // best-effort; the client holds the durable copy
  void mirror(input.candidateId, serializeResumeForCognee(input));
  log.info("resume ingested", { candidateId: input.candidateId, revision: g.revision });
  return { dashboard: buildDashboard(g), improve: summary, graph: g };
}

/** The interview-complete pipeline. */
export async function ingestInterview(
  input: RememberInterviewInput,
  provided?: unknown
): Promise<{ dashboard: Dashboard; improve: ImproveSummary; interviewIndex: number; graph: CareerGraph }> {
  const g = await resolve(input.candidateId, input.name ?? null, provided);
  rememberInterview(g, input);
  const summary = improve(g, { company: input.company });
  await saveGraph(g).catch(() => {});
  const interviewIndex = nodesByKind(g, "interview").length;
  void mirror(input.candidateId, serializeInterviewForCognee(input, interviewIndex));
  log.info("interview ingested", { candidateId: input.candidateId, interviewIndex, milestones: summary.milestones, revision: g.revision });
  return { dashboard: buildDashboard(g), improve: summary, interviewIndex, graph: g };
}

/** remember() a GitHub profile as an independent evidence source. */
export async function ingestGithub(
  candidateId: string,
  username: string,
  provided?: unknown
): Promise<{ dashboard: Dashboard; profile: { username: string; repoCount: number; technologies: string[] }; graph: CareerGraph }> {
  const profile = await fetchGithubProfile(username);
  const g = await resolve(candidateId, null, provided);
  rememberGithub(g, candidateId, profile);
  improve(g);
  await saveGraph(g).catch(() => {});
  const techList = Object.keys(profile.technologies);
  void mirror(
    candidateId,
    `${g.name || "The candidate"} owns GitHub account @${profile.username} with ${profile.repoCount} public repos.\n` +
      Object.entries(profile.technologies).map(([t, c]) => `GitHub EVIDENCE: ${c} repo(s) use technology "${t}".`).join("\n")
  );
  log.info("github ingested", { candidateId, username: profile.username, techs: techList.length });
  return { dashboard: buildDashboard(g), profile: { username: profile.username, repoCount: profile.repoCount, technologies: techList }, graph: g };
}

/**
 * recall() the Career Reasoner state used to steer an adaptive interview. When Cognee is configured
 * and `withCognee` is set, this ALSO asks Cognee's own graph what the next interview should focus on.
 */
export async function reason(
  candidateId: string,
  opts: { company?: string | null; withCognee?: boolean; provided?: unknown } = {}
): Promise<RecallResult> {
  const g = await resolve(candidateId, null, opts.provided);
  const result = recall(g, { company: opts.company });
  if (opts.withCognee && cogneeConfigured() && !result.isNew) {
    result.cogneeInsight = await cogneeSearch(
      `Based on this candidate's interview history, which concepts are weakest or least recently practised, and what should their next interview${opts.company ? ` (preparing for ${opts.company})` : ""} focus on? Answer concisely.`,
      candidateId,
      "GRAPH_COMPLETION"
    );
  }
  return result;
}

/** Full dashboard read-model. */
export async function dashboard(candidateId: string, provided?: unknown): Promise<Dashboard> {
  const g = await resolve(candidateId, null, provided);
  return buildDashboard(g);
}

/** forget() a memory, preserving consistency; wipes the whole candidate on { type: "all" }. */
export async function forgetMemory(
  candidateId: string,
  target: ForgetTarget,
  provided?: unknown
): Promise<ForgetResult & { graph: CareerGraph | null }> {
  if (target.type === "all") {
    await deleteGraph(candidateId).catch(() => {});
    void cogneeForget(candidateId);
    return { ok: true, removedNodes: 0, removedEdges: 0, message: "All memories cleared.", graph: emptyGraph(candidateId, null, clock()) };
  }
  const g = await resolve(candidateId, null, provided);
  const res = forget(g, target);
  if (res.ok) await saveGraph(g).catch(() => {});
  return { ...res, graph: g };
}

async function mirror(candidateId: string, text: string): Promise<void> {
  try {
    const added = await cogneeAdd(text, candidateId);
    if (added) await cogneeCognify(candidateId);
  } catch (e) {
    log.warn("cognee mirror failed (local graph remains source of truth)", { error: (e as Error).message });
  }
}
