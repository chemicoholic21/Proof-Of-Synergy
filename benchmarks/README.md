# Voice interview benchmark suite

Evaluates the voice interview pipeline across ten realistic conditions and six metrics, so a
change to STT/LLM/TTS configuration, prompts, or the `lib/interview/` pipeline can be checked
against a fixed set of cases instead of "it sounded fine when I tried it."

## Conditions covered

| Category | What it stresses |
| --- | --- |
| Clean audio | Baseline — no degradation to attribute a regression to. |
| Noisy audio | STT robustness to background noise (substitutions/dropped words). |
| Indian English | STT/LLM handling of Indian English phrasing and rhythm. |
| Hinglish | Code-mixed Hindi/English transcription and follow-up quality. |
| Fast speakers | STT robustness to rapid, run-together speech. |
| Slow speakers | Filler-word-heavy, paused speech. |
| Technical vocabulary | Preserving dense jargon (the case STT most often mangles). |
| Long answers | Multi-part answers spanning several sub-topics. |
| Short answers | Low-content answers with little for a follow-up to build on. |
| Interrupted speech | A barge-in cutting the candidate off mid-sentence (see `lib/voice/VoiceSession.ts`'s `interrupt()`). |

## Metrics

| Metric | Computed by | Scale |
| --- | --- | --- |
| STT accuracy | `sttAccuracy()` — `1 - Word Error Rate` | 0-1 |
| Technical term accuracy | `technicalTermAccuracy()` — recall over a case's expected domain terms | 0-1 |
| Latency | `measureLatency()` / `summarizeLatencies()` | ms |
| Question relevance | `scoreQuestionRelevance()` | 0-10 |
| Follow-up quality | `scoreFollowUpQuality()` | 0-10 |
| Human scoring agreement | `humanAgreement()` — human vs. automated score agreement across all cases | mixed (see below) |

## Running it

```bash
npx vitest run benchmarks
```

`runBenchmarks.test.ts` runs the full suite against the built-in fixtures and asserts the report
is complete and every number is in its expected range. `metrics.test.ts` unit-tests each metric
function against hand-computed cases, independent of the fixtures.

To inspect a report directly:

```ts
import { runBenchmarks } from "./benchmarks/runBenchmarks";
const report = await runBenchmarks();
console.log(JSON.stringify(report, null, 2));
```

## Scope and honest limitations

This environment has no recorded audio corpus, no configured `SARVAM_API_KEY`/`GEMINI_API_KEY`,
and no human raters available to it. Building a benchmark suite that pretends otherwise would
produce numbers that look real but aren't. Instead, this suite is the deterministic *harness* —
correct, tested metric math, a fixture format covering all ten conditions, and a runner — built so
that plugging in the real thing later requires no redesign:

- **`BenchmarkCase.sttHypothesis`** (`fixtures.ts`) is hand-authored to be *representative* of each
  condition's typical STT failure mode (dropped words under noise, code-mixed script under
  Hinglish, a clipped ending under interruption), not the output of a real STT call on a real
  recording. Replace it with an actual transcription result and nothing else needs to change —
  `metrics.ts` and `runBenchmarks.ts` operate on plain text, indifferent to where it came from.
- **Latency** is near-zero by default because `runBenchmarks()`'s `simulateTurn` option defaults to
  a no-op — see its doc comment. Pass a real one (e.g. wiring up
  `lib/providers/stt/SarvamRealtimeSTT.ts` / `lib/interview/ConversationEngine.ts` /
  `lib/providers/tts/BulbulV3TTSProvider.ts` for a real round trip) to get a real number; until
  then, `latencyMs` measures harness overhead, not the pipeline.
- **Question relevance / follow-up quality** default to a deterministic keyword-overlap heuristic
  (see `heuristicOverlapScore` in `metrics.ts`) — a crude, reproducible proxy, not a substitute for
  real judgment. Both accept a `RelevanceJudge` (e.g. an LLM-as-judge call, or
  `lib/interview/EvidenceEvaluator.ts` extended for this purpose) to replace it.
- **Human scoring agreement** compares each fixture's `humanScore` against its `automatedScore` —
  both are currently illustrative values chosen to exercise `humanAgreement()`'s math (see its
  tests), not scores from an actual human rater or an actual evaluator run. Replace them with real
  values from an actual rating pass to get a real agreement number.

None of this is a gap to "fix later" so much as the honest boundary of what's checkable inside a
sandboxed environment versus what needs a real deployment, real audio, and real people — the same
posture this codebase already takes elsewhere (e.g. `SarvamRealtimeSTT.ts`'s SSE format being an
informed assumption pending verification against the live API, or `EvidenceEvaluator.ts` refusing
to fabricate a score rather than guess one).
