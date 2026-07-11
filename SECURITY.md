# Security Policy

## Reporting a vulnerability

Please do not report security issues through public GitHub issues.

Use **GitHub Security Advisories** (the repository's Security tab, "Report a vulnerability"), or
email the maintainers privately with "SECURITY" in the subject line.

Include a description, reproduction steps, and the `requestId` from any API error if you have one.
We will acknowledge your report and credit you in the release notes unless you prefer otherwise.

## Deployment notes

This app handles voice recordings and a persistent Skill Knowledge Graph. When deploying:

- Never enable `DEMO_MODE` in production. It substitutes mock data that must not be presented as
  real results.
- The Skill Knowledge Graph is personal data. The local store (`.skill-memory/`) and any Cognee
  dataset are keyed per learner; scope access to the authenticated user and honour `forget()`
  (`/api/skill-graph/forget`) so learners can delete their memories.
- Never commit secrets. `COGNEE_API_KEY`, `SARVAM_API_KEY` and tokenized URLs belong in environment
  variables only.
- Rate limiting is in-memory by default. For multi-instance deployments, back the limiter in
  `lib/rateLimit.ts` with a shared store such as Redis.
- Treat LLM output as untrusted. All model responses are validated against Zod schemas in
  `lib/schemas.ts`.
