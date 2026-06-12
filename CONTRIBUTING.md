# Contributing to Proof of Synergy

First off — thank you for taking the time to contribute! 🎉 This project is open source under the
[MIT License](./LICENSE), and contributions of all kinds are welcome: bug reports, features,
documentation, tests, and design feedback.

This guide explains how to get set up, the standards we hold code to, and how to get your change
merged.

## Table of contents

- [Code of Conduct](#code-of-conduct)
- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Project structure](#project-structure)
- [Running the app](#running-the-app)
- [Quality gates](#quality-gates)
- [Coding standards](#coding-standards)
- [Commit & PR guidelines](#commit--pr-guidelines)
- [Security](#security)

## Code of Conduct

This project adheres to a [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you are expected
to uphold it. Please report unacceptable behaviour as described there.

## Ways to contribute

- **Report a bug** — open an issue using the Bug Report template. Include reproduction steps, the
  expected vs. actual behaviour, and the `requestId` from the API error if you have one.
- **Request a feature** — open an issue using the Feature Request template and describe the problem
  you are trying to solve, not just the solution.
- **Fix or build something** — comment on the relevant issue (or open one) so we can avoid duplicated
  effort, then send a pull request.
- **Improve docs** — typo fixes and clarifications are genuinely appreciated.

## Development setup

**Prerequisites**

- Node.js `>=18.18` (see `.nvmrc`)
- `npm` (the repo ships a `package-lock.json`)
- Optional: [Foundry](https://book.getfoundry.sh/) if you are working on the smart contracts in
  `contracts/`

**Install**

```bash
git clone https://github.com/<your-fork>/ProofOfSynergy.git
cd ProofOfSynergy
npm install
cp .env.example .env.local   # then fill in values as needed
```

The app runs in two postures, controlled by the `DEMO_MODE` environment variable:

- `DEMO_MODE=true` — no third-party credentials required. External calls (Sarvam, chain, IPFS)
  degrade to clearly-labelled sample data. Ideal for local UI work and quick demos.
- `DEMO_MODE=false` (default / production) — external dependencies must be configured. Failures
  surface as honest API errors instead of fabricated data. **Never ship mock data as real results.**

See [`.env.example`](./.env.example) for the full list of variables.

## Project structure

```
app/            Next.js App Router — pages and API routes (app/api/*)
components/     React components (voice recorder, question player)
lib/            Server/shared logic:
  env.ts          validated environment configuration (single source of truth)
  schemas.ts      Zod schemas for all request bodies AND LLM output
  sarvam.ts       Sarvam AI client (chat, STT, TTS, parse) + JSON extraction
  chain.ts        viem chain config, ABIs, server wallet
  verify.ts       LLM→chain bridge + skill fraud detector
  prompts.ts      all LLM prompts (parse, question-gen, evaluate)
  http.ts         request IDs, error envelopes, rate-limit + body parsing helpers
  rateLimit.ts    in-memory rate limiter
  logger.ts       structured JSON logger
contracts/      Foundry smart contracts (Registry, Passport, Gate)
```

## Running the app

```bash
npm run dev      # start the dev server on http://localhost:3000
npm run build    # production build
npm run start    # serve the production build
```

## Quality gates

Every pull request must pass these checks (CI runs them automatically; please run them locally
first):

```bash
npm run typecheck   # tsc --noEmit
npm run lint        # next lint
npm run test        # vitest run
npm run build       # next build
```

Or run the first three together:

```bash
npm run check
```

**Tests live next to the code they cover** as `*.test.ts` in `lib/`. Any new pure/business logic
(validation, scoring, parsing, utilities) should ship with tests. We use
[Vitest](https://vitest.dev/).

## Coding standards

- **TypeScript, strict mode.** Avoid `any`; prefer precise types. Do not use `as` casts to bypass
  validation at a trust boundary — validate with a Zod schema instead.
- **Validate untrusted input.** Anything from a request body, a file upload, or the LLM is untrusted.
  Add/extend a schema in `lib/schemas.ts` and parse it.
- **Fail honestly.** Outside `DEMO_MODE`, never return fabricated data on failure — return a proper
  error status via the `lib/http.ts` helpers. Mock data must always carry a `source`/`reason` flag.
- **Log with context.** Use the `logger` from `lib/logger.ts` and include the `requestId`.
- **Keep secrets in env.** Never hardcode keys, tokens, or tokenized URLs. Add new variables to
  `lib/env.ts` and document them in `.env.example`.
- **No new dependencies without reason.** Prefer the standard library and existing deps.

## Commit & PR guidelines

- Use clear, imperative commit messages. [Conventional Commits](https://www.conventionalcommits.org/)
  (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`) are encouraged.
- Keep PRs focused — one logical change per PR is easier to review.
- Fill in the PR template: what changed, why, and how you tested it.
- Link the issue your PR closes (`Closes #123`).
- Ensure CI is green before requesting review.

## Security

Please do **not** open public issues for security vulnerabilities. Follow the process in
[`SECURITY.md`](./SECURITY.md) instead.

---

Happy hacking! If anything here is unclear, open an issue and we'll improve the docs.
