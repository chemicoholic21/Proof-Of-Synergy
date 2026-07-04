/**
 * One-click demo seed. Builds a candidate who has used Synergy for six months: a resume, three
 * interviews across two companies showing a clear growth arc (Kubernetes weak → improving,
 * communication fillers dropping, Docker verified), so the presenter never has to hand-seed data.
 *
 * The interviews are spaced weeks apart using an injected clock, which is exactly what makes the
 * retention-decay, spaced-repetition and improvement-timeline features light up in the demo.
 */

import { CareerGraph, emptyGraph } from "./graph/model";
import { __setClock } from "./graph/ops";
import { rememberInterview, rememberResume } from "./remember";
import { improve } from "./improve";
import { RememberAnswer } from "./types";

function ans(o: { questionId: number; targetSkill: string; score: number; q: string; transcript: string; feedback: string }): RememberAnswer {
  return {
    questionId: o.questionId,
    questionText: o.q,
    targetSkill: o.targetSkill,
    rubric: "",
    transcript: o.transcript,
    language: "English",
    score: o.score,
    feedback: o.feedback,
    strengths: [],
    improvements: [],
  };
}

/** Build a fully-seeded demo graph for `candidateId`. Uses an injected clock so timestamps span months. */
export function buildDemoGraph(candidateId: string, name = "Aarav Sharma"): CareerGraph {
  let virtual = Date.parse("2026-01-06T10:00:00.000Z");
  const startNow = new Date(virtual).toISOString();
  const restore = __setClock(() => new Date(virtual).toISOString());
  try {
    const g = emptyGraph(candidateId, name, startNow);

    rememberResume(g, {
      candidateId,
      name,
      skills: [
        { name: "Python", category: "Programming", claimedLevel: "expert" },
        { name: "AWS", category: "Cloud", claimedLevel: "advanced" },
        { name: "React", category: "Frontend", claimedLevel: "advanced" },
        { name: "Kubernetes", category: "DevOps", claimedLevel: "advanced" },
        { name: "Kafka", category: "Data", claimedLevel: "advanced" },
      ],
      experience: [
        { role: "Senior Backend Engineer", company: "FinStack", years: 3 },
        { role: "Software Engineer", company: "Razorpay", years: 2 },
      ],
      education: [{ degree: "B.Tech Computer Science", institution: "IIT Bombay", year: 2019 }],
      projects: [
        { name: "High-throughput trading service", technologies: ["Python", "Kafka", "AWS"], summary: "Low-latency order pipeline" },
        { name: "Realtime analytics dashboard", technologies: ["React", "AWS"], summary: "Live trading dashboards" },
      ],
    });
    improve(g);

    // Interview #1 — baseline. Kubernetes fails, lots of fillers.
    virtual += 0; // week 0
    rememberInterview(g, {
      candidateId,
      name,
      company: "Stripe",
      answers: [
        ans({ questionId: 1, targetSkill: "Python", score: 90, q: "Walk me through a reliability decision in your trading service.", transcript: "I built the order pipeline with idempotency keys so retries never double execute, and I added a circuit breaker in front of the broker API. In production this kept us consistent under load.", feedback: "Strong, specific reliability reasoning." }),
        ans({ questionId: 2, targetSkill: "Kafka", score: 58, q: "How did you use Kafka in the trading service?", transcript: "Um, we used Kafka for the events, and I think there were partitions, basically I set up a topic and, kind of, consumed from it. I am not totally sure about the consumer group rebalancing.", feedback: "Partial: used Kafka but shaky on consumer groups." }),
        ans({ questionId: 3, targetSkill: "Kubernetes", score: 30, q: "Explain Deployment vs StatefulSet and when to use each.", transcript: "Umm, Kubernetes, yeah I have used it, a Deployment is like for running pods, and StatefulSet is also for pods but I think it is basically the same, I usually just used the default the team gave me.", feedback: "Could not distinguish core workload primitives." }),
      ],
    });
    improve(g, { company: "Stripe" });

    // Interview #2 — 4 weeks later. Learned Kubernetes basics, fewer fillers.
    virtual += 28 * 24 * 60 * 60 * 1000;
    rememberInterview(g, {
      candidateId,
      name,
      company: "Stripe",
      answers: [
        ans({ questionId: 1, targetSkill: "Kubernetes", score: 58, q: "When would you reach for a StatefulSet over a Deployment?", transcript: "A Deployment is for stateless pods that are interchangeable. A StatefulSet gives stable network identities and stable storage, so I would use it for something like a database or Kafka broker that needs a persistent identity.", feedback: "Solid improvement, correct distinction now." }),
        ans({ questionId: 2, targetSkill: "React", score: 86, q: "How do you keep a data-heavy dashboard responsive?", transcript: "I profiled the render, memoized the rows, and moved to a virtualized list, then I batched the websocket updates into animation frames so we were not re-rendering the whole grid on every tick.", feedback: "Clear, real performance debugging." }),
        ans({ questionId: 3, targetSkill: "Kafka", score: 62, q: "Explain consumer group rebalancing.", transcript: "When a consumer joins or leaves, the group coordinator triggers a rebalance and reassigns partitions. I learned to commit offsets carefully so we do not reprocess after a rebalance.", feedback: "Improved understanding of rebalancing." }),
      ],
    });
    improve(g, { company: "Stripe" });

    // Interview #3 — 6 weeks later, Google prep. Kubernetes confident, very few fillers.
    virtual += 42 * 24 * 60 * 60 * 1000;
    rememberInterview(g, {
      candidateId,
      name,
      company: "Google",
      answers: [
        ans({ questionId: 1, targetSkill: "Kubernetes", score: 84, q: "Design the deployment topology for a stateful streaming service.", transcript: "I would run stateless consumers as a Deployment behind a Service, and the brokers as a StatefulSet with persistent volume claims and a headless Service for stable identities. I would use pod disruption budgets and readiness probes so rolling updates never drop the whole consumer group.", feedback: "Confident, production-grade design." }),
        ans({ questionId: 2, targetSkill: "System Design", score: 74, q: "Design a rate limiter for an API gateway.", transcript: "I would use a token bucket in Redis keyed by client, with a sliding window for burst control, and degrade gracefully to a local in-memory limiter if Redis is unavailable so we fail open under partition.", feedback: "Good tradeoff-aware design." }),
        ans({ questionId: 3, targetSkill: "Kafka", score: 80, q: "How do you guarantee ordering with partitions?", transcript: "Ordering is per partition, so I key messages by entity id to keep a stable partition, and I size partitions for parallelism while accepting that global ordering is not guaranteed, only per-key ordering.", feedback: "Strong, precise answer." }),
      ],
    });
    improve(g, { company: "Google" });

    return g;
  } finally {
    restore();
  }
}
