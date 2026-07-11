# Contributing to Proof of Synergy

Thanks for your interest in contributing. This project is open source under the
[MIT License](./LICENSE), and is shared for fair use: learn from it, build on it, and adapt it,
as long as you keep the license and copyright notice.

Bug reports, features, docs, and tests are all welcome.

## Setup

Requirements: Node.js `>=18.18` and npm.

```bash
git clone https://github.com/<your-fork>/ProofOfSynergy.git
cd ProofOfSynergy
npm install
cp .env.local.example .env.local
npm run dev
```

The app degrades gracefully without credentials (local conversation partner, heuristic coaching,
local skill-graph engine). `DEMO_MODE=true` additionally substitutes clearly labelled sample data
when a voice service is unavailable; outside demo mode, failures return real errors instead of
fake data. See [`.env.local.example`](./.env.local.example) for all variables.

## Project layout

```
app/                    Next.js pages (/, /practice, /knowledge-graph) and API routes
components/             React components (voice recorder, scenario player)
components/knowledge-graph/  the Skill Knowledge Graph UI (canvas + explorer)
lib/                    one module per responsibility: gemini, gemma, sarvam, cognee,
                        skill-graph, scenarios, communication-metrics, env, schemas (Zod), ...
```

## Before you open a PR

Run the checks locally. CI runs them too.

```bash
npm run check   # typecheck + test
npm run build
```

Tests live next to the code as `*.test.ts` in `lib/`. Add tests for new logic.

## Standards

- TypeScript strict mode. Validate untrusted input (request bodies, uploads, LLM output) with a
  Zod schema in `lib/schemas.ts` rather than casting.
- Fail honestly. Outside `DEMO_MODE`, return a proper error, never fabricated data.
- Keep secrets in env. Never hardcode keys or tokens. Add new variables to `lib/env.ts` and
  `.env.local.example`.
- Use clear, imperative commit messages. Keep PRs focused and fill in the template.

## Security

Do not file public issues for vulnerabilities. See [`SECURITY.md`](./SECURITY.md).
