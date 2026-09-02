/**
 * Benchmark cases for the ten conditions this suite covers. See `./README.md` for why
 * `sttHypothesis` is hand-authored to be *representative* of each condition's typical STT failure
 * mode (dropped words under noise, code-mixed script under Hinglish, clipped endings under
 * interruption, and so on) rather than the output of a real STT call against a real recording —
 * this environment has no audio corpus or live API credentials to produce one. Replacing a case's
 * `sttHypothesis` with a real transcription result (and `referenceTranscript` with what was
 * actually said) requires no change to `../metrics.ts` or `./runBenchmarks.ts` — both operate on
 * plain text regardless of where it came from.
 */

import type { BenchmarkCase } from "./types";

export const BENCHMARK_CASES: BenchmarkCase[] = [
  {
    id: "clean-audio-1",
    category: "CLEAN_AUDIO",
    description: "Studio-quality mic, no background noise, native English speaker.",
    referenceTranscript:
      "I built a caching layer using Redis to reduce database load, with a write-through strategy and a short TTL.",
    sttHypothesis:
      "I built a caching layer using Redis to reduce database load, with a write-through strategy and a short TTL.",
    expectedTechnicalTerms: ["Redis", "caching", "write-through", "TTL"],
    question: "How did you handle caching in your last project?",
    topic: "caching",
    followUp: "How did you decide on the TTL value, and what happens on a cache miss?",
    humanScore: 9,
    automatedScore: 9,
  },
  {
    id: "noisy-audio-1",
    category: "NOISY_AUDIO",
    description: "Background traffic/office noise causing scattered word substitutions and drops.",
    referenceTranscript: "We used a message queue to decouple the services and handle retries with exponential backoff.",
    sttHypothesis: "We used a massive q to the couple the services and handle retries with exponential back off.",
    expectedTechnicalTerms: ["message queue", "exponential backoff"],
    question: "How does your system handle service failures?",
    topic: "reliability",
    followUp: "What queue technology did you use, and how do you handle a message that keeps failing?",
    humanScore: 7,
    automatedScore: 6,
  },
  {
    id: "indian-english-1",
    category: "INDIAN_ENGLISH",
    description: "Indian English phrasing/rhythm — accurate STT, no code-mixing.",
    referenceTranscript:
      "Actually, what we did was, we migrated the monolith to microservices only for the billing module, na, since that was the bottleneck.",
    sttHypothesis:
      "Actually, what we did was, we migrated the monolith to microservices only for the billing module, na, since that was the bottleneck.",
    expectedTechnicalTerms: ["monolith", "microservices"],
    question: "Tell me about a time you refactored a large system.",
    topic: "system design",
    followUp: "What made the billing module specifically the bottleneck?",
    humanScore: 8,
    automatedScore: 8,
  },
  {
    id: "hinglish-1",
    category: "HINGLISH",
    description: "Code-mixed Hindi/English — technical terms in English, connective phrases in Hindi.",
    referenceTranscript:
      "Maine backend mein Node.js use kiya tha aur database ke liye PostgreSQL, kyunki humein strong consistency chahiye thi.",
    sttHypothesis:
      "Maine backend mein node js use kiya tha aur database ke liye post gre sql, kyunki humein strong consistency chahiye thi.",
    expectedTechnicalTerms: ["Node.js", "PostgreSQL", "consistency"],
    question: "आपने बैकएंड के लिए कौन सी तकनीक इस्तेमाल की?",
    topic: "backend architecture",
    followUp: "PostgreSQL ही क्यों, MongoDB जैसा कोई NoSQL option क्यों नहीं?",
    humanScore: 7,
    automatedScore: 5,
  },
  {
    id: "fast-speaker-1",
    category: "FAST_SPEAKER",
    description: "Rapid speech causing a few words to be merged or dropped by STT.",
    referenceTranscript:
      "So basically I set up a CI pipeline that runs unit tests, integration tests, and a security scan before every merge to main.",
    sttHypothesis: "So basically I set up a CI pipeline that runs unit tests integration tests and security scan before merge to main.",
    expectedTechnicalTerms: ["CI pipeline", "unit tests", "integration tests"],
    question: "Walk me through your deployment process.",
    topic: "CI/CD",
    followUp: "What happens if the security scan fails after the tests already passed?",
    humanScore: 8,
    automatedScore: 7,
  },
  {
    id: "slow-speaker-1",
    category: "SLOW_SPEAKER",
    description: "Deliberate, paused speech — STT accuracy is typically high, but with more filler words captured verbatim.",
    referenceTranscript: "Um... so... I think the main challenge was, uh, keeping the cache consistent, um, across regions.",
    sttHypothesis: "Um so I think the main challenge was uh keeping the cache consistent um across regions.",
    expectedTechnicalTerms: ["cache", "consistent"],
    question: "What was the hardest technical challenge you faced?",
    topic: "distributed systems",
    followUp: "How did you end up keeping the cache consistent across regions?",
    humanScore: 8,
    automatedScore: 8,
  },
  {
    id: "technical-vocabulary-1",
    category: "TECHNICAL_VOCABULARY",
    description: "Dense, jargon-heavy answer — the hardest case for technical term preservation.",
    referenceTranscript:
      "We used optimistic concurrency control with a version column, and idempotency keys on the API to avoid duplicate writes during retries.",
    sttHypothesis:
      "We used optimistic concurrency control with a version column, and idempotent see keys on the API to avoid duplicate rights during retries.",
    expectedTechnicalTerms: ["optimistic concurrency control", "idempotency", "API"],
    question: "How do you prevent duplicate writes in a distributed system?",
    topic: "concurrency",
    followUp: "What happens if two idempotency keys collide for genuinely different requests?",
    humanScore: 9,
    automatedScore: 8,
  },
  {
    id: "long-answer-1",
    category: "LONG_ANSWER",
    description: "A multi-minute, multi-part answer covering several sub-topics.",
    referenceTranscript:
      "So there were really three parts to this. First, we profiled the slow endpoint and found an N+1 query problem. Second, we fixed that with eager loading, which got us most of the way there. Third, we still had some tail latency, so we added a read replica for the reporting queries specifically, since those were the ones scanning large date ranges.",
    sttHypothesis:
      "So there were really three parts to this. First, we profiled the slow endpoint and found an N plus one query problem. Second, we fixed that with eager loading, which got us most of the way there. Third, we still had some tail latency, so we added a read replica for the reporting queries specifically, since those were the ones scanning large date ranges.",
    expectedTechnicalTerms: ["N+1 query", "eager loading", "read replica", "tail latency"],
    question: "Tell me about a performance problem you solved.",
    topic: "performance",
    followUp: "How did you decide the read replica should be scoped to just the reporting queries?",
    humanScore: 9,
    automatedScore: 9,
  },
  {
    id: "short-answer-1",
    category: "SHORT_ANSWER",
    description: "A brief, low-content answer — little for STT to get wrong, but little for a follow-up to build on.",
    referenceTranscript: "I mostly used Python and some SQL.",
    sttHypothesis: "I mostly used Python and some SQL.",
    expectedTechnicalTerms: ["Python", "SQL"],
    question: "What languages did you use in that project?",
    topic: "tech stack",
    followUp: "What did you use Python for specifically versus SQL?",
    humanScore: 6,
    automatedScore: 6,
  },
  {
    id: "interrupted-speech-1",
    category: "INTERRUPTED_SPEECH",
    description: "The candidate was cut off mid-sentence by a barge-in; STT only captures the spoken prefix.",
    referenceTranscript: "I would probably start by adding an index on the foreign key column, and then maybe look at partition—",
    sttHypothesis: "I would probably start by adding an index on the foreign key column, and then maybe look at",
    expectedTechnicalTerms: ["index", "foreign key"],
    question: "How would you speed up that query?",
    topic: "database performance",
    followUp: "You mentioned partitioning — what would you partition the table by?",
    humanScore: 5,
    automatedScore: 4,
  },
];
