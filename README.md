# Proof of Synergy

An AI communication gym. Practice real conversations by voice, get live coaching, and build a skill graph that persists across sessions. Includes a resume-based technical interview mode.

## Stack

Next.js 14 (App Router), React 18, TypeScript, Tailwind. Sarvam for speech-to-text, text-to-speech, and chat (Gemini optional). Cognee optional for the skill graph.

## Run

```bash
npm install
npm run dev        # http://localhost:3000
```

Other scripts: `npm run build`, `npm start`, `npm test`, `npm run typecheck`.

## Config

Copy your keys into `.env.local`. Everything is optional; the app degrades gracefully without keys.

```
SARVAM_API_KEY=      # STT, TTS, chat, resume OCR
GEMINI_API_KEY=      # optional chat fallback
COGNEE_API_URL=      # optional skill-graph semantic layer
COGNEE_API_KEY=
```

## Features

- Voice practice with live transcription and auto-stop on pause.
- Technical interview: upload a resume (PDF, Word, or scan via OCR) plus an optional job description; questions are tailored to it. Hands-free (reads each question, opens the mic) and auto-ends after about 15 to 20 minutes.
- Skill graph: technologies actually discussed become skill nodes, grouped by category. Skills are credited only from what the candidate said.
- Session summary with metrics and coaching.

## Layout

- `app/` pages and API routes
- `components/` UI
- `lib/` core logic (skill graph, prompts, Sarvam/Gemini clients, resume parsing)
