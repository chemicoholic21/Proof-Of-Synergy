# Voice Pipeline Metrics — Current Instrumentation (Baseline)

Status: describes the metrics/telemetry that **already exist** in the codebase today
(`lib/voice-latency.ts`, the `timing` fields returned by the voice API routes, and the
OpenTelemetry spans in `lib/tracing.ts`). No new metrics were added to produce this document; this
is an inventory, cross-referenced with `docs/observability.md` (the existing Phoenix span map).

## 1. What is measured: per-turn latency stages

One `VoiceLatencyTracker` (`lib/voice-latency.ts`) is created per conversational turn — from the
moment the mic opens to the moment the reply starts playing back — and accumulates a sparse map of
stage → epoch-ms timestamp as the turn moves through the pipeline. A field stays absent if that
turn never reached the stage (e.g. a typed answer has no mic/STT stages; a non-hands-free turn has
no TTS/playback stages).

| Stage | Recorded where | Boundary crossed |
| --- | --- | --- |
| `mic_start` | Browser — `VoiceRecorder.start()` | — (local) |
| `speech_detected` | Browser — VAD tick loop, first speech onset | — (local) |
| `speech_end` | Browser — VAD tick loop, committed at recording stop | — (local) |
| `audio_upload_start` | Browser — `handleRecorded()` before `fetch /api/transcribe` | about to cross client→server |
| `audio_upload_end` | Server — `/api/transcribe`, right after `req.formData()` resolves | client→server upload boundary |
| `stt_start` | Server — `/api/transcribe`, before the Sarvam STT loop | about to cross server→Sarvam |
| `stt_end` | Server — `/api/transcribe`, after all segments transcribed | server→Sarvam round trip done |
| `llm_start` | Server — `/api/gemini`, before `generatePartnerReply()` | about to cross server→Sarvam/Google |
| `llm_first_token` | Server — `/api/gemini` (currently == `llm_end`; no streaming) | n/a today |
| `llm_end` | Server — `/api/gemini`, after the reply is generated | server→LLM round trip done |
| `tts_start` | Browser — `lib/tts-client.ts:speak()` before `fetch /api/tts` | about to cross client→server |
| `tts_first_audio` | Server — `/api/tts` (currently == `tts_end`; Bulbul is non-streaming) | n/a today |
| `tts_end` | Server — `/api/tts`, after Sarvam TTS responds | server→Sarvam round trip done |
| `audio_playback_start` | Browser — the instant either the `<audio>` element or `speechSynthesis` actually starts producing sound | — (local) |

Server-computed stages travel back to the browser inside each route's JSON response under a
`timing` key (`{ text, timing }` for transcribe, `{ reply, timing }` for gemini, `{ audio, timing }`
for tts) and are folded into the same client-side tracker via `VoiceLatencyTracker.merge()`. All
timestamps use `Date.now()` (shared wall-clock epoch), not `performance.now()`, specifically so
that client-stamped and server-stamped marks — which straddle the network — can be diffed at all;
the tradeoff is sensitivity to clock skew between the browser and the server host, so these numbers
are for spotting which stage dominates, not for sub-millisecond profiling.

## 2. Derived metrics (`computeVoiceLatencyMetrics`)

Computed from whatever stages a turn actually reached; a field is `NaN` (never thrown) if either
timestamp it depends on is missing.

| Metric | Formula | Meaning |
| --- | --- | --- |
| `speechEndToSttMs` | `stt_start − speech_end` | Silence detected → STT actually starts on the server: covers upload time + server queueing. |
| `sttMs` | `stt_end − stt_start` | Time the Sarvam STT call itself took. |
| `llmTimeToFirstTokenMs` | `llm_first_token − llm_start` | Equals `llmTotalMs` today (no streaming). |
| `llmTotalMs` | `llm_end − llm_start` | Total LLM call time. |
| `ttsTimeToFirstAudioMs` | `tts_first_audio − tts_start` | Equals the full TTS call time today (no streaming). |
| `totalTimeToFirstAudioMs` | `audio_playback_start − speech_end` | **The number that matters to the user**: going silent → hearing the reply start. Spans upload + STT + LLM + TTS + playback-start. |

`isVoiceLatencyComplete(metrics)` is `true` only once every derived field above is a finite number
— i.e. the full mic-through-playback turn completed (hands-free mode, successful STT+LLM+TTS).

## 3. Where the numbers go

