# Voice Architecture — Wired State

Status: **as-built documentation**, written immediately after wiring the previously-disconnected
modules together. Companion to `docs/voice-architecture-current.md` (the "before" baseline) — read
that one first for what changed. This describes what the code does now, warts included, mapped
box-by-box against the "parallel event-driven architecture" diagram that prompted this work.

Scope: the new realtime path (`server/voice-gateway.ts` + `lib/voice/InterviewPipeline.ts` +
`lib/voice-client/*`), reachable at `/practice/realtime`. **The original batch pipeline
(`components/VoiceRecorder.tsx` + `app/practice/page.tsx`, described in full in the baseline doc)
is untouched and still the default `/practice` experience.** The two do not share runtime state.

---

## 1. Box-by-box mapping

```
Browser Client
  Mic ──getUserMedia──▶ AudioWorklet(AEC/noise/gain/PCM) ──▶ Local VAD ──▶ barge-in
                              │                                  │
                    public/pcm-worklet-           lib/voice-client/UtteranceGate.ts
                    processor.js (real PCM              (wraps lib/vad.ts's
                    framing + RMS; AEC/noise/       UtteranceDetector — pre-existing,
                    gain delegated to               previously unused anywhere)
                    getUserMedia constraints)
                              │
                    lib/voice-client/RealtimeVoiceClient.ts (WebSocket protocol client)
                              │
                              ▼
Realtime Voice Gateway (Session Controller: lifecycle/reconnection/sequence numbers/cancellation)
  server/voice-gateway.ts — replaces the old, inert server/ws-server.ts
                              │
                              ▼
Saaras Realtime v3 WebSocket ── partial/final
  lib/providers/stt/SarvamRealtimeSTT.ts (pre-existing, now actually invoked)
                              │
                              ▼
Turn Engine
  lib/voice/VoiceSession.ts + lib/voice/TurnManager.ts (pre-existing, now actually driving a live session)
                              │
                              ▼
Turn Decision
  lib/interview/InferenceRouter.ts — called from InterviewPipeline.generateReply() every turn
                              │
        ┌─────────────────────┼──────────────────────────────┐
        ▼                     ▼                               ▼
  Fast Response Lane    Background Evaluation             Memory Update
  105B Conversations    105B (EvidenceEvaluator,      Structured State
  (ConversationEngine)  a *separate* SarvamLLM         (MemoryEngine, mutated by
  → Token Stream*       instance/model choice          InterviewPipeline's
  → Response Planner    from ConversationEngine's)     handleEvaluationEvent(),
  → Speech Chunker      → Evaluation Worker             fed by DifficultyController's
  → Bulbul v3           (EvaluationWorker polling       decide()) — flows back into
  → Audio Queue         EvaluationQueue, enqueued       every future turn automatically
  → Playback            fire-and-forget from the        via ContextBuilder reading
                        fast lane, never awaited)        memory.buildContextSummary()
```

`*` Token Stream is an honest simplification — see §3.

| Diagram box | File(s) | Wired? |
| --- | --- | --- |
| Mic / getUserMedia | `lib/voice-client/RealtimeAudioCapture.ts` | Yes |
| AudioWorklet (PCM) | `public/pcm-worklet-processor.js` | Yes, real framing + RMS |
| AudioWorklet (AEC/noise/gain) | `getUserMedia` constraints in `RealtimeAudioCapture.ts` | Delegated to the browser, not reimplemented (see §3) |
| Local VAD | `lib/voice-client/UtteranceGate.ts` (wraps the pre-existing, previously-unused `UtteranceDetector` in `lib/vad.ts`) | Yes |
| barge-in | `RealtimeVoiceClient.notifySpeechStarted()`/`bargeIn()` → `VoiceSession.interrupt()` | Yes |
| Realtime Voice Gateway / Session Controller | `server/voice-gateway.ts` | Yes — replaces `server/ws-server.ts` (removed) |
| Saaras Realtime v3 WebSocket | `lib/providers/stt/SarvamRealtimeSTT.ts` | Yes (pre-existing since an earlier phase; this work is what finally calls it) |
| Turn Engine | `lib/voice/VoiceSession.ts`, `lib/voice/TurnManager.ts` | Yes (pre-existing; this work is what finally drives it with a live session) |
| Turn Decision | `lib/interview/InferenceRouter.ts` | Yes |
| 105B Conversations | `lib/interview/ConversationEngine.ts` | Yes |
| Token Stream | — | Simplified, see §3 |
| Response Planner | `lib/interview/ResponsePlanner.ts` | Yes |
| Speech Chunker | `lib/voice/SpeechChunker.ts` | Yes |
| Bulbul v3 | `lib/providers/tts/BulbulV3TTSProvider.ts` | Yes |
| Audio Queue | `lib/voice-client/AudioPlaybackQueue.ts` | Yes |
| Playback | `RealtimeAudioCapture.playChunk()` (Web Audio `AudioBufferSourceNode`) | Yes |
| Background Evaluation (105B) | `lib/interview/EvidenceEvaluator.ts` + `defaultEvaluate` (`lib/interview/EvaluationWorker.ts`) | Yes |
| Evaluation Worker | `lib/interview/EvaluationWorker.ts` polling `lib/interview/EvaluationQueue.ts` | Yes |
| Memory Update / Structured State | `lib/interview/MemoryEngine.ts`, mutated via `lib/interview/DifficultyController.ts`'s decision in `InterviewPipeline.handleEvaluationEvent()` | Yes |

