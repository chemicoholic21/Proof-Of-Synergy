/**
 * Per-candidate persistence for the Career Knowledge Graph.
 *
 * The whole product premise is "remembers you across sessions", so the graph must outlive a single
 * request. We persist one JSON document per candidate under a data directory. In the test
 * environment (and as a resilient fallback if the filesystem is read-only, e.g. some serverless
 * targets) we keep an in-process map instead, so unit tests are hermetic and the app never crashes
 * because it could not write a file.
 *
 * This module is intentionally the ONLY place that knows where/how graphs are stored. Swapping the
 * backing store for Supabase/Postgres later is a change isolated to this file.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { CareerGraph, SCHEMA_VERSION, emptyGraph } from "./model";
import { clock } from "./ops";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";

const DATA_DIR = process.env.COGNEE_DATA_DIR || path.join(process.cwd(), ".career-memory");
const useMemory = env.isTest;
const mem = new Map<string, CareerGraph>();

function fileFor(candidateId: string): string {
  // candidateId is a slugged token; guard against traversal regardless.
  const safe = candidateId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80) || "anon";
  return path.join(DATA_DIR, `${safe}.json`);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

/** Load a candidate's graph, or null if none exists yet. */
export async function loadGraph(candidateId: string): Promise<CareerGraph | null> {
  if (useMemory) {
    const g = mem.get(candidateId);
    return g ? structuredClone(g) : null;
  }
  try {
    const raw = await fs.readFile(fileFor(candidateId), "utf-8");
    return migrate(JSON.parse(raw) as CareerGraph);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    logger.warn("career-memory: load failed, treating as empty", { candidateId, error: (e as Error).message });
    return null;
  }
}

/** Load, or create-and-return an empty graph for a first-time candidate (not yet persisted). */
export async function loadOrInit(candidateId: string, name: string | null): Promise<CareerGraph> {
  const existing = await loadGraph(candidateId);
  if (existing) {
    if (name && !existing.name) existing.name = name;
    return existing;
  }
  return emptyGraph(candidateId, name, clock());
}

export async function saveGraph(g: CareerGraph): Promise<void> {
  g.updatedAt = clock();
  g.schemaVersion = SCHEMA_VERSION;
  if (useMemory) {
    mem.set(g.candidateId, structuredClone(g));
    return;
  }
  await ensureDir();
  const tmp = fileFor(g.candidateId) + ".tmp";
  const dest = fileFor(g.candidateId);
  await fs.writeFile(tmp, JSON.stringify(g), "utf-8");
  await fs.rename(tmp, dest); // atomic replace
}

export async function deleteGraph(candidateId: string): Promise<void> {
  if (useMemory) {
    mem.delete(candidateId);
    return;
  }
  try {
    await fs.unlink(fileFor(candidateId));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

export async function listCandidates(): Promise<string[]> {
  if (useMemory) return [...mem.keys()];
  try {
    const files = await fs.readdir(DATA_DIR);
    return files.filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/** Forward-compatible loader. Future schema bumps add migration steps here. */
function migrate(g: CareerGraph): CareerGraph {
  if (!g.schemaVersion) g.schemaVersion = SCHEMA_VERSION;
  return g;
}
