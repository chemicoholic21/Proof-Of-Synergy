# Proof of Synergy — the AI Communication Gym

> You don't become a better communicator by reading feedback after the fact.
> You get better the way athletes do: **practice, coaching in the moment, and another rep.**

<p>
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-14-black">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6">
  <a href="https://www.cognee.ai/"><img alt="Skill graph by Cognee" src="https://img.shields.io/badge/skill%20graph-Cognee-8B5CF6"></a>
  <a href="https://www.sarvam.ai/"><img alt="Voice by Sarvam" src="https://img.shields.io/badge/voice-Sarvam%20AI-F97316"></a>
</p>

Proof of Synergy is a gym for high-stakes conversations. Pick a scenario — a technical deep dive,
a startup pitch, a design review, a public talk, a leadership conversation, a thesis defense —
and rehearse it out loud with a realistic AI partner. A private coach listens alongside you and
nudges you in the moment; every session you complete grows a persistent **Skill Knowledge Graph**
that shows exactly how your communication is developing over time.

## How it works

| Role | Powered by | What it does |
| --- | --- | --- |
| **Conversation partner** | **Gemini** | Drives the live conversation: natural dialogue, follow-up questions, pushback, tone adaptation. Never scripted. |
| **Private coach** | **Gemma** | Watches each response for filler words, hesitation, rambling, weak structure, confidence drops and repetition — and coaches in real time. Heuristics run without any API; coaching state stays with the learner. |
| **Skill memory** | **Cognee** | Every completed session updates your Skill Knowledge Graph: skills gain confidence, weaknesses surface, growth is replayable session by session. |
| **Voice** | **Sarvam AI** | Saarika speech-to-text (multilingual, code-mixing across Indian languages) and Bulbul text-to-speech make the whole session feel like a real spoken conversation. |

## The experience

```
Home ─► Choose a practice scenario ─► Live conversation (speak or type)
                                            │
                                   Gemma coaches in real time
                                            │
                              Session summary (warm, specific)
                                            │
                          Skill Knowledge Graph grows and remembers
```

The graph is the centerpiece: a radial visualization where **you** sit at the center, the skills
you've practised orbit you (weak ones pulse ochre, strong ones glow sage), and every session that
earned them connects back. Click any node to see why it exists; click **replay** to watch one
skill's confidence climb across weeks of practice.

## Architecture

Every module has a single responsibility; nothing talks to an external service except through its
dedicated client.

```
app/
  page.tsx                      home
  practice/                     scenario picker -> live conversation -> summary
  knowledge-graph/              the Skill Knowledge Graph experience
  api/
    gemini/                     conversation turns (Gemini)
    gemma/                      real-time coaching analysis (Gemma)
    coaching/summary            end-of-session coaching summary
    coaching/metrics            communication metrics from a transcript (pure, no LLM)
    transcribe/  tts/           Sarvam voice (Saarika STT, Bulbul TTS)
    skill-graph/                the memory lifecycle: remember / recall / replay / forget / seed
    health/                     live dependency probes (no silent fallbacks in a demo)

components/
  VoiceRecorder.tsx             segmented mic capture (<=25s clips for real-time STT)
  ScenarioPlayer.tsx            reads partner lines aloud (Bulbul, browser fallback)
  knowledge-graph/              GraphCanvas (SVG radial graph) + SkillGraphExplorer

lib/
  gemini.ts                     Gemini client (conversation partner)
  gemma.ts                      Gemma coaching agent (heuristics + optional LLM lift)
  sarvam.ts                     Sarvam client (chat / STT / TTS / JSON extraction)
  cognee.ts                     Cognee client (add / cognify / search / forget)
  skill-graph.ts                the Skill Knowledge Graph: lifecycle + projections
  scenarios.ts                  the practice scenario catalogue
  communication-metrics.ts      filler/hedge/confidence analysis (pure functions)
  learner.ts                    client-side identity + browser-held graph copy
  env.ts http.ts logger.ts rateLimit.ts schemas.ts prompts.ts types.ts
```

### The memory lifecycle

The skill graph follows a strict lifecycle, with Cognee as the semantic layer:

- **remember()** — `POST /api/skill-graph/remember` folds a completed session into the graph and
  mirrors *normalized skill statements* (never raw transcripts) into a per-learner Cognee dataset.
- **recall()** — `POST /api/skill-graph/recall` returns strong / weak / fading skills, and when
  Cognee is configured, its graph-grounded answer to "what should I practice next?".
- **replay()** — `POST /api/skill-graph/replay` shows one skill's growth across every session.
- **forget()** — `POST /api/skill-graph/forget` deletes a skill, a session, or everything —
  locally *and* in Cognee. Privacy is a feature, not a setting.

The browser holds the durable copy of the graph (localStorage) and sends it with each request, so
memory survives serverless deployments where instances share no disk.

## Getting started

Requirements: Node.js ≥ 18.18.

```bash
npm install
cp .env.local.example .env.local   # optional: add Gemini / Sarvam / Cognee keys
npm run dev                        # http://localhost:3000
```

The app degrades gracefully with zero credentials: the conversation uses a deterministic local
partner, coaching runs on heuristics, and the skill graph runs on the local engine. Add keys to
light up each integration:

```env
GEMINI_API_KEY=...      # realistic conversation partner
SARVAM_API_KEY=...      # speech-to-text + text-to-speech (Indian languages + English)
COGNEE_API_URL=...      # skill graph semantic layer (Cognee Cloud or self-hosted)
COGNEE_API_KEY=...
```

`GET /api/health` reports whether each dependency is configured **and reachable**, so a silent
fallback can never masquerade as a working integration during a demo.

Useful scripts: `npm run check` (typecheck + tests), `npm test`, `npm run build`.

### Two-minute demo

1. Open **/knowledge-graph** and click **Load a demo history** — three sessions over three weeks
   seed instantly with a visible growth arc (52% → 64% → 71% confidence).
2. Explore the graph: click nodes, replay "persuasion", check the Growth tab.
3. Go to **/practice**, pick a scenario, and speak. Watch Gemma coach you mid-conversation.
4. End the session — the summary appears and the graph grows by one more rep.

## Contributing & license

See [CONTRIBUTING.md](./CONTRIBUTING.md). Distributed under the MIT License — see
[LICENSE](./LICENSE).
