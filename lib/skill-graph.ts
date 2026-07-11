/**
 * The Skill Knowledge Graph - the durable memory of Proof of Synergy.
 *
 * Each learner accumulates a communication skill graph across practice sessions: skills (derived
 * from scenario tags plus the scenario itself) gain exposure and a rolling confidence score every
 * time they are practiced. The graph follows the memory lifecycle:
 *
 *   remember() - fold a completed practice session into the graph, mirror it into Cognee
 *   recall()   - surface strong / weak / fading skills and what to practice next
 *   replay()   - how one skill evolved across every session
 *   forget()   - learner-controlled deletion, locally and in Cognee
 *
 * Privacy model: the local graph (browser localStorage + this module's store) is the source of
 * truth. Cognee, when configured, receives normalized skill statements - never raw transcripts -
 * and enriches recall() with graph-grounded search.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getScenario } from "@/lib/scenarios";
import { cogneeAdd, cogneeCognify, cogneeForget, cogneeSearch, cogneeConfigured } from "@/lib/cognee";
import type { SessionResult } from "@/lib/types";

const log = logger.child({ module: "skill-graph" });

export type SkillLevel = "beginner" | "intermediate" | "advanced" | "expert";

export interface SkillNode {
  id: string;
  name: string;
  category: string;
  level: SkillLevel;
  confidence: number; // 0-100, rolling belief in command of this skill
  exposure: number; // practice touches
  sessions: number; // distinct sessions touching it
  lastPracticedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PracticeSessionNode {
  id: string;
  scenarioId: string;
  scenarioTitle: string;
  completedAt: string;
  durationSec: number;
  wordCount: number;
  confidence: number;
  fillerCount: number;
  coachingEvents: number;
  skills: string[];
  summary: string;
}

export interface SkillGraph {
  learnerId: string;
  name: string | null;
  skills: Record<string, SkillNode>;
  sessions: Record<string, PracticeSessionNode>;
  createdAt: string;
  updatedAt: string;
  revision: number;
  schemaVersion: number;
}

export const SCHEMA_VERSION = 1;

export function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "unknown";
}

const skillId = (name: string) => `skill:${slug(name)}`;

export function emptySkillGraph(learnerId: string, name: string | null, now: string): SkillGraph {
  return {
    learnerId,
    name,
    skills: {},
    sessions: {},
    createdAt: now,
    updatedAt: now,
    revision: 0,
    schemaVersion: SCHEMA_VERSION,
  };
}

function levelFromConfidence(c: number): SkillLevel {
  if (c >= 80) return "expert";
  if (c >= 60) return "advanced";
  if (c >= 40) return "intermediate";
  return "beginner";
}

/** How "fresh" a skill is (0-100): decays with days since it was last practiced. */
export function freshness(lastPracticedAt: string | null, nowIso?: string): number {
  if (!lastPracticedAt) return 100;
  const now = Date.parse(nowIso ?? new Date().toISOString());
  const last = Date.parse(lastPracticedAt);
  if (Number.isNaN(now) || Number.isNaN(last)) return 100;
  const days = Math.max(0, (now - last) / (1000 * 60 * 60 * 24));
  return Math.max(10, Math.min(100, Math.round(100 - days * 3)));
}

// ---------------------------------------------------------------------------
// Persistence (filesystem with an in-memory fallback for tests / read-only FS).
// On serverless the CLIENT also persists the graph (localStorage) and sends it
// with each request, so memory survives across instances.
// ---------------------------------------------------------------------------

const DATA_DIR = env.SKILL_GRAPH_DATA_DIR || path.join(process.cwd(), ".skill-memory");
const useMemory = env.isTest;
const mem = new Map<string, SkillGraph>();

