# Multi-agent evaluation pipeline

ProofOfSynergy turns a resume + spoken interview into an on-chain skills attestation. Because a
score becomes **immutable**, the pipeline is built as a chain of narrow agents with typed
contracts and **external** verification at every contestable step, rather than one prompt doing
everything.

## Design principles (and why)

- **Typed contract at every agent boundary.** Each agent returns Zod-validated JSON
  (`extractValidatedJson`). Under-specified roles + missing verification - not weak models - are
  the dominant multi-agent failure mode (*Why Do Multi-Agent LLM Systems Fail? / MAST*,
  arXiv:2503.13657).
- **Verification is always external.** A second agent or a deterministic check grades the first
  agent's output; no model grades its own work. Intrinsic self-correction without an external
  signal can degrade results (*LLMs Cannot Self-Correct Reasoning Yet*, Huang et al., ICLR 2024).
- **Diverse judges, not clones.** A judge panel only beats a single judge if member errors are
  uncorrelated, so the panel uses three different lenses (PoLL / Verga et al. 2024; *Nine Judges,
  Two Effective Votes*, arXiv:2605.29800).
- **Explicit score anchors.** The single biggest LLM-as-a-judge reliability lever is giving each
  judge concrete rubric/score-anchor descriptions (arXiv:2506.13639).
- **Sampling + averaging.** Judges sample at temperature and average across runs, which tracks
  human judgement better than greedy decoding (same paper). Controlled by `EVAL_PANEL_SAMPLES`.
- **Aggregation is deterministic code.** Auditable, cannot hallucinate, and emits a confidence
  signal so low-confidence results can be held back from the chain.

## Layers

| Layer | Role | Where | Failure policy |
|-------|------|-------|----------------|
| L1 Extraction verifier | Drop hallucinated skills not grounded in the resume text | `lib/refine.ts` → `parse-resume` | best-effort; never empties the list |
| L2 Question adversary | Rewrite weak (yes/no, definition-lookup, self-answering) questions | `lib/refine.ts` → `generate-questions` | best-effort; keeps originals on failure |
| L3 Judge panel | 3 diverse lenses: technical depth · communication/authenticity · skeptic | `lib/panel.ts` → `evaluate` | strict; any judge failure propagates |
| L4 Aggregation | Weighted combine (tech 0.6 / comm 0.4 − skeptic deduction) + confidence | `lib/panel.ts` (`aggregatePanel`, pure/tested) | deterministic |

L3/L4 are the centerpiece because they produce the score that is written on-chain. The three
judges fan out concurrently, so panel latency ≈ one judge, not three.

## Configuration (`lib/env.ts`)

| Env var | Default | Effect |
|---------|---------|--------|
| `EVAL_PANEL` | `true` | Use the judge panel; set false to fall back to the legacy single-judge prompt |
| `EVAL_PANEL_SAMPLES` | `1` | Samples averaged per judge (1–7); higher = more stable, linearly more cost |
| `EVAL_CONFIDENCE_MIN` | `50` | Below this panel-agreement confidence, results are flagged `lowConfidence` for human review |
| `EVAL_VERIFY_LAYERS` | `true` | Enable the L1/L2 best-effort verification layers |

## Cost / latency

Per interview answer: 3 judge calls (× `EVAL_PANEL_SAMPLES`) instead of 1, run in parallel.
Use the smaller model for L1/L2 verifiers and reserve the larger reasoning model for the scoring
judges. Disagreement triggers a `lowConfidence` flag rather than an expensive debate round by
default.

## Notes / future work

- **Fairness (L0/L5).** In the current data flow the scorer sees only the question + transcribed
  answer (no name/demographics), so blind-assessment redaction is lower-value here than in a
  resume-*ranking* product. If resume text ever reaches the scorer, add an anonymizer (L0) and a
  counterfactual fairness gate (L5) before the on-chain write - LLMs demonstrably skew hiring
  scores by name-inferred gender/race (arXiv:2503.19182, 2504.01420, 2507.02087).
- **Confidence gate on mint.** `QuestionEvaluation.lowConfidence` is surfaced end-to-end; the
  mint step can refuse to attest low-confidence scores without human review.