Every box in the diagram now corresponds to code that is actually called at runtime by something
else in this list — not an isolated, individually-tested module sitting unreferenced, which was
the finding of the pre-wiring audit (`docs/voice-architecture-current.md` §5, "Orphaned/unwired
code").

## 2. What actually changed, file by file

- **`lib/voice/VoiceSession.ts`** — added `synthesizeSpeechStream` (chunked TTS delivery,
  per-chunk abort guarding) alongside the pre-existing one-shot `synthesizeSpeech`, since real
  Bulbul playback needs to start before the whole reply is done streaming through
  `SpeechChunker`.
- **`lib/voice/InterviewPipeline.ts`** (new) — the assembly step. Its `generateReply` implements
  Turn Decision + the fast response lane + firing background evaluation without awaiting it; its
  `synthesizeSpeechStream` implements Speech Chunker → Bulbul; its `handleEvaluationEvent`
  implements Background Evaluation → Memory Update. Owns one `VoiceSession` per interview.
- **`lib/interview/EvaluationQueue.ts`** — `EvaluationResult` gained an optional `evidence` field
  so a worker can carry `EvidenceEvaluator`'s technical scoring alongside the pre-existing
  heuristic summary/metrics (additive, non-breaking).
- **`server/voice-gateway.ts`** (new, replaces `server/ws-server.ts`) — the Session Controller:
  one `InterviewPipeline` per session, keyed by `sessionId` (not by socket) so a brief disconnect
  doesn't lose interview state, a small JSON control protocol over WebSocket text frames, raw PCM
  over binary frames, and a per-session `seq` counter on every JSON message.
- **`lib/voice-client/UtteranceGate.ts`, `AudioPlaybackQueue.ts`, `RealtimeVoiceClient.ts`** (new)
  — the unit-tested browser-side logic: local VAD event edges, sequential audio playback queueing,
  and the gateway's wire protocol mirrored client-side, all DOM-free and tested with fakes.
- **`lib/voice-client/RealtimeAudioCapture.ts`** (new) — the DOM glue composing the three modules
  above with `getUserMedia`/`AudioContext`/`AudioWorkletNode`. See §4 for why this file has zero
  test coverage by design.
- **`public/pcm-worklet-processor.js`** (new) — the real `AudioWorkletProcessor`: PCM framing and
  per-frame RMS. Also has zero test coverage by design (§4).
- **`lib/voice/realtimeAudioFormat.ts`** (new) — the shared `linear16`/16kHz constant both the
  gateway (configuring `BulbulV3TTSProvider`) and the browser client (decoding audio) import,
  instead of duplicating magic numbers that must stay in sync.
- **`components/RealtimeVoiceRecorder.tsx` + `app/practice/realtime/page.tsx`** (new) — the
  minimal, explicitly-labeled "Experimental" integration point, linked from the main practice
  page's nav. The existing `/practice` batch flow is unmodified.
- **Removed**: `server/ws-server.ts` and `lib/webrtc-signal.ts` — the old, inert stub (it treated
  raw PCM bytes as a UTF-8 transcript and was started by no npm script) and its now-orphaned
  signaling types. Nothing else in the repo imported either.

## 3. Known, honest limitations

These are not oversights discovered after the fact — each was a deliberate scope decision, called
out in the relevant file's own docstring at the time it was written.

1. **"Token Stream" is chunked delivery, not token-level generation.**
   `ConversationEngine.nextTurn()` returns one complete, schema-validated JSON response — it
   cannot stream token-by-token, because the response can't be validated against
   `InterviewTurnResponse`'s schema until it has fully arrived. "Streaming" in this
   implementation means the *complete* reply text is pushed through `SpeechChunker` so Bulbul can
   start speaking the first sentence before later sentences are even chunked, which is real,
   measurable latency improvement over waiting for a fully-synthesized clip — but it is not the
   same as the LLM literally streaming tokens the way the diagram's box name suggests.
2. **No live end-to-end run.** `SARVAM_API_KEY`/`GEMINI_API_KEY` are unset in this sandbox, and
   there is no real browser to grant microphone access. Every claim in this document is backed by:
   `tsc --noEmit` (clean), the full unit test suite (620 tests, 34 files, all passing, entirely
   via injected fakes at every provider boundary — no network calls), and `next build` (confirms
   the new client code bundles and the `/practice/realtime` route compiles). **No test in this
   repo exercises the real Sarvam realtime STT/TTS/LLM endpoints, and none opens an actual
   microphone.** Treat this as strong structural/logical verification, not a substitute for a
   real manual run against live credentials in a real browser before shipping.
3. **Contradiction detection doesn't exist.** `DifficultyController`'s `CLARIFY_CONTRADICTION`
   rule only fires if `MemoryEngine.recordContradiction()` has already been called for the current
   topic — nothing in this codebase (before or after this wiring work) actually detects a
   contradiction between two of the candidate's answers. The rule is real and tested; the signal
   that would trigger it in practice is not implemented anywhere.
4. **Interview kickoff is out of scope.** `InterviewPipeline` assumes an opening question was
   already asked by whatever constructs it (see `initialQuestion`) — it only wires the ongoing
   turn loop, not "how does the interview start."
5. **No event replay on reconnect.** The gateway's `seq` counter lets a reconnecting client
   *detect* it missed messages; it does not replay them. A dropped connection during a long agent
   reply could mean the client never sees the associated `InterviewEvent`s or audio for that turn,
   even though the pipeline's own state (memory, history) survives the reconnect correctly.
6. **Single-process, in-memory assumptions throughout.** The gateway's session map and the
   pipeline's default `EvaluationQueue` (in-memory store) both assume one Node process — this
   matches `EvaluationQueue`'s own pre-existing, documented concurrency model, but means none of
   this is safe to run behind a load balancer across multiple instances without additional work
   (sticky sessions or a shared store).
7. **`/practice/realtime` is a protocol demonstrator, not a feature-complete practice mode.** It
   has no resume upload, scenario selection, skill-graph recording, or coaching summary screen —
   deliberately, to keep it a minimal, reviewable integration point per the task that produced it,
   not a second full product surface.

## 4. Test coverage map (what's tested vs. what can't be)

| Layer | File(s) | Coverage |
| --- | --- | --- |
| Turn orchestration + streaming TTS contract | `lib/voice/VoiceSession.ts` | Unit tested (pre-existing + this work's streaming addition) |
| Fast/background/memory wiring | `lib/voice/InterviewPipeline.ts` | 14 unit tests, all fakes |
| Gateway wire protocol + session lifecycle | `server/voice-gateway.ts` | 7 tests over a **real loopback `ws` socket**, fake STT/TTS/LLM |
| Local VAD event edges | `lib/voice-client/UtteranceGate.ts` | 5 unit tests |
| Playback sequencing | `lib/voice-client/AudioPlaybackQueue.ts` | 6 unit tests |
| Client-side wire protocol | `lib/voice-client/RealtimeVoiceClient.ts` | 11 unit tests, fake socket |
| DOM glue (`getUserMedia`/`AudioContext`/`AudioWorkletNode`) | `lib/voice-client/RealtimeAudioCapture.ts` | **None** — this project's test setup has no jsdom and no environment implements Web Audio; kept deliberately thin (composition only, no new logic) to minimize what's untested |
| AudioWorklet processor | `public/pcm-worklet-processor.js` | **None** — `AudioWorkletGlobalScope` can't run outside a real browser; kept deliberately tiny and mechanical |
| React integration component | `components/RealtimeVoiceRecorder.tsx` | **None** — no component-testing library in this project; verified only via `tsc`/`next build` |

No single test exercises the *entire* diagram end to end in one process — verification is
layered, each layer's test doubles standing in for the next layer down (exactly as
`InterviewPipeline`'s tests fake STT/TTS/LLM, and the gateway's tests fake the same three things
one level up, over a real socket). This is the same testing philosophy used everywhere else in
this codebase, not a shortcut specific to this feature — but it's worth stating plainly that
"every layer is tested" and "the whole system has been run once, live" are different claims, and
only the first one is true here.
