/**
 * GitHub evidence source. Fetches a candidate's PUBLIC repositories and aggregates the technologies
 * they actually ship, so the Reality Gap can compare resume claims against real code:
 * "claims Kubernetes (advanced) — 0 Kubernetes repos detected" is far more powerful than a bare
 * confidence number. This is a third, independent evidence source alongside the resume and the
 * interview.
 *
 * Uses the unauthenticated GitHub REST API (60 req/hr/IP — plenty for a demo). Set GITHUB_TOKEN for
 * a higher limit. Never throws into the request path; returns a structured error the route surfaces.
 */

import { logger } from "@/lib/logger";

const log = logger.child({ component: "github" });

export interface GithubRepoSignal {
  name: string;
  language: string | null;
  topics: string[];
  stars: number;
  description: string | null;
}

export interface GithubProfile {
  username: string;
  repoCount: number;
  repos: GithubRepoSignal[];
  /** technology -> number of repos that evidence it (language + topics), lowercased keys */
  technologies: Record<string, number>;
}

async function ghFetch(url: string, timeoutMs = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "user-agent": "proof-of-synergy-career-memory",
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  try {
    return await fetch(url, { headers, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Fetch and normalize a public GitHub profile's technology signals. */
export async function fetchGithubProfile(username: string): Promise<GithubProfile> {
  const clean = username.trim().replace(/^@/, "");
  const res = await ghFetch(`https://api.github.com/users/${encodeURIComponent(clean)}/repos?per_page=100&sort=pushed&type=owner`);
  if (res.status === 404) throw new Error(`GitHub user "${clean}" not found.`);
  if (res.status === 403) throw new Error("GitHub rate limit reached. Try again later or set GITHUB_TOKEN.");
  if (!res.ok) throw new Error(`GitHub request failed (${res.status}).`);
  const raw = (await res.json()) as any[];
  const repos: GithubRepoSignal[] = raw
    .filter((r) => !r.fork)
    .slice(0, 60)
    .map((r) => ({
      name: r.name,
      language: r.language ?? null,
      topics: Array.isArray(r.topics) ? r.topics : [],
      stars: r.stargazers_count ?? 0,
      description: r.description ?? null,
    }));

  const technologies: Record<string, number> = {};
  for (const r of repos) {
    const techs = new Set<string>();
    if (r.language) techs.add(r.language.toLowerCase());
    for (const t of r.topics) techs.add(t.toLowerCase());
    for (const t of techs) technologies[t] = (technologies[t] ?? 0) + 1;
  }
  log.info("github profile fetched", { username: clean, repos: repos.length, techs: Object.keys(technologies).length });
  return { username: clean, repoCount: repos.length, repos, technologies };
}
