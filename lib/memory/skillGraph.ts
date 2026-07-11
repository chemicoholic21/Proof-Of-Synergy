/**
 * Server-side Skill Graph for Proof of Synergy 2.0 - the AI Communication Gym.
 *
 * Each learner accumulates a communication "skill graph" across practice sessions. Skills (derived
 * from scenario tags plus a synthetic scenario skill) gain exposure and a rolling confidence score
 * as the learner practices. The graph is the durable memory the product is built on: it powers
 * skill recall, practice replay and the dashboard. On serverless the client also persists the graph,
 * but this module is the authoritative server-side store.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getScenario } from "@/lib/scenarios";
import type { SessionResult } from "@/lib/types";

const log = logger.child({ module: "skillGraph" });

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

// ---------------------------------------------------------------------------
// Persistence (filesystem with an in-memory fallback for tests / read-only FS).
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.COGNEE_DATA_DIR || path.join(process.cwd(), ".skill-memory");
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
    log.warn("skill-memory: load failed, treating as empty", { learnerId, error: (e as Error).message });
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
  await ensureDir();
  const tmp = fileFor(g.learnerId) + ".tmp";
  const dest = fileFor(g.learnerId);
  await fs.writeFile(tmp, JSON.stringify(g), "utf-8");
  await fs.rename(tmp, dest); // atomic replace
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
  log.info("remember session", { learnerId: input.learnerId, sessionId, skills: skillIds.length });
  return { graph: g, sessionId, skillIds };
}

// ---------------------------------------------------------------------------
// recall(): surface the learner's skill state (strong / weak / forgotten).
// ---------------------------------------------------------------------------

export interface SkillRecallResult {
  skills: SkillNode[];
  strong: SkillNode[];
  weak: SkillNode[];
  forgotten: SkillNode[];
  suggestedNext: SkillNode | null;
}

export function recallSkills(graph: SkillGraph, skillName?: string): SkillRecallResult {
  const all = Object.values(graph.skills);
  const skills = skillName
    ? all.filter((s) => s.name.toLowerCase() === skillName.toLowerCase())
    : all;
  const strong = skills.filter((s) => s.confidence >= 66);
  const weak = skills.filter((s) => s.confidence >= 33 && s.confidence < 66);
  const forgotten = skills.filter((s) => s.confidence < 33);
  const suggestedNext = [...skills].sort((a, b) => a.confidence - b.confidence)[0] ?? null;
  return { skills, strong, weak, forgotten, suggestedNext };
}

// ---------------------------------------------------------------------------
// forget(): prune a memory while preserving graph consistency.
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
  await saveSkillGraph(g);
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
  log.info("replay", { learnerId: graph.learnerId, skill, entries: entries.length });
  return { skill, entries };
}

// ---------------------------------------------------------------------------
// seed(): one-click demo graph with a clear growth arc.
// ---------------------------------------------------------------------------

export function buildDemoSkillGraph(learnerId: string, name = "Aarav Sharma"): SkillGraph {
  const g = emptySkillGraph(learnerId, name, new Date().toISOString());
  const demos: Array<{
    scenarioId: string;
    confidence: number;
    wordCount: number;
    fillerCount: number;
    coachingEvents: number;
    summary: string;
  }> = [
    {
      scenarioId: "technical-interview",
      confidence: 52,
      wordCount: 240,
      fillerCount: 8,
      coachingEvents: 6,
      summary:
        "Solid technical substance but several filler words. Structure the answer with a clear opening point next time.",
    },
    {
      scenarioId: "startup-pitch",
      confidence: 64,
      wordCount: 300,
      fillerCount: 5,
      coachingEvents: 4,
      summary: "Compelling hook and clear value story. Tighten the traction numbers and reduce hedging.",
    },
    {
      scenarioId: "leadership",
      confidence: 71,
      wordCount: 210,
      fillerCount: 3,
      coachingEvents: 3,
      summary: "Empathetic and clear. Strong framing of the feedback conversation with concrete next steps.",
    },
  ];

  for (const d of demos) {
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
      g.skills[id] = {
        id,
        name: n,
        category: tags[0] ?? "communication",
        level: levelFromConfidence(d.confidence),
        confidence: existing ? Math.round((existing.confidence + d.confidence) / 2) : d.confidence,
        exposure: (existing?.exposure ?? 0) + 1,
        sessions: (existing?.sessions ?? 0) + 1,
        lastPracticedAt: g.updatedAt,
        createdAt: existing?.createdAt ?? g.createdAt,
        updatedAt: g.updatedAt,
      };
    }
    g.sessions[sessionId] = {
      id: sessionId,
      scenarioId: d.scenarioId,
      scenarioTitle,
      completedAt: g.updatedAt,
      durationSec: 180,
      wordCount: d.wordCount,
      confidence: d.confidence,
      fillerCount: d.fillerCount,
      coachingEvents: d.coachingEvents,
      skills: skillIds,
      summary: d.summary,
    };
    g.revision += 1;
  }
  return g;
}
