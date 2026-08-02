# Proof of Synergy

An AI communication gym. Practice real conversations by voice, get live coaching, and build a skill graph that persists across sessions. Includes a resume-based technical interview mode.

## Stack

Next.js 14 (App Router), React 18, TypeScript, Tailwind. Gemini is the live conversation partner; Sarvam handles voice (speech-to-text, text-to-speech) and coaching summaries. Cognee is an optional semantic layer for the skill graph. Everything degrades gracefully: with no keys the app runs on a local conversation partner, heuristic coaching, and the built-in skill-graph engine.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
```

Other scripts: `npm run build`, `npm start`, `npm test`, `npm run typecheck`.

## Config

Copy `.env.local.example` to `.env.local` and add your keys. Everything is optional; the app degrades gracefully without keys.

```
GEMINI_API_KEY=      # live conversation partner (dialogue, follow-ups, pushback)
SARVAM_API_KEY=      # voice: STT, TTS, resume OCR, and coaching summaries
COGNEE_API_URL=      # optional skill-graph semantic layer
COGNEE_API_KEY=
DEMO_MODE=           # true swaps in labelled sample data when a service is down; never in prod
```

See `.env.local.example` for optional model/voice overrides and defaults.

## Features

- Voice practice with live transcription and auto-stop on pause.
- Technical interview: upload a resume (PDF, Word, or scan via OCR) plus an optional job description; questions are tailored to it. Hands-free (reads each question, opens the mic) and auto-ends after about 15 to 20 minutes.
- Skill graph: technologies actually discussed become skill nodes, grouped by category. Skills are credited only from what the candidate said.
- Session summary with metrics and coaching.

## Layout

- `app/` pages and API routes
- `components/` UI
- `lib/` core logic (skill graph, prompts, Sarvam/Gemini clients, resume parsing)
- `server/` WebSocket signaling server for voice sessions
