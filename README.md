# Proof of Synergy — a Cognee-powered Career Memory

> **Every AI interviewer forgets everything. Proof of Synergy never forgets.**

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



## 📦 Getting Started

To get a local copy up and running, follow these simple steps.

### Prerequisites

- Node.js installed on your local machine
- `npm`, `yarn`, or `pnpm`

### Installation

1. **Clone the repository:**

   ```bash
   git clone https://github.com/chemicoholic21/ProofOfSynergy.git
   ```

2. **Navigate into the project directory:**

   ```bash
   cd ProofOfSynergy
   ```

3. **Install NPM packages:**

   ```bash
   npm install
   ```

4. **Set up your `.env.local` file with the required environment variables:**

   ```env
   # Add your environment variables here
   ```

5. **Start the development server:**

   ```bash
   npm run dev
   ```

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
