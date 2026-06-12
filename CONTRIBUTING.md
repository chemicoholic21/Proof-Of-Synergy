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
cp .env.example .env.local
npm run dev
```

The app runs in two modes via the `DEMO_MODE` environment variable:

- `DEMO_MODE=true`: no credentials needed. External calls fall back to clearly labelled sample data.
- `DEMO_MODE=false` (default): external services must be configured. Failures return real errors
  instead of fake data. Do not ship mock data as real results.

See [`.env.example`](./.env.example) for all variables.

## Project layout

```
app/         Next.js pages and API routes (app/api/*)
components/   React components
lib/         Shared logic: env, schemas (Zod), prompts, Sarvam client, chain, scoring
contracts/   Foundry smart contracts
```

## Before you open a PR

Run the checks locally. CI runs them too.

```bash
npm run check   # typecheck + lint + test
npm run build
```

Tests live next to the code as `*.test.ts` in `lib/`. Add tests for new logic.

## Standards

- TypeScript strict mode. Validate untrusted input (request bodies, uploads, LLM output) with a
  Zod schema in `lib/schemas.ts` rather than casting.
- Fail honestly. Outside `DEMO_MODE`, return a proper error, never fabricated data.
- Keep secrets in env. Never hardcode keys or tokens. Add new variables to `lib/env.ts` and
  `.env.example`.
- Use clear, imperative commit messages. Keep PRs focused and fill in the template.

## Security

Do not file public issues for vulnerabilities. See [`SECURITY.md`](./SECURITY.md).
