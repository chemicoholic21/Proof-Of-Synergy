# Observability: OpenTelemetry → Arize Phoenix

End-to-end traces of an interview — the opening question, every conversation turn, speech-to-text,
text-to-speech, and the coaching summary — rendered as **LLM / chain / tool** spans in
[Arize Phoenix](https://phoenix.arize.com/). Tracing is **off by default** and **free** to run.
With `PHOENIX_COLLECTOR_ENDPOINT` unset, the app behaves exactly as before.

## What you get

Each request becomes a `CHAIN` span with the model calls nested underneath, following the
[OpenInference](https://github.com/Arize-ai/openinference) semantic conventions Phoenix understands:

| Span | Kind | Emitted from |
| --- | --- | --- |
| `interview.prepare` | CHAIN | `POST /api/interview/prepare` (builds context + opening question) |
| `conversation.turn` | CHAIN | `POST /api/gemini` (one interview/practice turn) |
| `coaching.summary` | CHAIN | `POST /api/coaching/summary` |
| `transcribe` | CHAIN | `POST /api/transcribe` |
| `tts` | CHAIN | `POST /api/tts` |
| `sarvam.chat` | LLM | Sarvam chat completion (model, prompt, response) |
| `gemini.chat` | LLM | Gemini chat completion (resolved model, prompt, response) |
| `sarvam.stt` | TOOL | Saarika speech-to-text |
| `sarvam.tts` | TOOL | Bulbul text-to-speech |

LLM spans carry the provider, model, input/output messages, and invocation parameters
(temperature, max tokens). Prompt/response text is truncated to 12k chars per attribute.

## Option A — self-host Phoenix locally (recommended, 100% free)

Phoenix is open source. Run it in one command (needs Docker):

```bash
docker run -p 6006:6006 -p 4317:4317 arizephoenix/phoenix:latest
```

- UI: <http://localhost:6006>
- OTLP/HTTP ingest: `http://localhost:6006/v1/traces` (what this app uses)

No Docker? Install with pip instead:

```bash
pip install arize-phoenix
phoenix serve            # serves the UI + collector on :6006
```

Then in `.env.local`:

```
PHOENIX_COLLECTOR_ENDPOINT=http://localhost:6006
# PHOENIX_PROJECT_NAME=proof-of-synergy   # optional; groups traces under this name
```

Restart `npm run dev`, run an interview, and watch traces stream into the Phoenix UI.

## Option B — Phoenix Cloud (free tier)

Sign up at <https://app.phoenix.arize.com>, create a Space, and grab an API key.

```
PHOENIX_COLLECTOR_ENDPOINT=https://app.phoenix.arize.com
PHOENIX_API_KEY=your-phoenix-api-key
# PHOENIX_PROJECT_NAME=proof-of-synergy
```

## How it's wired

- `instrumentation.ts` — Next.js [instrumentation hook](https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation); runs once at server startup on the Node runtime and calls `initTracing()`.
- `lib/otel-setup.ts` — builds a `NodeTracerProvider` with an OTLP/proto exporter aimed at Phoenix. No-op when `PHOENIX_COLLECTOR_ENDPOINT` is unset; never throws.
- `lib/tracing.ts` — small helpers (`traceChain`, `traceLLM`, `traceTool`, `runInSpan`) that set OpenInference attributes. Safe to call whether or not tracing is enabled (the OTel API returns non-recording spans when no provider is registered).
- Instrumentation lives in the LLM/voice clients (`lib/gemini.ts`, `lib/sarvam.ts`) and the interview API routes.

## Verifying without any API keys

Even with no `SARVAM_API_KEY` / `GEMINI_API_KEY`, the chain spans still export (the routes fall
back to heuristics). Point `PHOENIX_COLLECTOR_ENDPOINT` at a running Phoenix, hit
`POST /api/coaching/summary`, and confirm a `coaching.summary` trace appears.
```
