# Proof of Synergy — a Cognee-powered Career Memory

> **Every AI interviewer forgets everything. Proof of Synergy never forgets.**

<p>
  <a href="https://www.cognee.ai/"><img alt="Powered by Cognee" src="https://img.shields.io/badge/memory-Cognee-8B5CF6"></a>
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-14-black">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178C6">
  <img alt="tests" src="https://img.shields.io/badge/tests-65%20passing-brightgreen">
</p>

### 🏆 Built for *The Hangover Part AI: Where's My Context?* — WeMakeDevs × Cognee (Jun 29 – Jul 5, 2026)

The hackathon attacks **"AI Amnesia"**: standard LLM agents are structurally stateless — they forget
your preferences, overflow their context window, and reset every session. Proof of Synergy answers
that head-on. It uses **Cognee's hybrid graph-vector memory** to give an AI interviewer a *lifelong*
memory of a candidate's career, so context is retained across **infinite** interview sessions instead
of starting from "tell me about yourself" every time.

**Track:** _Best Use of Cognee Cloud_ (Cognee Cloud, access code `COGNEE-35`). The same build also runs
against **self-hosted open-source Cognee** by changing one env var — see [Connect Cognee](#-connect-cognee-pick-your-track).

---

LinkedIn shows your network. GitHub shows your code. Proof of Synergy proves your communication —
and, more importantly, it **remembers**. It has evolved from a single-session AI interviewer into a
persistent **AI Interview Twin**: every interview, answer, weakness, project and communication
pattern is written into a lifelong **Career Knowledge Graph** powered by **[Cognee](https://www.cognee.ai/)**
(structural memory, not another vector DB). Future interviews are personalized from that memory,
every recommendation is backed by traceable evidence, and skills decay over time until you revisit
them — just like real learning.

Cognee is the brain. Remove it and the product stops being intelligent.

## Why Cognee is central

Cognee stores **relationships, not chunks**. The whole app is built around its memory lifecycle:

| Lifecycle | Where it happens | What it does |
| --- | --- | --- |
| `remember()` | after resume upload & every interview | writes structured nodes + relationships (candidate → resume → CLAIMS → skill → TESTS → concept → EVIDENCE) — never flat JSON |
| `recall()`   | **before** generating any interview | the Career Reasoner: which concepts are weak, forgotten (retention-decayed), never verified, already mastered, or relevant to an upcoming company — this steers question generation |
| `improve()`  | after every interview | relates concepts, raises node weights, recomputes confidence + retention, emits evidence-backed recommendations, learning missions and improvement milestones |
| `forget()`   | candidate-controlled | prunes an interview / resume / company / project while preserving graph consistency and recomputing scores |

The memory layer lives in [`lib/memory/`](lib/memory) behind one abstraction; nothing in the UI
calls Cognee directly. When `COGNEE_API_URL`/`COGNEE_API_KEY` are configured it mirrors into a real
Cognee backend; otherwise a deterministic local graph engine gives identical semantics so the demo
runs with zero credentials. See [docs/cognee-career-memory-architecture.md](docs/cognee-career-memory-architecture.md).

## The 5-minute demo

Open **`/dashboard`** and click **Load demo** (or run one interview from the home page):

1. A six-month, three-interview career history seeds instantly.
2. **Knowledge Graph** — click any node to see why it exists, its confidence/retention and connections. Weak nodes glow.
3. **Reality Gap** — resume claims vs demonstrated evidence, framed as coaching (Highly Demonstrated / Developing / Needs Evidence).
4. **Memory Replay** — watch Kubernetes grow 30% → 58% → 84% across interviews.
5. **Communication trends** — filler words drop, confidence rises, tracked as persistent Interview DNA.
6. **Learning Roadmap** — every weakness becomes an evidence-backed mission with spaced-repetition review dates.
7. Start a new interview and the **recall()** banner shows it being personalized from memory.

https://proof-of-synergy.vercel.app/

## Reality

<img width="769" height="574" alt="image" src="https://github.com/user-attachments/assets/2d3cabf6-c953-4516-aa23-e86d074b7dfc" />

## Demo Video

Part 1  : https://www.loom.com/share/2bfb990f8b9f4dd8aea5122f678b4e06
Part 2 : https://www.loom.com/share/48f0ebcbbcfa42d689c8a4af2697f9ef


## 🚀 Overview



**Live Link:** [https://proof-of-synergy.vercel.app/](https://proof-of-synergy.vercel.app/)

<img width="1697" height="927" alt="image" src="https://github.com/user-attachments/assets/a9d0162f-2a81-410b-8c1e-0e13d524347e" />


<img width="1919" height="992" alt="Screenshot 2026-06-07 163953" src="https://github.com/user-attachments/assets/b7eb759f-3bfb-4ee7-b2f0-56b8fc4c02f4" />





## 🛠️ Features

- **Career Knowledge Graph:** a living graph of skills, concepts, projects, companies, interviews and communication patterns — the centrepiece, powered by Cognee.
- **Adaptive interviews:** questions are generated from `recall()`, targeting weak / forgotten / never-verified topics and biasing toward an upcoming company. No two interviews are the same.
- **Reality Gap:** resume claims cross-checked against demonstrated evidence, always framed as coaching.
- **Evidence engine:** every score and recommendation is traceable ("Improve Kafka because: scored 40%, no project, last discussed 96 days ago").
- **Learning loop:** each weakness becomes a mission (read → practice → quiz → re-interview → improvement recorded) with spaced-repetition scheduling.
- **Interview DNA + Memory Replay:** persistent communication metrics over time, and replay of every answer to a topic across months.
- **Persistent + portable:** memory survives across sessions; verified reputation is minted on Monad as a soulbound credential.



## 💻 Tech Stack

| Layer            | Technology                          |
|------------------|-------------------------------------|
| Structural memory| **Cognee** (Career Knowledge Graph) |
| Frontend         | React / Next.js / TypeScript        |
| Voice / LLM      | Sarvam AI (STT / TTS / chat)        |
| Chain            | Monad (soulbound skill credential)  |
| Styling          | Tailwind CSS                        |
| Deployment       | Vercel                              |



## 🧠 The memory service layer

Everything routes through one abstraction ([`lib/memory/`](lib/memory)) so Cognee is the app's brain,
not a scattered dependency. The UI never calls Cognee directly.

```
Frontend ─► /api/* ─► lib/memory (orchestrator)
                          ├─ remember()  ─► Career Knowledge Graph ──► Cognee (add + cognify)
                          ├─ recall()   ◄── graph traversal + Cognee search  ─► steers the LLM
                          ├─ improve()   ─► relate concepts · node weights · retention · roadmap
                          └─ forget()    ─► prune + keep graph consistent
```

```
lib/memory/
  cognee/client.ts     the ONLY seam to Cognee (add / cognify / search / forget)
  graph/               canonical node+edge model · per-candidate store · consistency ops
  remember.ts recall.ts improve.ts forget.ts   the lifecycle
  evidence.ts recommendations.ts learning.ts   evidence + roadmap engines
  concepts.ts          concept ontology + spaced-repetition retention decay
  interview-memory.ts  semantic extraction + Interview DNA (voice/comm metrics)
  derive.ts            dashboard read-models (reality gap, timeline, trends, replay, graph view)
  orchestrator.ts      owns the interview-complete pipeline
```

### Memory API

| Endpoint | Lifecycle | Purpose |
| --- | --- | --- |
| `POST /api/memory/remember` | `remember()` | ingest a resume version or a completed interview |
| `POST /api/memory/recall`   | `recall()`   | the Career Reasoner state (weak/forgotten/unverified/…) |
| `GET  /api/memory/graph`    | derived      | full dashboard payload: graph, reality gap, evidence, trends, roadmap |
| `POST /api/memory/replay`   | derived      | every answer to a topic across all interviews |
| `POST /api/memory/forget`   | `forget()`   | prune an interview / resume / company / project / all |
| `POST /api/memory/seed`     | demo         | one-click 6-month, 3-interview history |
| `POST /api/generate-questions` | `recall()`-driven | adaptive questions when a `candidateId` is supplied |

## 🔌 Connect Cognee (pick your track)

The app works with **zero credentials** (a deterministic local graph engine mirrors the exact
`remember/recall/improve/forget` semantics) so you can try it immediately — but to compete, point it
at a real Cognee backend:

**Best Use of Cognee Cloud** (iPhone 17 track) — grab dev-tier credits with access code `COGNEE-35`:

```env
COGNEE_API_URL=https://api.cognee.ai   # your Cognee Cloud base URL
COGNEE_API_KEY=sk-...                  # from Cognee Cloud (code COGNEE-35)
COGNEE_DATASET=career-memory
```

**Best Use of Open Source** (MacBook track) — run self-hosted Cognee and point at it:

```bash
pip install cognee && python -m cognee.api.server   # or the official docker image
```
```env
COGNEE_API_URL=http://localhost:8000
COGNEE_API_KEY=local
```

When these are set, every `remember()` is mirrored into Cognee (`add` + `cognify`) and `recall()` is
enriched by Cognee's semantic + graph `search`. Remove Cognee and the product loses adaptivity,
evidence, reality gap, retention decay and the roadmap — i.e. it stops being intelligent.

> The Cognee client (`lib/memory/cognee/client.ts`) is a REST scaffold. Verify the exact
> endpoints/payloads against your Cognee version's API before the live demo.

## 📦 Getting Started

### Prerequisites
- Node.js ≥ 18.18 and `npm`

### Run it

```bash
git clone https://github.com/chemicoholic21/ProofOfSynergy.git
cd ProofOfSynergy
npm install
cp .env.local.example .env.local     # optional: add Cognee + Sarvam + Monad keys
npm run dev                          # http://localhost:3000
```

Then open **http://localhost:3000/dashboard** and click **Load demo** for the full memory story.
Everything degrades gracefully: without Sarvam/Monad/Cognee keys it runs in clearly-labelled local
mode. Useful scripts: `npm run check` (typecheck + lint + test), `npm test` (65 tests), `npm run build`.

---

## 🤝 Contributing

Contributions are what make the open-source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

---

## 📝 License

Distributed under the MIT License. See [`LICENSE`](LICENSE) for more information.

---

## 📫 Contact

**Taniya Souza**

- 🔗 Repository: [github.com/chemicoholic21/ProofOfSynergy](https://github.com/chemicoholic21/ProofOfSynergy/)
- 🌐 Live Application: [proof-of-synergy.vercel.app](https://proof-of-synergy.vercel.app/)