- **Client-side**: `app/practice/page.tsx` owns one `VoiceLatencyTracker` per turn
  (`latencyRef.current`), seeded from `VoiceRecorder`'s client marks in `handleRecorded()`, then
  merged with each route's returned `timing` as the turn progresses through
  transcribe → gemini → (optionally) tts.
- **Reporting**: once a turn is finished (reply spoken in hands-free mode, or reply generated in
  typed/non-hands-free mode), `reportVoiceLatency(tracker)` fires a fire-and-forget
  `POST /api/telemetry/voice-latency` with `{ turnId, timestamps, metrics }`
  (`VoiceLatencyReportBody` zod schema). This never blocks or affects the UI — failures here are
  logged and swallowed.
  - A turn that fails during transcription (STT error) still reports whatever marks it reached
    (mic/upload/STT) rather than being silently dropped, so failed-turn latency is observable too.
- **Server-side**: `/api/telemetry/voice-latency` (`app/api/telemetry/voice-latency/route.ts`)
  converts the report into a `voice.turn` OpenTelemetry chain span via
  `traceChain` + `setVoiceLatencyMetrics(span, metrics, timestamps)`, and logs it
  (`logger.info("voice turn latency", { turnId, ...metrics })`). It also filters out any
  non-finite metric value before tracing/logging, since `null`/`NaN` means "this turn never
  reached that stage," not "zero."
- **Per-stage server timing** is *also* emitted independently as span attributes on the
  `transcribe`, `conversation.turn`, and `tts` chain spans themselves
  (`setVoiceLatencyMetrics(span, {}, timing)` inside each route), so the same timing data is
  visible both as its own dedicated `voice.turn` summary span and nested inside each stage's own
  chain span — see `docs/observability.md` for the full span table (`transcribe`, `tts`,
  `conversation.turn`, `sarvam.stt`, `sarvam.tts`, `sarvam.chat`, `gemini.chat`).
- Tracing (Phoenix export) is **entirely optional** — `PHOENIX_COLLECTOR_ENDPOINT` unset means
  `lib/tracing.ts`'s span helpers are no-ops (OTel returns non-recording spans), so none of this
  instrumentation requires any external service to function; the `timing` payloads still flow
  client↔server regardless, and `console`/structured logs (`lib/logger.ts`) still capture the
  per-stage durations even with tracing off.

## 4. Metrics that do NOT exist today

Called out explicitly since a common next step is "add metrics" — these are gaps, not bugs:

- No first-token/first-audio granularity for LLM or TTS, because neither call streams
  (`llm_first_token`/`tts_first_audio` are always equal to their `_end` counterpart).
- No client-side network/transport metrics (upload bandwidth, request retries, WebSocket
  reconnects — moot anyway since no WebSocket is live, see architecture doc §8).
- No aggregate/rolling dashboards in-repo — `/api/telemetry/voice-latency` only republishes a
  per-turn span/log line; any percentile/rollup view would live in Phoenix (if configured) or
  whatever ingests the structured logs, not in this codebase.
- No accuracy metrics for STT (e.g. WER) or quality metrics for TTS/LLM output — everything here
  is latency/timing instrumentation only.
- No VAD accuracy metrics (false-positive/false-negative speech detection) — VAD state is only
  surfaced as a live UI indicator (`isSpeaking`) and the `speech_detected`/`speech_end` marks
  feed the latency tracker; nothing in the codebase currently scores whether the VAD's calls were
  correct.

## 5. Config knobs affecting these numbers (`lib/env.ts`)

| Variable | Default | Affects |
| --- | --- | --- |
| `SARVAM_CHAT_MODEL` | `sarvam-105b` | LLM latency/quality |
| `SARVAM_REASONING_EFFORT` | `none` (disabled) | LLM latency (reasoning burns tokens/time before `content` is emitted) |
| `SARVAM_MAX_TOKENS` | `4096` | LLM latency ceiling (larger budget → longer worst-case call) |
| `SARVAM_MAX_CONCURRENCY` | `4` | Queueing delay under load (in-process semaphore, adds to `llmTotalMs` indirectly) |
| `SARVAM_TTS_MODEL` / `SARVAM_TTS_SPEAKER` | `bulbul:v2` / `anushka` | TTS latency/quality |
| `GEMINI_MODEL` | `gemini-2.5-flash` | LLM latency/quality on the fallback path only |
| `MAX_AUDIO_BYTES` | 25MB | Caps upload size (`audio_upload_end − audio_upload_start`) before the request is rejected |
| `DEMO_MODE` | off | Bypasses the STT/LLM call entirely on failure with a canned transcript — turns produced this way have no real `stt_*` timing |
