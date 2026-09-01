# Voice Architecture — Current State (Baseline)

Status: **as-built documentation**, not a design proposal. This describes what the code does
today, warts included. No behavior was changed to produce this document.

Scope: the voice path used by `app/practice/page.tsx` — microphone capture → VAD/utterance
detection → STT → LLM → TTS → playback — plus the WebSocket/signaling code that exists in the
repo but is **not wired into that path** (called out explicitly in its own section below).

Primary files:

- `components/VoiceRecorder.tsx` — mic capture, MediaRecorder segmentation, in-browser VAD loop,
  browser live-captions (SpeechRecognition), auto-stop-on-silence.
- `lib/vad.ts` — `VoiceActivityDetector` and `UtteranceDetector` (RMS-energy VAD primitives).
- `lib/voice-latency.ts` — cross-boundary latency stage tracker (instrumentation only).
- `lib/tts-client.ts` — client-side `speak()`: calls `/api/tts`, plays the returned clip, falls
  back to `window.speechSynthesis`.
- `app/practice/page.tsx` — orchestrates one conversational turn: transcribe → LLM reply →
  (hands-free mode) speak the reply → re-open the mic.
- `app/api/transcribe/route.ts` — server route: Sarvam STT (Saarika).
- `app/api/voice/stream/route.ts` — a second, effectively duplicate, STT route (see "Orphaned /
  unwired code" below).
- `app/api/gemini/route.ts` — server route: LLM turn (despite the path name, Sarvam is the
  primary model; Gemini is the fallback — see "Naming note").
- `app/api/tts/route.ts` — server route: Sarvam TTS (Bulbul).
- `lib/sarvam.ts` — Sarvam HTTP client (chat, STT, TTS).
- `lib/gemini.ts` — Gemini HTTP client (chat only), via `@google/generative-ai`.
- `lib/prompts.ts` — provider selection (`generatePartnerReply`) and prompt building.
- `server/ws-server.ts` + `lib/webrtc-signal.ts` — a standalone WebSocket signaling server and
  matching browser client. Present in the repo; not part of the live pipeline (see below).
- `app/api/telemetry/voice-latency/route.ts` — receives the finished per-turn latency snapshot
  for tracing (Phoenix), does not affect the pipeline itself.

---

## 1. End-to-end flow (the path actually exercised in production use)

```
┌─────────────┐   getUserMedia    ┌──────────────────────┐
│   Browser    │──────────────────▶│  MediaStream (mic)   │
└─────────────┘                    └──────────┬───────────┘
                                               │
                     ┌─────────────────────────┼─────────────────────────┐
                     ▼                                                   ▼
        MediaRecorder (25s segments,                      AudioContext + AnalyserNode
        audio/webm, browser codec default)                (16kHz) → RMS energy per
                     │                                     animation frame → VAD +
                     │                                     UtteranceDetector (in-browser,
                     │                                     no network)
                     │                                                   │
                     │                                     auto-stop after 3s trailing
                     │                                     silence, or manual "Stop"
                     ▼                                                   │
        Blob[] (one per 25s segment) ◀──────────────────────────────────┘
                     │
                     │  fetch POST multipart/form-data
                     ▼
   ══════════════════ NETWORK BOUNDARY 1: browser → Next.js server ══════════════════
                     │
                     ▼
        POST /api/transcribe  (app/api/transcribe/route.ts)
          for each segment (ordered):
                     │
                     │  multipart/form-data (audio file + model + language_code=unknown)
                     ▼
   ══════════════════ NETWORK BOUNDARY 2: Next.js server → Sarvam API ══════════════════
                     │
                     ▼
        POST https://api.sarvam.ai/speech-to-text   (Saarika v2.5, lib/sarvam.ts:sarvamTranscribe)
                     │  JSON { transcript, language_code }
                     ▼
        segment transcripts joined with " " → { text, language, timing } returned to browser
                     │
   ══════════════════ back across boundary 1 ══════════════════
                     ▼
        app/practice/page.tsx: handleRecorded() → handleUserInput(text)
                     │
                     │  fetch POST application/json { messages, scenarioId, systemPrompt? }
                     ▼
   ══════════════════ NETWORK BOUNDARY 3: browser → Next.js server ══════════════════
                     ▼
        POST /api/gemini  (app/api/gemini/route.ts)
          lib/prompts.ts:generatePartnerReply()
            → Sarvam configured? try Sarvam chat first
                     │
                     │  JSON POST (model, messages, temperature, max_tokens, reasoning_effort)
                     ▼
   ══════ NETWORK BOUNDARY 4a: Next.js server → Sarvam API (chat, primary) ══════
        POST https://api.sarvam.ai/v1/chat/completions   (lib/sarvam.ts:sarvamChat)
                     │
            (only if Sarvam not configured, or Sarvam threw AND Gemini is configured)
                     ▼
   ══════ NETWORK BOUNDARY 4b: Next.js server → Google Generative AI API (fallback) ══════
        genAI.getGenerativeModel(...).generateContent(...)  (lib/gemini.ts:geminiChat,
        @google/generative-ai SDK — its own HTTPS call to Google's backend)
                     │
                     ▼
        { reply, model, timing } returned to browser
                     │
   ══════════════════ back across boundary 3 ══════════════════
                     ▼
        app/practice/page.tsx: message appended to conversation; heuristic coaching runs
        locally (no network — lib/coaching or similar, out of scope here)
                     │
        if hands-free ("auto-converse") mode:
                     ▼
        lib/tts-client.ts: speak(replyText)
                     │
                     │  fetch POST application/json { text, language }
                     ▼
   ══════════════════ NETWORK BOUNDARY 5: browser → Next.js server ══════════════════
                     ▼
        POST /api/tts  (app/api/tts/route.ts)
                     │
                     │  JSON POST (text, target_language_code, model=bulbul:v2, speaker, pace)
                     ▼
   ══════ NETWORK BOUNDARY 6: Next.js server → Sarvam API (TTS) ══════
        POST https://api.sarvam.ai/text-to-speech   (lib/sarvam.ts:sarvamTTS)
                     │  JSON { audios: [base64 wav] }
                     ▼
        { audio: base64, source: "sarvam", timing } returned to browser
                     │
   ══════════════════ back across boundary 5 ══════════════════
                     ▼
        new Audio(`data:audio/wav;base64,...`).play()
          success → audio_playback_start mark, plays through browser speakers
          blocked/failed (autoplay policy, network error, tts route returned audio:null)
                     ▼
        fallback: window.speechSynthesis (fully local browser TTS engine, zero network)
                     │
                     ▼
        on playback end → recorderRef.current.start() re-opens the mic for the next turn
                     ▼
        POST /api/telemetry/voice-latency  (fire-and-forget, does not gate the UX)
   ══════════════════ NETWORK BOUNDARY 7: browser → Next.js server (telemetry only) ══════════════════
```

Every "network boundary" above that leaves the Next.js server (4a/4b, 2, 6) is also where
`lib/tracing.ts` (`traceChain` / `traceTool` / `runInSpan`) attaches an OpenTelemetry span, if
`PHOENIX_COLLECTOR_ENDPOINT` is configured — see `docs/observability.md` for the existing span map.
Boundaries 1/3/5/7 are same-origin `fetch()` calls from the browser to this app's own Next.js API
routes (no CORS involved; same host/port as the page).

---

## 2. Microphone capture & segmentation (`components/VoiceRecorder.tsx`)

- `start()` calls `navigator.mediaDevices.getUserMedia({ audio: true })` — a single shared
  `MediaStream` feeds both the `MediaRecorder` (for upload) and a separate `AudioContext` (for
  VAD). No video, no constraints on sample rate/channels requested from the mic itself.
- `MediaRecorder` records in **rolling 25-second segments** (`SEGMENT_MS = 25_000`). When a
  segment's timer fires, `mr.stop()` is called; `mr.onstop` pushes the accumulated chunks as one
  `Blob` (`type: "audio/webm"`) into `segmentsRef`, and if recording is still active
  (`keepGoingRef.current`), a **new** `MediaRecorder` is immediately started on the same stream
  (`startSegment(stream)` recurses). This produces an ordered array of `audio/webm` blobs for a
  single logical answer, capped per-segment because Sarvam's STT endpoint caps a single clip at
  ~30s.
- Encoding is whatever `MediaRecorder` picks for `audio/webm` on the given browser (no explicit
  `mimeType`/bitrate passed to the `MediaRecorder` constructor) — effectively Opus-in-WebM on
  Chromium-family browsers. No resampling/downmixing is done client-side beyond what the browser's
  encoder does by default.
- Recording stops when either (a) the user taps "Stop recording" (`stop()`), or (b) the VAD
  auto-stop fires (see §3). On stop, the **last** `MediaRecorder` segment is flushed the same way,
  the mic tracks are released (`stream.getTracks().forEach(t => t.stop())`), and
  `onRecorded(blobs, durationSec, liveText, latencyMarks)` is called with everything the caller
  needs to kick off the STT request.
- A **separate, best-effort live-captions path** runs in parallel using the browser's native
  `SpeechRecognition` / `webkitSpeechRecognition` API (`startRecognition()`). This is pure UX
  (interim word-by-word text shown while the user talks) and is **not** the transcript sent
  anywhere — it is only used as a same-browser fallback if Sarvam's STT returns an empty/too-short
  transcript (see `app/practice/page.tsx:handleRecorded`). No network call is made by this
  browser API implementation detail is opaque to the app; some browsers (Chrome) do call out to
  Google's speech service under the hood for this feature, but the app itself does not manage that
  network path — Firefox has no implementation at all and the app degrades silently (no captions).
- An unused prop, `streamToWs`, exists to additionally stream raw `MediaRecorder` chunks (as
  base64 JSON messages) to `/api/voice/ws` over a `WebSocket` opened in `connectWs()`. See §5 —
  this path is not wired into any real backend route today.

## 3. Voice Activity Detection (VAD) (`lib/vad.ts`, wired up inline in `VoiceRecorder.tsx`)

- **Fully client-side, zero network round-trip.** An `AudioContext` is created at a forced 16kHz
  sample rate; a `MediaStreamAudioSourceNode` (from the mic stream) feeds an `AnalyserNode`
  (`fftSize = 512`, `smoothingTimeConstant = 0.8`).
- On every animation frame (`requestAnimationFrame` loop, so effectively ~display-refresh-rate,
  commonly 60Hz): `analyser.getFloatTimeDomainData()` pulls 512 time-domain samples, RMS energy is
  computed (`sqrt(mean(x^2))`), and that scalar is fed to **two** independent, near-duplicate state
  machines:
  - `VoiceActivityDetector.evaluate(rms)` — drives the UI "Speaking / Silence" pill
    (`isSpeaking`/`setIsSpeaking`). Instantiated in `VoiceRecorder` but its `start()`/`stop()`
    lifecycle methods (which build their own internal `AudioContext`) are actually unused there —
    only `evaluate()` is called, reusing the analyser `VoiceRecorder` itself already owns.
  - `UtteranceDetector.update(rms)` — drives the actual auto-stop logic.
- Both share the same threshold/timing constants (`VAD_THRESHOLD = 0.015`, `SPEECH_PAD_MS = 200`,
  `SILENCE_TIMEOUT_MS = 1200`) passed in from `VoiceRecorder.tsx`, which are **energy-based**, not
  a trained speech/non-speech classifier — background noise above the RMS threshold is
  indistinguishable from speech.
- State transitions:
  - Energy ≥ threshold for ≥`speechPadMs` (200ms) continuously → `isSpeaking = true`.
  - Energy < threshold for ≥`silenceTimeoutMs` (1200ms) after having spoken → `isSpeaking = false`,
    and `UtteranceDetector` additionally sets `isFinal = true` (an "utterance ended" signal;
    `onUtteranceEnd` callback exists but in the current wiring is invoked with an **empty string**
    — see `tick()` in `VoiceRecorder.tsx`, `onUtteranceEndRef.current("")` — so
    `handleUtteranceEnd` in `app/practice/page.tsx` no-ops on it (`if (!text.trim()) return;`). The
    real per-answer transcript always comes from the STT round trip, not this signal.
  - **Auto-stop-on-pause**: independently of `isFinal`, once `silenceDurationMs >=
    AUTO_STOP_SILENCE_MS` (3000ms, intentionally well above the 1200ms “is speaking” threshold so
    ordinary mid-sentence pauses don't cut the recording), `VoiceRecorder` calls its own `stop()`
    and flags `autoStopped` in the UI. This is the mechanism that ends a hands-free turn without
    the user pressing "Stop".
- The VAD also drives two of the client-side latency marks in `lib/voice-latency.ts`:
  `speech_detected` (first onset in a recording) and `speech_end` (most recent
  speaking→silence transition, committed at actual stop time so a mid-answer pause is never
  mistaken for the true end of speech).

## 4. STT (speech-to-text) flow

- Server route: `POST /api/transcribe` (`app/api/transcribe/route.ts`), Node.js runtime,
  `maxDuration = 60`s, rate-limited via `enforceRateLimit`.
- Input: `multipart/form-data` with a `sessionId` field and one-or-more `audio` file parts (one
  per 25s `MediaRecorder` segment produced client-side). Rejects (400) if no audio parts, empty
  total bytes, or 413s if total bytes exceed `MAX_AUDIO_BYTES` (default 25MB).
- For each segment, in order: `lib/sarvam.ts:sarvamTranscribe(seg, filename)` builds a `FormData`
  (`file`, `model="saarika:v2.5"`, `language_code="unknown"` — auto-detect + code-mixing) and
  POSTs to `https://api.sarvam.ai/speech-to-text` with header `api-subscription-key`. A 20s
  client-side timeout aborts the request via `AbortController`.
- Sarvam's JSON response (`{ transcript, language_code }`) is trimmed; per-segment transcripts are
  concatenated with a single space to reconstruct the full answer, and detected languages are
  deduped into a `languagesDetected` list (mapped to display labels via `LANG_LABEL`).
- Wrapped in `traceChain("transcribe", ...)` (chain span) with `sarvam.stt` as a nested `TOOL`
  span (`lib/tracing.ts`); stage timestamps `stt_start`/`stt_end` are recorded into the response's
  `timing` object for the client to merge into its `VoiceLatencyTracker`.
- Failure modes: if `fullText.length < 2` → treated as failure. In `DEMO_MODE`, returns a
  hardcoded fallback transcript instead of erroring (labelled `source: "fallback"`); otherwise
  returns 503 if `SARVAM_API_KEY` isn't set, or 502 with Sarvam's error message. **The app never
  fabricates a real answer outside `DEMO_MODE`.**
- **Duplicate/parallel route**: `app/api/voice/stream/route.ts` (`POST /api/voice/stream`)
  implements essentially the same logic (same Sarvam call, same segment-stitching, same
  `DEMO_FALLBACK`) but without the tracing/latency-timing instrumentation, and is not called from
  any current frontend code path — see §5.
- There is also `lib/sarvam.ts:sarvamStreamTranscribe()`, a function that POSTs all chunks in one
  `FormData` with a `streaming: "true"` field to the same `/speech-to-text` endpoint. It is
  exported but **not called from anywhere** in the app today — true incremental/partial-result
  streaming STT is not implemented; "streaming" here is aspirational naming on an unused helper.

## 5. Orphaned / unwired code (present in repo, not part of the live pipeline)

Documented here because tracing "every network boundary" surfaced these as boundaries that
*exist in code* but are dead ends in the actual request path:

- **`server/ws-server.ts`** — a standalone `ws` `WebSocketServer` listening on
  `process.env.VOICE_WS_PORT ?? 3001`. It is a **separate Node process**, not part of the Next.js
  server (no script in `package.json` starts it, and it is not imported by any Next.js route or
  `instrumentation.ts`). It implements a small signaling protocol (`register`, `audio-chunk`,
  `end-of-turn`, `session-start`, `ice-candidate`, `offer`/`answer`) and a fake "transcript" — on
  `end-of-turn` it does `session.audioChunks.map(c => c.toString("utf-8")).join("")`, i.e. it
  decodes raw binary audio bytes as UTF-8 text, which is not a real transcription and would
  produce garbage/mojibake if ever exercised.
- **`components/VoiceRecorder.tsx`'s `connectWs()`/`sendAudioChunk()`** — opens a `WebSocket` to
  `${proto}//${host}/api/voice/ws` when the (unused-by-callers) `streamToWs` prop is true. There is
  **no** `app/api/voice/ws` route in `app/api/` — Next.js has no built-in WebSocket route support
  in the App Router, and no custom server wires one up here — so in the current codebase this
  `new WebSocket(...)` call would fail to connect (connection refused / 404 upgrade) if `streamToWs`
  were ever set to `true` anywhere. Grepping the app, no caller currently passes `streamToWs={true}`
  wired to a live value — `app/practice/page.tsx` passes it but resolves to a value that does not
  enable it in the interview/practice flow exercised today. Net effect: this is inert client code
  that reaches for a server endpoint that isn't served.
- **`lib/webrtc-signal.ts`** — a full `WebrtcSignalClient` (WebSocket signaling with reconnect
  backoff) plus WebRTC helper functions (`createPeerConnection`, `createOffer`, `handleOffer`,
  `handleAnswer`, `collectIceCandidates`, using `iceTransportPolicy: "relay"`). Nothing in
  `app/` or `components/` imports this module. There is no TURN/STUN-backed peer-to-peer audio
  path in the live product; all audio transport today is HTTP request/response (record → upload
  whole segment → transcribe), not real-time WebRTC streaming.
- Net implication: despite naming that suggests a real-time/streaming voice architecture
  (`ws-server`, `webrtc-signal`, `sarvamStreamTranscribe`, `/api/voice/stream`), the **actual**
  live pipeline is turn-based batch HTTP: record a full answer client-side (in ≤25s chunks) →
  upload the whole thing after the user stops talking → single request/response STT → single
  request/response LLM → single request/response TTS → play back the full clip. There is no
  chunk-level incremental transcription or streaming token/audio delivery anywhere in the live
  path today.

## 6. LLM flow

- Server route: `POST /api/gemini` (`app/api/gemini/route.ts`). **Naming note**: despite the path,
  Gemini is not the primary model — `lib/prompts.ts:generatePartnerReply()` tries **Sarvam chat
  first** ("the app is Sarvam-native") and only falls back to Gemini if Sarvam is unconfigured, or
  Sarvam throws and Gemini *is* configured. If neither is configured, the route 503s
  (`service_unconfigured`).
- Request body (validated via `GeminiChatBody` zod schema): `{ messages: ConversationMessage[],
  scenarioId, systemPrompt? }`. Server resolves the scenario's system prompt
  (`getScenario(scenarioId)` or the passed-in `systemPrompt`, used for the resume-tailored
  interview mode), builds the user prompt from conversation history
  (`scenarioUserPrompt`), and finds the last user message.
- Sarvam path (`lib/sarvam.ts:sarvamChat`): POST
  `https://api.sarvam.ai/v1/chat/completions` with model `sarvam-105b` (or `SARVAM_CHAT_MODEL`),
  `temperature`, `max_tokens` (clamped to the tier ceiling, default 4096),
  `reasoning_effort` (defaults to disabled/`null` — reasoning models otherwise burn the whole
  token budget "thinking" and return empty `content`). Bounded by a small in-process FIFO
  semaphore (`SARVAM_MAX_CONCURRENCY`, default 4) so bursts don't exceed the account's rate limit.
  One automatic retry on empty-content/`finish_reason=length` with an escalated token budget.
  20–45s fetch timeout via the same `AbortController` pattern as STT/TTS.
- Gemini path (`lib/gemini.ts:geminiChat`): uses the `@google/generative-ai` SDK
  (`GoogleGenerativeAI(...).getGenerativeModel(...).generateContent(...)`), which makes its own
  HTTPS call to Google's backend (not visible as a raw `fetch` in this codebase — it's inside the
  SDK). Tries `GEMINI_MODEL` (default `gemini-2.5-flash`) then a hardcoded fallback list
  (`gemini-2.0-flash`, `gemini-1.5-flash`) if the configured model 404s/is deprecated; the first
  model that answers is cached in-process (`workingModel`) so dead model ids aren't retried every
  call. A small in-process concurrency gate (max 4 concurrent) is also applied here, separate from
  Sarvam's.
- The call is **not streamed** in either provider path — the full reply text comes back in one
  response. Consequently `llm_first_token` and `llm_end` timestamps are always identical in
  `lib/voice-latency.ts` (there is no earlier "first token" moment to observe yet).
- Response: `{ reply, model, scenarioId, timing }`; `timing` carries `llm_start`/`llm_first_token`/
  `llm_end` for the client's latency tracker. Wrapped in a `conversation.turn` chain span, with
  `sarvam.chat` or `gemini.chat` as the nested LLM span depending on which provider actually
  answered.
- Failure: 502 `chat_failed` with the underlying error message if both providers fail (or the
  configured one throws and no fallback is configured). The client (`app/practice/page.tsx:
  partnerReply`) additionally treats *any* fetch/parse failure as "no reply" and falls back to a
  fully local, canned `localPartnerReply()` heuristic so the conversation UI never hard-stops.

## 7. TTS (text-to-speech) flow

- Only exercised in **hands-free ("auto-converse") interview mode** — `app/practice/page.tsx`
  calls `speak(messages[idx].content, undefined, turnLatency)` from `lib/tts-client.ts` whenever a
  new assistant message appears while `autoConverse` is on.
- `speak()` (client): marks `tts_start`, then `fetch POST /api/tts` with `{ text, language }`
  (language defaults to `"en-IN"` when not supplied).
- Server route `POST /api/tts` (`app/api/tts/route.ts`): validates body (`TtsBody` zod schema),
  rate-limited (60 req/min), calls `lib/sarvam.ts:sarvamTTS(text, language)`.
- `sarvamTTS`: clamps input to 1450 chars at a sentence/word boundary (`clampSpeech` —
  Bulbul v2 caps input at 1500 chars), POSTs JSON `{ text, target_language_code, model: "bulbul:v2"
  (or `SARVAM_TTS_MODEL`), speaker: "anushka" (or `SARVAM_TTS_SPEAKER`), pace: 1.0 }` to
  `https://api.sarvam.ai/text-to-speech`. Response is `{ audios: [base64 wav] }` — **the whole
  clip in one response, not streamed** — so `tts_first_audio` and `tts_end` are always identical
  (same caveat as the LLM leg).
- On success: server returns `{ audio: <base64 wav>, source: "sarvam", timing }`. On any failure
  (including `SARVAM_API_KEY` unset), the route does **not** error the request — it returns `200`
  with `{ audio: null, source: "fallback", reason }`, deliberately, because "TTS is a non-critical
  convenience."
- Client behavior on the response:
  - `data.audio` present → builds `new Audio("data:audio/wav;base64,...")`, calls `.play()`.
    - Play succeeds → marks `audio_playback_start`, plays through the browser's default output
      device.
    - Play throws (e.g. autoplay blocked without a user gesture) → falls back to
      `browserSpeak()` (below).
  - `data.audio` is `null`, or the `/api/tts` fetch itself throws → falls straight to
    `browserSpeak()`.
- `browserSpeak()` (pure client-side fallback, **zero network**): waits for
  `speechSynthesis.getVoices()` to populate (handles Chrome's async voice list, with a 300ms max
  wait for browsers that never fire `voiceschanged`), picks the best available voice for the
  requested language via a scoring heuristic (`pickVoice` — prefers exact language match, then
  base-language match, then a name-based "neural/cloud" quality hint over "compact/espeak"
  robotic-sounding voices), and speaks via `SpeechSynthesisUtterance` (`rate: 0.97`, `pitch: 1.0`).
- `SpeechController.stop()` cancels either playback path (`audio.pause()` and/or
  `speechSynthesis.cancel()`) and resolves the pending `done` promise immediately so callers don't
  hang waiting for a stopped clip.
- After playback finishes (either engine), `app/practice/page.tsx` re-opens the mic
  (`recorderRef.current.start()`) for the next turn, or ends the session if this was flagged as
  the interviewer's closing line.

## 8. WebSocket connections — inventory

| Where | Direction | Protocol | Wired into live pipeline? |
| --- | --- | --- | --- |
| `components/VoiceRecorder.tsx:connectWs()` → `/api/voice/ws` | browser → Next.js | `ws:`/`wss:` on same host | **No** — no matching Next.js route exists; only reachable if `streamToWs` prop is set true, which no current caller does in the live flow. |
| `server/ws-server.ts` (`WebSocketServer` on `VOICE_WS_PORT`, default 3001) | any client → standalone Node process | raw `ws` | **No** — separate process, no npm script starts it, nothing in the Next.js app proxies to it. |
| `lib/webrtc-signal.ts:WebrtcSignalClient` | browser → arbitrary `url` (caller-supplied) | `ws:`/`wss:` + WebRTC (SRTP over UDP once signaled) | **No** — unimported anywhere in `app/`/`components/`. |

There are **no live WebSocket connections** in the interview/practice flow as currently shipped.
All real network calls in that flow are plain HTTP request/response (`fetch` to same-origin
Next.js API routes, which in turn make server-side HTTPS calls to Sarvam and, conditionally,
Google's Generative AI backend).

## 9. Network boundary summary

| # | From | To | Protocol | Payload | Auth |
| --- | --- | --- | --- | --- | --- |
| 1 | Browser | Next.js `/api/transcribe` (or unused `/api/voice/stream`) | HTTPS POST, same-origin | `multipart/form-data`: audio/webm segment(s) | none (session-less; rate-limited by IP/key) |
| 2 | Next.js server | Sarvam `POST /speech-to-text` | HTTPS POST | `multipart/form-data`: audio file, model, language_code | `api-subscription-key` header (`SARVAM_API_KEY`) |
| 3 | Browser | Next.js `/api/gemini` | HTTPS POST, same-origin | JSON: messages, scenarioId, systemPrompt? | none |
| 4a | Next.js server | Sarvam `POST /v1/chat/completions` | HTTPS POST | JSON: model, messages, temperature, max_tokens, reasoning_effort | `api-subscription-key` header |
| 4b | Next.js server | Google Generative AI (via `@google/generative-ai` SDK) | HTTPS (SDK-managed) | prompt + generation config | API key via SDK (`GEMINI_API_KEY`) |
| 5 | Browser | Next.js `/api/tts` | HTTPS POST, same-origin | JSON: text, language | none |
| 6 | Next.js server | Sarvam `POST /text-to-speech` | HTTPS POST | JSON: text, target_language_code, model, speaker, pace | `api-subscription-key` header |
| 7 | Browser | Next.js `/api/telemetry/voice-latency` | HTTPS POST, same-origin | JSON: turnId, per-stage timestamps, derived metrics | none; fire-and-forget |
| — | Next.js server (any of the above) | Arize Phoenix (optional) | OTLP/HTTP or OTLP/proto | span data | `PHOENIX_API_KEY` (Cloud) or none (local) |
| (unwired) | Browser | `/api/voice/ws` | WebSocket | base64 audio chunks | none — endpoint does not exist |
| (unwired) | any | `server/ws-server.ts` standalone process | WebSocket | signaling/audio-chunk JSON | none |

---

## 10. Notable behaviors worth knowing before changing anything

These are observations, not judgments — flagged because they affect how a refactor should reason
about the current system's actual behavior:

1. STT, LLM, and TTS are all **non-streaming** today: each is a single request → single full
   response. The latency model in `lib/voice-latency.ts` already anticipates streaming (separate
   `*_start`/`*_first_token`/`*_first_audio`/`*_end` marks) but `llm_first_token == llm_end` and
   `tts_first_audio == tts_end` always hold currently.
2. VAD is energy-threshold based (RMS), not a trained speech/silence classifier — it cannot
   distinguish speech from steady loud background noise, and is tuned by three constants
   (`VAD_THRESHOLD`, `SPEECH_PAD_MS`, `SILENCE_TIMEOUT_MS`) duplicated between
   `VoiceActivityDetector` and `UtteranceDetector`.
3. Sarvam is the primary provider for both chat and voice; Gemini is a chat-only fallback. The
   `/api/gemini` route name predates or otherwise doesn't reflect this.
4. Two STT entry points exist server-side (`/api/transcribe`, `/api/voice/stream`) with duplicated
   logic; only `/api/transcribe` is called by the live UI.
5. WebSocket/WebRTC signaling code exists in three places (`server/ws-server.ts`,
   `lib/webrtc-signal.ts`, `VoiceRecorder`'s `connectWs`) but none of it is connected end-to-end;
   the live app never opens a WebSocket.
6. All cross-origin (to Sarvam/Google) calls happen **server-side only**; the browser never holds
   or sends a provider API key. Browser↔server calls are same-origin.
7. TTS failure is intentionally silent to the user (falls back to browser speech synthesis, never
   surfaces an error); STT failure is not (surfaced as an error the user can read, with a suggestion
   to type instead), reflecting that a wrong/missing question read-aloud is recoverable but a lost
   answer is not.
