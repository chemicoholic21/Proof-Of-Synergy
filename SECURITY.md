# Security Policy

## Reporting a vulnerability

Please do not report security issues through public GitHub issues.

Use **GitHub Security Advisories** (the repository's Security tab, "Report a vulnerability"), or
email the maintainers privately with "SECURITY" in the subject line.

Include a description, reproduction steps, and the `requestId` from any API error if you have one.
We will acknowledge your report and credit you in the release notes unless you prefer otherwise.

## Deployment notes

This app handles resumes, voice recordings, and on-chain attestations. When deploying:

- Never enable `DEMO_MODE` in production. It substitutes mock data and non-resolvable IPFS CIDs that
  must not be presented as real results or written on-chain.
- Protect `/api/mint`. It signs transactions with a funded server wallet. Set `MINT_API_SECRET` and
  keep `DEPLOYER_PRIVATE_KEY` in a secrets manager. Prefer a low-privilege signer with spend limits.
- Never commit secrets. Keys and tokenized RPC URLs belong in environment variables only.
- Rate limiting is in-memory by default. For multi-instance deployments, back the limiter in
  `lib/rateLimit.ts` with a shared store such as Redis.
- Treat LLM output as untrusted. All model responses are validated against Zod schemas in
  `lib/schemas.ts`.
