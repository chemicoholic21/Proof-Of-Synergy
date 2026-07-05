# Proof Of Synergy → Career Memory (Cognee-native architecture)

This document is the result of a full repository audit performed before any code was written.
It records **what already exists**, **what stays unchanged**, **what is extended**, and the
**phased roadmap** for turning a single-session interview app into a persistent **Career
Intelligence** platform whose brain is a Cognee-powered **Career Knowledge Graph**.

The guiding principle: *every interaction must permanently improve the candidate's knowledge
graph.* If a change does not feed the evolving memory, it is out of scope.

---

## 1. Repository audit (as-is)

The app is a Next.js 14 (App Router) + TypeScript project. There is **no database and no auth
wired in today** — the whole session lives in React state in `app/page.tsx`. Every external
dependency degrades gracefully (`DEMO_MODE`, honest errors, labelled fallbacks).

### Data-flow pipeline (current)

| Stage | Owner | Notes |
| --- | --- | --- |
| Resume upload | `app/page.tsx` `handleUpload` → `POST /api/parse-resume` | `lib/sarvam.ts` OCR + LLM extract → `ParsedResume` |
| Question generation | `POST /api/generate-questions` | `lib/prompts.ts` + `lib/refine.ts` (L2 adversary). Input = **skills only**, stateless |
| Voice recording | `components/VoiceRecorder.tsx` | segments blobs (30s STT cap) |
| Speech-to-text | `POST /api/transcribe` | Saarika STT → `Transcript` |
| Evaluation | `POST /api/evaluate` | `lib/panel.ts` 3-lens judge panel → `QuestionEvaluation[]` |
| Fraud/verdict | `lib/verify.ts` | claimed level vs observed confidence → `SkillVerdict[]` |
| Mint | `POST /api/mint` | `lib/chain.ts` + `lib/ipfs.ts` → soulbound passport on Monad |

### Key modules (unchanged, reused as-is)

- `lib/sarvam.ts` — the only AI provider abstraction (chat / STT / TTS / OCR) + JSON extractors.
- `lib/env.ts` — centralized, validated env with graceful `*Configured()` guards. **Pattern to copy.**
- `lib/http.ts` — request id, error envelope, rate limit, zod body parsing.
- `lib/panel.ts`, `lib/prompts.ts`, `lib/schemas.ts` — multi-agent evaluation. Reused verbatim.
- `lib/chain.ts`, `lib/ipfs.ts` — blockchain + IPFS. Reused; only the *meaning* of the mint changes.
- `lib/logger.ts`, `lib/rateLimit.ts` — infra.

### What stays unchanged
Resume upload, voice interview, transcription, judge-panel evaluation, minting, TTS. All existing
routes keep working with the exact same request/response contracts.

### What is extended (non-breaking)
- `generate-questions` gains an **optional** `candidateId` → consults `recall()` for adaptive
  questions. Without it, behaviour is identical to today.
- `page.tsx` gains a candidate identity + a post-evaluation `remember()`/`improve()` step + a new
  Career Dashboard view.

### What is deleted
Nothing. Minimum disruption.

---

## 2. Target architecture

```
Frontend (page.tsx, dashboard, graph)
        │
        ▼
Backend API  (app/api/*  +  app/api/memory/*)
        │
        ▼
Memory Service Layer   ← the single abstraction; UI never calls Cognee directly
  lib/memory/
        │
        ▼
Cognee Service (lib/memory/cognee/client.ts)   ── real Cognee REST when configured
        │                                          └─ deterministic local graph engine otherwise
        ▼
Career Knowledge Graph  (persisted per candidate)
```

The LLM **never** generates an interview without first consulting Cognee (`recall()`), and every
completed interview flows back through `remember()` → `improve()`.

### Memory service layer (`lib/memory/`)

