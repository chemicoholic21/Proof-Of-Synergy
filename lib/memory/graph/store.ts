/**
 * Per-learner persistence for the Communication Skill Graph.
 *
 * The whole product premise is "remembers you across sessions", so the graph must outlive a single
 * request. We persist one JSON document per learner under a data directory. In the test
 * environment (and as a resilient fallback if the filesystem is read-only, e.g. some serverless
 * targets) we keep an in-process map instead, so unit tests are hermetic and the app never crashes
 * because it could not write a file.
 *
 * This module is intentionally the ONLY place that knows where/how graphs are stored. Swapping the
 * backing store for Supabase/Postgres later is a change isolated to this file.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { CommGraph, SCHEMA_VERSION, emptyGraph } from "./model";
import { clock } from "./ops";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const DATA_DIR = process.env.COGNEE_DATA_DIR || path.join(process.cwd(), ".comm-memory");
const useMemory = env.isTest;
const mem = new Map<string, CommGraph>();

function fileFor(learnerId: string): string {
  const safe = learnerId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "anon";
  return path.join(DATA_DIR, `${safe}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/** Load a learner's graph, or null if none exists yet. */
export async function loadGraph(learnerId: string): Promise<CommGraph | null> {
  if (useMemory) {
    const g = mem.get(learnerId);
    return g ? structuredClone(g) : null;
  }
  try {
    const raw = await fs.readFile(fileFor(learnerId), "utf-8");
    return migrate(JSON.parse(raw) as CommGraph);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    logger.warn("comm-memory: load failed, treating as empty", { learnerId, error: (e as Error).message });
    return null;
  }
}

/** Load, or create-and-return an empty graph for a first-time learner (not yet persisted). */
export async function loadOrInit(learnerId: string, name: string | null): Promise<CommGraph> {
  const existing = await loadGraph(learnerId);
  if (existing) {
    if (name && !existing.name) existing.name = name;
    return existing;
  }
  return emptyGraph(learnerId, name, clock());
}

export async function saveGraph(g: CommGraph): Promise<void> {
  g.updatedAt = clock();
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

export async function deleteGraph(learnerId: string): Promise<void> {
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

export async function listLearners(): Promise<string[]> {
  if (useMemory) return [...mem.keys()];
  try {
    const files = await fs.readdir(DATA_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/** Forward-compatible loader. Future schema bumps add migration steps here. */
function migrate(g: CommGraph): CommGraph {
  if (!g.schemaVersion) g.schemaVersion = SCHEMA_VERSION;
  return g;
}
