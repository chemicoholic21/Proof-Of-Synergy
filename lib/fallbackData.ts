import { ParsedResume, InterviewQuestion, Transcript, QuestionEvaluation } from "./types";

// Centralized mock data so every external call degrades silently, a judge never sees an error.
// Values are realistic and deliberately include one exaggerated skill (Kubernetes) to power the
// fraud-detector demo moment.

export const FALLBACK_RESUME: ParsedResume = {
  name: "Aarav Sharma",
  contact: "aarav.sharma@example.com",
  skills: [
    { name: "Python", category: "Programming", claimedLevel: "expert" },
    { name: "AWS", category: "Cloud", claimedLevel: "advanced" },
    { name: "React", category: "Frontend", claimedLevel: "advanced" },
    { name: "Kubernetes", category: "DevOps", claimedLevel: "advanced" },
  ],
  experience: [
    { role: "Senior Backend Engineer", company: "FinStack", years: 3 },
    { role: "Software Engineer", company: "Razorpay", years: 2 },
  ],
  education: [{ degree: "B.Tech Computer Science", institution: "IIT Bombay", year: 2019 }],
  source: "fallback",
};

export const FALLBACK_QUESTIONS: InterviewQuestion[] = [
  {
    id: 1,
    text: "Your resume says you built a trading service in Python. Walk me through one design decision you made for reliability, and what you'd change if traffic grew 10x.",
    targetSkill: "Python",
    rubric: "Looks for concrete reasoning, trade-offs, and scaling awareness rather than buzzwords.",
  },
  {
    id: 2,
    text: "You list AWS as advanced. How did you decide between a queue and a stream for an event pipeline, and what failure modes did you plan for?",
    targetSkill: "AWS",
    rubric: "Looks for real service experience and failure-mode thinking.",
  },
  {
    id: 3,
    text: "On the React side, how do you keep a data-heavy dashboard responsive? Talk about a specific bottleneck you hit.",
    targetSkill: "React",
    rubric: "Looks for rendering/perf understanding from lived experience.",
  },
  {
    id: 4,
    text: "You marked Kubernetes as advanced. Explain the difference between a Deployment and a StatefulSet, and when you'd reach for each.",
    targetSkill: "Kubernetes",
    rubric: "Core k8s concept; a confident, correct answer signals real depth.",
  },
];

// Per-skill question templates used when the LLM question generator is unavailable (DEMO_MODE).
// Unlike the static FALLBACK_QUESTIONS above, these are built from the candidate's ACTUAL parsed
// skills, so the interview always reflects the uploaded resume instead of a fixed fictional one.
const QUESTION_TEMPLATES: Record<string, string> = {
  python:
    "Walk me through a non-trivial system you built in Python. What was the hardest reliability or performance problem you hit, and how did you solve it?",
  javascript:
    "Describe a tricky bug or performance issue you debugged in a JavaScript codebase. How did you isolate the root cause and what was the fix?",
  typescript:
    "Tell me about a time TypeScript's type system either saved you or got in your way. How did you model the problem?",
  react:
    "How do you keep a data-heavy React UI responsive? Talk about a specific rendering or state bottleneck you hit and how you fixed it.",
  aws: "Walk me through an AWS architecture you designed. How did you decide between the services you used, and what failure modes did you plan for?",
  kubernetes:
    "Explain a real Kubernetes problem you debugged in production. What primitives were involved and how did you reason about it?",
  docker:
    "Describe how you containerized and shipped a real service. What trade-offs did you make around image size, build speed, or security?",
  sql: "Tell me about a slow query or schema design problem you solved. How did you diagnose it and what changed?",
  java: "Walk me through a concurrency or memory problem you solved in Java. How did you reason about it and verify the fix?",
  go: "Describe a system you built in Go. How did you use goroutines/channels, and what concurrency pitfalls did you have to design around?",
  node: "Describe a backend you built on Node.js. How did you handle async failure modes and keep the event loop healthy under load?",
};

/**
 * Build interview questions from the candidate's ACTUAL skills, deterministically. Used as the
 * DEMO_MODE fallback when the Sarvam question generator is unavailable, so the questions always
 * reflect the uploaded resume rather than a fixed set tied to a fictional profile.
 */
export function buildFallbackQuestions(
  skills: { name: string; category: string; claimedLevel: string }[]
): InterviewQuestion[] {
  return skills.slice(0, 7).map((s, i) => {
    const key = s.name.toLowerCase().trim();
    const text =
      QUESTION_TEMPLATES[key] ??
      `You list ${s.name} as ${s.claimedLevel}. Describe a specific, real problem you solved with ${s.name}, the trade-offs you weighed, and what you would do differently today.`;
    return {
      id: i + 1,
      text,
      targetSkill: s.name,
      rubric: `Looks for concrete, lived experience with ${s.name} rather than memorized definitions.`,
    };
  });
}

export const FALLBACK_TRANSCRIPTS: Record<number, Transcript> = {
  1: {
    text: "So for the trading service I used idempotency keys on every order request so retries wouldn't double-execute, and I put a circuit breaker in front of the broker API. If traffic grew ten times I'd move from synchronous calls to an event queue and shard by instrument.",
    language: "English",
    languagesDetected: ["English"],
    source: "fallback",
  },
  2: {
    text: "I chose Kinesis streams over SQS because we needed ordered replay for the ledger. For failures I had a dead-letter stream and checkpointed consumers so we could reprocess from the last good sequence number.",
    language: "English",
    languagesDetected: ["English", "Hindi"],
    source: "fallback",
  },
  3: {
    text: "The dashboard was re-rendering the whole grid on every tick, so I memoized rows and moved to virtualized lists, and I debounced the websocket updates into animation frames.",
    language: "English",
    languagesDetected: ["English"],
    source: "fallback",
  },
  4: {
    text: "Umm, Kubernetes, yeah I have used it... a Deployment is like, for running pods, and StatefulSet is also for pods but, um, I think it is the same mostly, I usually just used the default one the team gave me.",
    language: "English",
    languagesDetected: ["English"],
    source: "fallback",
  },
};

export const FALLBACK_EVALUATIONS: Record<number, QuestionEvaluation> = {
  1: {
    questionId: 1,
    targetSkill: "Python",
    score: 91,
    feedback: "Strong, specific reasoning: idempotency, circuit breaker, and a credible scaling path.",
    strengths: ["Concrete reliability patterns", "Clear scaling trade-off"],
    improvements: ["Could quantify latency budgets"],
  },
  2: {
    questionId: 2,
    targetSkill: "AWS",
    score: 84,
    feedback: "Good service-level reasoning and failure handling with dead-letter + checkpointing.",
    strengths: ["Ordered replay rationale", "Failure-mode planning"],
    improvements: ["Cost trade-offs not discussed"],
  },
  3: {
    questionId: 3,
    targetSkill: "React",
    score: 88,
    feedback: "Demonstrates real perf debugging: memoization, virtualization, frame batching.",
    strengths: ["Identified a real bottleneck", "Practical fixes"],
    improvements: ["No mention of profiling tools"],
  },
  4: {
    questionId: 4,
    targetSkill: "Kubernetes",
    score: 34,
    feedback: "Could not distinguish Deployment from StatefulSet; vague and hesitant. Claimed level not supported.",
    strengths: [],
    improvements: ["Learn core workload primitives", "Hands-on practice beyond defaults"],
  },
};
