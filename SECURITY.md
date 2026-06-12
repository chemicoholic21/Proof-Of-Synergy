# Security Policy

## Supported versions

This project is under active development. Security fixes are applied to the `main` branch and the
latest release.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, use one of the following private channels:

1. **GitHub Security Advisories** — go to the repository's **Security** tab → **Report a
   vulnerability** (preferred).
2. **Email** — contact the maintainers privately and include "SECURITY" in the subject line.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce (proof-of-concept, affected endpoint/route, payload).
- Any relevant logs or the `requestId` from an API error response.

We will acknowledge your report as soon as possible, keep you informed of progress, and credit you
in the release notes unless you prefer to remain anonymous.

## Scope & hardening notes

This application handles resumes, voice recordings and on-chain attestations. When deploying it,
note the following operational requirements:

- **Never enable `DEMO_MODE` in production.** Demo mode substitutes mock data and non-resolvable
  IPFS CIDs, which must never be presented as real evaluation results or written on-chain as
  evidence.
- **Protect the minting endpoint.** `/api/mint` signs transactions with a funded server wallet. Set
  `MINT_API_SECRET` (the app refuses anonymous minting in production otherwise) and keep the
  `DEPLOYER_PRIVATE_KEY` in a secrets manager. Prefer a dedicated, low-privilege signer with spend
  limits over a high-value key.
- **Never commit secrets.** API keys, private keys and tokenized RPC URLs belong in environment
  variables only. The repository's `.gitignore` excludes `.env*` files — keep it that way.
- **Rate limiting is in-memory by default.** For horizontally-scaled deployments, back the limiter
  in `lib/rateLimit.ts` with a shared store (e.g. Redis) to make limits effective across instances.
- **Treat LLM output as untrusted.** All model responses are validated against Zod schemas in
  `lib/schemas.ts`; preserve this when adding new model-backed features.

Thank you for helping keep Proof of Synergy and its users safe.