function fileFor(learnerId: string): string {
  const safe = learnerId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "anon";
  return path.join(DATA_DIR, `${safe}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function loadSkillGraph(learnerId: string): Promise<SkillGraph | null> {
  if (useMemory) {
    const g = mem.get(learnerId);
    return g ? structuredClone(g) : null;
  }
  try {
    const raw = await fs.readFile(fileFor(learnerId), "utf-8");
    return migrate(JSON.parse(raw) as SkillGraph);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    log.warn("skill graph load failed, treating as empty", { learnerId, error: (e as Error).message });
    return null;
  }
}

export async function loadOrInit(learnerId: string, name: string | null): Promise<SkillGraph> {
  const existing = await loadSkillGraph(learnerId);
  if (existing) {
    if (name && !existing.name) existing.name = name;
    return existing;
  }
  return emptySkillGraph(learnerId, name, new Date().toISOString());
}

export async function saveSkillGraph(g: SkillGraph): Promise<void> {
  g.updatedAt = new Date().toISOString();
  g.schemaVersion = SCHEMA_VERSION;
  if (useMemory) {
    mem.set(g.learnerId, structuredClone(g));
    return;
  }
  try {
    await ensureDir();
    const tmp = fileFor(g.learnerId) + ".tmp";
    const dest = fileFor(g.learnerId);
    await fs.writeFile(tmp, JSON.stringify(g), "utf-8");
    await fs.rename(tmp, dest); // atomic replace
  } catch (e) {
    // Read-only FS (some serverless targets): the client-held copy remains the durable one.
    log.warn("skill graph save failed (client copy remains durable)", { error: (e as Error).message });
  }
}

export async function deleteSkillGraph(learnerId: string): Promise<void> {
  if (useMemory) {
    mem.delete(learnerId);
    return;
  }
  try {
    await fs.unlink(fileFor(learnerId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

function migrate(g: SkillGraph): SkillGraph {
  g.skills ||= {};
  g.sessions ||= {};
  g.schemaVersion ||= SCHEMA_VERSION;
  return g;
}

/** Sanity-check and adopt a client-provided graph (the durable copy on serverless). */
export function fromClient(learnerId: string, provided: unknown): SkillGraph | null {
  if (!provided || typeof provided !== "object") return null;
  const p = provided as Partial<SkillGraph>;
  if (!p.skills || !p.sessions || typeof p.skills !== "object" || typeof p.sessions !== "object") return null;
  const now = new Date().toISOString();
  return migrate({
    learnerId,
    name: p.name ?? null,
    skills: p.skills as SkillGraph["skills"],
    sessions: p.sessions as SkillGraph["sessions"],
    createdAt: p.createdAt ?? now,
    updatedAt: now,
    revision: typeof p.revision === "number" ? p.revision : 0,
    schemaVersion: SCHEMA_VERSION,
  });
}

// ---------------------------------------------------------------------------
// remember(): fold a completed practice session into the skill graph.
// ---------------------------------------------------------------------------

export interface RememberSessionInput {
  learnerId: string;
  name?: string | null;
  session: SessionResult;
  graph?: SkillGraph | null;
}

export async function rememberSession(input: RememberSessionInput): Promise<{
  graph: SkillGraph;
  sessionId: string;
  skillIds: string[];
}> {
  const now = new Date().toISOString();
  const g = input.graph ?? (await loadOrInit(input.learnerId, input.name ?? null));
  if (input.name) g.name = input.name;

  const scenario = getScenario(input.session.scenarioId);
  const scenarioTitle = scenario?.title ?? input.session.scenarioId;
  const tags = scenario?.tags ?? ["communication"];
  const skillNames = Array.from(new Set<string>([...tags, scenarioTitle]));
  const metrics = input.session.metrics;
  const sessionId = `session:${g.revision + 1}:${slug(scenarioTitle)}`;

  const skillIds: string[] = [];
  for (const name of skillNames) {
    const id = skillId(name);
    skillIds.push(id);
    const existing = g.skills[id];
    const baseConf = existing?.confidence ?? 40;
    // Nudge the rolling confidence toward this session's measured confidence.
    const newConf = Math.round(baseConf + (metrics.confidence - baseConf) * 0.4);
    g.skills[id] = {
      id,
      name,
      category: tags[0] ?? "communication",
      level: levelFromConfidence(newConf),
      confidence: Math.max(0, Math.min(100, newConf)),
      exposure: (existing?.exposure ?? 0) + 1,
      sessions: (existing?.sessions ?? 0) + 1,
      lastPracticedAt: now,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  g.sessions[sessionId] = {
    id: sessionId,
    scenarioId: input.session.scenarioId,
    scenarioTitle,
    completedAt: now,
    durationSec: input.session.durationSec,
    wordCount: metrics.wordCount,
    confidence: metrics.confidence,
    fillerCount: metrics.fillerCount,
    coachingEvents: input.session.coachingEvents.length,
    skills: skillIds,
    summary: input.session.summary,
  };

  g.revision += 1;
  g.updatedAt = now;
  await saveSkillGraph(g);
  void mirrorToCognee(input.learnerId, g.sessions[sessionId], g);
  log.info("remember session", { learnerId: input.learnerId, sessionId, skills: skillIds.length });
  return { graph: g, sessionId, skillIds };
}

// ---------------------------------------------------------------------------
// Cognee mirror: normalized skill statements, never raw transcripts.
// ---------------------------------------------------------------------------

/** Serialize a session into subject-predicate-object statements Cognee can graph. */
export function serializeSessionForCognee(learnerId: string, session: PracticeSessionNode, g: SkillGraph): string {
  const who = g.name ? `Learner ${g.name}` : `Learner ${learnerId}`;
  const lines: string[] = [];
  lines.push(`${who} completed a "${session.scenarioTitle}" practice session with a communication confidence of ${session.confidence} out of 100.`);
  for (const id of session.skills) {
    const s = g.skills[id];
    if (!s) continue;
    lines.push(`${who} practiced the communication skill "${s.name}" (${s.category}), now at ${s.level} level with ${s.confidence}% confidence after ${s.sessions} sessions.`);
  }
  if (session.fillerCount > 3) {
    lines.push(`${who} has a weakness in filler words: ${session.fillerCount} fillers were detected in this session.`);
  }
  if (session.summary) {
    lines.push(`Coaching summary for this session: ${session.summary}`);
  }
  return lines.join("\n");
}

async function mirrorToCognee(learnerId: string, session: PracticeSessionNode, g: SkillGraph): Promise<void> {
  try {
    if (!cogneeConfigured()) return;
    const added = await cogneeAdd(serializeSessionForCognee(learnerId, session, g), learnerId);
    if (added) await cogneeCognify(learnerId);
  } catch (e) {
    log.warn("cognee mirror failed (local graph remains source of truth)", { error: (e as Error).message });
  }
}

/** Ask Cognee's graph what this learner should practice next. Null when unavailable. */
export async function cogneeSkillInsight(learnerId: string): Promise<string | null> {
  if (!cogneeConfigured()) return null;
  return cogneeSearch(
    "Based on this learner's practice history, which communication skills are weakest or least recently practiced, and what should their next practice session focus on? Answer concisely.",
    learnerId,
    "GRAPH_COMPLETION"
  );
}

// ---------------------------------------------------------------------------
// recall(): surface the learner's skill state (strong / weak / fading).
// ---------------------------------------------------------------------------

export interface SkillRecallResult {
  skills: SkillNode[];
  strong: SkillNode[];
  weak: SkillNode[];
  fading: SkillNode[];
  suggestedNext: SkillNode | null;
}

export function recallSkills(graph: SkillGraph, skillName?: string): SkillRecallResult {
  const all = Object.values(graph.skills);
  const skills = skillName
    ? all.filter((s) => s.name.toLowerCase() === skillName.toLowerCase())
    : all;
  const strong = skills.filter((s) => s.confidence >= 66);
  const weak = skills.filter((s) => s.confidence < 66);
  const fading = skills.filter((s) => freshness(s.lastPracticedAt) < 60);
  const suggestedNext = [...skills].sort((a, b) => a.confidence - b.confidence)[0] ?? null;
  return { skills, strong, weak, fading, suggestedNext };
}

// ---------------------------------------------------------------------------
// forget(): learner-controlled deletion, locally and in Cognee.
// ---------------------------------------------------------------------------

export type ForgetTarget =
  | { type: "skill"; name: string }
  | { type: "session"; id: string }
  | { type: "all" };

export async function forgetSkill(
  learnerId: string,
  graph: SkillGraph | null | undefined,
  target: ForgetTarget
): Promise<{ graph: SkillGraph; removed: string[] }> {
  const g = graph ?? (await loadOrInit(learnerId, null));
  const removed: string[] = [];
  const now = new Date().toISOString();

  if (target.type === "all") {
    for (const id of Object.keys(g.skills)) {
      delete g.skills[id];
      removed.push(id);
    }
    for (const id of Object.keys(g.sessions)) {
      delete g.sessions[id];
      removed.push(id);
    }
    await deleteSkillGraph(learnerId).catch(() => {});
    void cogneeForget(learnerId);
  } else if (target.type === "skill") {
    const id = skillId(target.name);
    if (g.skills[id]) {
      delete g.skills[id];
      removed.push(id);
    }
    for (const s of Object.values(g.sessions)) {
      s.skills = s.skills.filter((x) => x !== id);
    }
  } else if (target.type === "session") {
    if (g.sessions[target.id]) {
      delete g.sessions[target.id];
      removed.push(target.id);
    }
  }

  g.revision += 1;
  g.updatedAt = now;
  if (target.type !== "all") await saveSkillGraph(g);
  log.info("forget", { learnerId, type: target.type, removed: removed.length });
  return { graph: g, removed };
}

// ---------------------------------------------------------------------------
// replay(): how a single skill evolved across every practice session.
// ---------------------------------------------------------------------------

export interface ReplayEntry {
  sessionId: string;
  scenarioTitle: string;
  completedAt: string;
  confidence: number;
  wordCount: number;
  fillerCount: number;
}

export function practiceReplay(graph: SkillGraph, skill: string): { skill: string; entries: ReplayEntry[] } {
  const id = skillId(skill);
  const entries = Object.values(graph.sessions)
    .filter((s) => s.skills.includes(id))
    .sort((a, b) => a.completedAt.localeCompare(b.completedAt))
    .map((s) => ({
      sessionId: s.id,
      scenarioTitle: s.scenarioTitle,
      completedAt: s.completedAt,
      confidence: s.confidence,
      wordCount: s.wordCount,
      fillerCount: s.fillerCount,
    }));
  return { skill, entries };
}

// ---------------------------------------------------------------------------
// Dashboard + visualization read-models (pure projections of the graph).
// ---------------------------------------------------------------------------

export type VizKind = "learner" | "category" | "skill" | "session";

export interface VizNode {
  id: string;
  kind: VizKind;
  label: string;
  confidence: number;
  freshness: number;
  weight: number;
  weak: boolean;
  strong: boolean;
}

export interface VizEdge {
  from: string;
  to: string;
  type: "PRACTICES" | "BELONGS_TO" | "DEMONSTRATED_IN";
}

export interface GraphView {
  nodes: VizNode[];
  edges: VizEdge[];
}

/** Project the skill graph into a visualization payload: learner -> skills -> categories/sessions. */
export function graphView(g: SkillGraph): GraphView {
  const nodes: VizNode[] = [];
  const edges: VizEdge[] = [];
  const learnerNodeId = `learner:${g.learnerId}`;

  nodes.push({
    id: learnerNodeId,
    kind: "learner",
    label: g.name ?? "You",
    confidence: 0,
    freshness: 100,
    weight: 10,
    weak: false,
    strong: false,
  });

  const categories = new Set<string>();
  for (const s of Object.values(g.skills)) {
    nodes.push({
      id: s.id,
      kind: "skill",
      label: s.name,
      confidence: s.confidence,
      freshness: freshness(s.lastPracticedAt),
      weight: s.exposure,
      weak: s.confidence < 55,
      strong: s.confidence >= 78,
    });
    edges.push({ from: learnerNodeId, to: s.id, type: "PRACTICES" });
    if (s.category && s.category !== s.name.toLowerCase()) {
      categories.add(s.category);
      edges.push({ from: s.id, to: `category:${slug(s.category)}`, type: "BELONGS_TO" });
    }
  }
  for (const c of categories) {
    nodes.push({
      id: `category:${slug(c)}`,
      kind: "category",
      label: c,
      confidence: 0,
      freshness: 100,
      weight: 1,
      weak: false,
      strong: false,
    });
  }
  for (const s of Object.values(g.sessions)) {
    nodes.push({
      id: s.id,
      kind: "session",
      label: s.scenarioTitle,
      confidence: s.confidence,
      freshness: 100,
      weight: 1,
      weak: false,
      strong: false,
    });
    for (const sk of s.skills) {
      if (g.skills[sk]) edges.push({ from: s.id, to: sk, type: "DEMONSTRATED_IN" });
    }
  }
  return { nodes, edges };
}

export interface SessionTrendPoint {
  index: number;
  scenarioTitle: string;
  completedAt: string;
  confidence: number;
  fillerCount: number;
  wordCount: number;
}

export interface Dashboard {
  learnerId: string;
  name: string | null;
  revision: number;
  sessionCount: number;
  skillCount: number;
  overallConfidence: number;
  skills: SkillNode[]; // strongest first
  focus: SkillNode[]; // weakest first - what to practice next
  sessions: PracticeSessionNode[]; // chronological
  trend: SessionTrendPoint[];
  graph: GraphView;
}

export function buildDashboard(g: SkillGraph): Dashboard {
  const skills = Object.values(g.skills).sort((a, b) => b.confidence - a.confidence);
  const sessions = Object.values(g.sessions).sort((a, b) => a.completedAt.localeCompare(b.completedAt));
  const overallConfidence = skills.length
    ? Math.round(skills.reduce((a, s) => a + s.confidence, 0) / skills.length)
    : 0;
  return {
    learnerId: g.learnerId,
    name: g.name,
    revision: g.revision,
    sessionCount: sessions.length,
    skillCount: skills.length,
    overallConfidence,
    skills,
    focus: [...skills].reverse().slice(0, 3),
    sessions,
    trend: sessions.map((s, i) => ({
      index: i + 1,
      scenarioTitle: s.scenarioTitle,
      completedAt: s.completedAt,
      confidence: s.confidence,
      fillerCount: s.fillerCount,
      wordCount: s.wordCount,
    })),
    graph: graphView(g),
  };
}

// ---------------------------------------------------------------------------
// seed(): a believable starter history with a clear growth arc. Used to
// populate a first visit so the graph experience never opens empty.
// ---------------------------------------------------------------------------

export function buildDemoSkillGraph(learnerId: string, name: string | null = null): SkillGraph {
  const now = Date.now();
  const g = emptySkillGraph(learnerId, name, new Date(now - 21 * 86400_000).toISOString());
  const demos: Array<{
    scenarioId: string;
    daysAgo: number;
    confidence: number;
    wordCount: number;
    fillerCount: number;
    coachingEvents: number;
    summary: string;
  }> = [
    {
      scenarioId: "technical-deep-dive",
      daysAgo: 21,
      confidence: 52,
      wordCount: 240,
      fillerCount: 8,
      coachingEvents: 6,
      summary:
        "Solid technical substance but several filler words. Structure the answer with a clear opening point next time.",
    },
    {
      scenarioId: "startup-pitch",
      daysAgo: 10,
      confidence: 64,
      wordCount: 300,
      fillerCount: 5,
      coachingEvents: 4,
      summary: "Compelling hook and clear value story. Tighten the traction numbers and reduce hedging.",
    },
    {
      scenarioId: "leadership",
      daysAgo: 2,
      confidence: 71,
      wordCount: 210,
      fillerCount: 3,
      coachingEvents: 3,
      summary: "Empathetic and clear. Strong framing of the feedback conversation with concrete next steps.",
    },
  ];

  for (const d of demos) {
    const at = new Date(now - d.daysAgo * 86400_000).toISOString();
    const scenario = getScenario(d.scenarioId);
    const scenarioTitle = scenario?.title ?? d.scenarioId;
    const tags = scenario?.tags ?? ["communication"];
    const skillNames = Array.from(new Set<string>([...tags, scenarioTitle]));
    const sessionId = `session:${g.revision + 1}:${slug(scenarioTitle)}`;
    const skillIds: string[] = [];
    for (const n of skillNames) {
      const id = skillId(n);
      skillIds.push(id);
      const existing = g.skills[id];
      const conf = existing ? Math.round((existing.confidence + d.confidence) / 2) : d.confidence;
      g.skills[id] = {
        id,
        name: n,
        category: tags[0] ?? "communication",
        level: levelFromConfidence(conf),
        confidence: conf,
        exposure: (existing?.exposure ?? 0) + 1,
        sessions: (existing?.sessions ?? 0) + 1,
        lastPracticedAt: at,
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
      };
    }
    g.sessions[sessionId] = {
      id: sessionId,
      scenarioId: d.scenarioId,
      scenarioTitle,
      completedAt: at,
      durationSec: 180,
      wordCount: d.wordCount,
      confidence: d.confidence,
      fillerCount: d.fillerCount,
      coachingEvents: d.coachingEvents,
      skills: skillIds,
      summary: d.summary,
    };
    g.revision += 1;
    g.updatedAt = at;
  }
  return g;
}
