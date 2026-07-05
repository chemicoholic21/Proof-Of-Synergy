/**
 * Memory Orchestrator — owns the end-to-end pipeline so routes and UI never wire the lifecycle
 * together by hand. This is the single entry point the application uses to grow the graph.
 *
 * Interview-complete pipeline:
 *   load graph → remember(interview) → improve() → persist → mirror into Cognee (best-effort)
 *
 * Every step is here, in order, exactly as the architecture doc specifies. Removing Cognee does not
 * break the pipeline (the local graph is source of truth) — but with Cognee configured, each
 * remember() is mirrored so Cognee's semantic search can enrich future recall().
 */

import { logger } from "@/lib/logger";
import { loadOrInit, saveGraph } from "./graph/store";
import { rememberInterview, rememberResume } from "./remember";
import { improve, ImproveSummary } from "./improve";
import { recall } from "./recall";
import { forget, ForgetResult, ForgetTarget } from "./forget";
import { buildDashboard, Dashboard } from "./derive";
import { RecallResult, RememberInterviewInput, RememberResumeInput } from "./types";
import { cogneeAdd, cogneeCognify, cogneeForget } from "./cognee/client";
import { serializeInterviewForCognee, serializeResumeForCognee } from "./cognee/serialize";
import { nodesByKind } from "./graph/ops";
import { deleteGraph } from "./graph/store";

const log = logger.child({ component: "memory-orchestrator" });

/** remember() a resume version, enrich, persist, mirror. */
export async function ingestResume(input: RememberResumeInput): Promise<{ dashboard: Dashboard; improve: ImproveSummary }> {
  const g = await loadOrInit(input.candidateId, input.name ?? null);
  rememberResume(g, input);
  const summary = improve(g);
  await saveGraph(g);
  // Mirror into Cognee (best-effort, never blocks the response meaningfully).
  void mirror(input.candidateId, serializeResumeForCognee(input));
  log.info("resume ingested", { candidateId: input.candidateId, revision: g.revision });
  return { dashboard: buildDashboard(g), improve: summary };
}

/** The interview-complete pipeline. */
export async function ingestInterview(
  input: RememberInterviewInput
): Promise<{ dashboard: Dashboard; improve: ImproveSummary; interviewIndex: number }> {
  const g = await loadOrInit(input.candidateId, input.name ?? null);
  rememberInterview(g, input);
  const summary = improve(g, { company: input.company });
  await saveGraph(g);
  const interviewIndex = nodesByKind(g, "interview").length;
  void mirror(input.candidateId, serializeInterviewForCognee(input, interviewIndex));
  log.info("interview ingested", {
    candidateId: input.candidateId,
    interviewIndex,
    milestones: summary.milestones,
    revision: g.revision,
  });
  return { dashboard: buildDashboard(g), improve: summary, interviewIndex };
}

/** recall() the Career Reasoner state used to steer an adaptive interview. */
export async function reason(candidateId: string, opts: { company?: string | null } = {}): Promise<RecallResult> {
  const g = await loadOrInit(candidateId, null);
  return recall(g, { company: opts.company });
}

/** Full dashboard read-model. */
export async function dashboard(candidateId: string): Promise<Dashboard> {
  const g = await loadOrInit(candidateId, null);
  return buildDashboard(g);
}

/** forget() a memory, preserving consistency; wipes the whole candidate on { type: "all" }. */
export async function forgetMemory(candidateId: string, target: ForgetTarget): Promise<ForgetResult> {
  if (target.type === "all") {
    await deleteGraph(candidateId);
    void cogneeForget(candidateId);
    return { ok: true, removedNodes: 0, removedEdges: 0, message: "All memories cleared." };
  }
  const g = await loadOrInit(candidateId, null);
  const res = forget(g, target);
  if (res.ok) await saveGraph(g);
  return res;
}

async function mirror(candidateId: string, text: string): Promise<void> {
  try {
    const added = await cogneeAdd(text, candidateId);
    if (added) await cogneeCognify(candidateId);
  } catch (e) {
    log.warn("cognee mirror failed (local graph remains source of truth)", { error: (e as Error).message });
  }
}