```
lib/memory/
  index.ts              public surface: remember / recall / improve / forget + views
  orchestrator.ts       owns the "interview complete" pipeline end-to-end
  cognee/
    client.ts           Cognee client: configured?, add/cognify/search bridge, retry, logging
  graph/
    model.ts            canonical entity + relationship model (nodes, edges, kinds)
    store.ts            persistence keyed by candidateId (file-backed; memory in tests)
    ops.ts              low-level upsert/link/neighbors/prune (graph consistency)
  remember.ts           ingest resume / interview / github into graph objects
  recall.ts             the Career Reasoner: weak / forgotten / unverified / company-relevant
  improve.ts            enrich: relate concepts, bump weights, retention, recommendations
  forget.ts             prune interview/resume/company while preserving consistency
  evidence.ts           evidence engine: every score/recommendation is traceable
  recommendations.ts    recommend only high-importance / low-confidence / low-retention concepts
  learning.ts           learning missions (read → practice → quiz → re-interview → improved)
  concepts.ts           concept ontology + prerequisite edges + spaced-repetition decay
  interview-memory.ts   semantic extraction from transcripts + Interview DNA (voice/comm metrics)
  derive.ts             dashboard views: reality gap, timeline, trends, roadmap, replay
```

### Canonical entity model (graph nodes)
Candidate, Resume, Skill, Concept, Project, Technology, Company, Interview, Question, Answer,
Evidence, Weakness/Strength (as concept state), CommunicationMetric (Interview DNA),
LearningResource/Mission, Recommendation, Milestone.

### Relationship types (the product)
`OWNS`, `CLAIMS`, `HAS_SKILL`, `USES`, `TESTS`, `DEMONSTRATED_IN`, `EVIDENCE_FOR`, `WEAK_IN`,
`STRONG_IN`, `RELATED_TO`, `PREREQ_OF`, `IMPROVES`, `RECOMMENDS`, `DISCUSSED_IN`, `PREP_FOR`,
`UPDATES_COMMUNICATION`, `RETENTION_DECAY`.

### Memory lifecycle, made visible
- **remember()** — resume/interview/github → structured nodes + relationships (never flat JSON).
- **recall()** — semantic + graph traversal answering the Career Reasoner questions.
- **improve()** — relate concepts, raise node weights, recompute confidence + retention, emit
  evidence-backed recommendations and spaced-repetition schedule.
- **forget()** — delete a memory and prune orphans while keeping the graph consistent.

### Cognee integration point
`lib/memory/cognee/client.ts` is the seam. When `COGNEE_API_URL`/`COGNEE_API_KEY` are set the
client mirrors each `remember()` into Cognee (`add` + `cognify`) and can answer `recall()` via
Cognee `search`. When unset, the deterministic local graph engine provides identical semantics so
the demo runs with zero credentials — same posture as `DEMO_MODE` elsewhere. Removing this layer
removes adaptivity, evidence, reality gap, retention and roadmap — i.e. the product.

---

## 3. Phased roadmap (incremental commits)

1. **Graph model + store + ops** — canonical model, per-candidate persistence, consistency ops.
2. **Cognee client** — configured guard + REST bridge + local-engine fallback.
3. **remember()** — resume + interview ingestion into nodes/edges; Interview DNA extraction.
4. **recall()** — Career Reasoner queries (weak / forgotten / unverified / undiscussed / company).
5. **improve()** — concept relation, weights, retention decay, recommendations, learning missions.
6. **forget()** + evidence + derive views (reality gap, timeline, trends, roadmap, replay).
7. **Memory API routes** (`/api/memory/*`) + adaptive `generate-questions` + demo seed.
8. **Orchestrator** wiring the interview-complete pipeline.
9. **UI**: Career Dashboard, Knowledge Graph viz, Reality Gap, Evidence, Trends, Timeline,
   Roadmap, Replay — all consuming graph data; reframed "Proof of Growth" mint.
10. **Demo mode**: one-click seed (resume + 3 interviews + comm history) for the 5-minute script.

Success test (all must be "yes"): remembers me across sessions · every interview gets smarter ·
explains every recommendation · adapts using long-term memory · Cognee obviously central ·
removing Cognee guts the product.
