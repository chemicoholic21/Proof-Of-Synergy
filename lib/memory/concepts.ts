/**
 * Concept ontology + spaced-repetition retention model.
 *
 * A skill named on a resume ("Kafka") is shallow. The graph becomes intelligent when a single weak
 * answer expands into a *connected* sub-graph of the concepts that skill really involves
 * (Kafka → Consumer Groups → Partitions → Offset Management → Distributed Systems). That is the
 * "Weakness Graph" and it is also what lets improve() build meaningful RELATED_TO / PREREQ_OF edges
 * and what lets the Learning Engine target the exact weak node.
 *
 * This ontology is deliberately deterministic (no LLM required) so the demo works with zero
 * credentials. When Sarvam/Cognee are configured, extracted concepts are UNIONED with this map —
 * the ontology is a floor, not a ceiling.
 */

export interface ConceptDef {
  /** sub-concepts this skill/concept decomposes into (RELATED_TO edges) */
  related: string[];
  /** concepts that are prerequisites for this one (PREREQ_OF edges: prereq -> this) */
  prereqs?: string[];
  /** how quickly confidence decays without practice: higher = forgets faster (half-life days) */
  halfLifeDays?: number;
  /** curated learning resources for the weakness -> learning-mission engine */
  resources?: { title: string; kind: "docs" | "video" | "exercise" | "quiz"; url?: string }[];
}

/** Keyed by concept slug-ish lowercase name. Skills map onto the same space. */
export const ONTOLOGY: Record<string, ConceptDef> = {
  kafka: {
    related: ["Consumer Groups", "Partitions", "Offset Management", "Message Ordering", "Distributed Systems"],
    prereqs: ["Distributed Systems"],
    halfLifeDays: 45,
    resources: [
      { title: "Kafka: The Definitive Guide (Consumer chapter)", kind: "docs" },
      { title: "Build a partitioned consumer group demo", kind: "exercise" },
      { title: "Quiz: rebalance & offset semantics", kind: "quiz" },
    ],
  },
  "consumer groups": {
    related: ["Partitions", "Offset Management", "Rebalancing"],
    prereqs: ["Kafka"],
    halfLifeDays: 40,
  },
  redis: {
    related: ["Persistence", "Replication", "Cluster", "Sentinel", "Transactions", "Caching"],
    halfLifeDays: 50,
    resources: [
      { title: "Redis persistence & replication docs", kind: "docs" },
      { title: "Set up a Redis Sentinel failover locally", kind: "exercise" },
    ],
  },
  docker: {
    related: ["Networking", "Volumes", "Compose", "Image Layers", "Multi-stage Builds"],
    prereqs: ["Linux"],
    halfLifeDays: 60,
    resources: [
      { title: "Docker networking deep-dive", kind: "docs" },
      { title: "Containerize a service with a multi-stage build", kind: "exercise" },
    ],
  },
  kubernetes: {
    related: ["Deployments", "StatefulSets", "Services", "Ingress", "Pods", "Scheduling"],
    prereqs: ["Docker", "Networking"],
    halfLifeDays: 40,
    resources: [
      { title: "Kubernetes workloads: Deployment vs StatefulSet", kind: "docs" },
      { title: "Deploy a stateful app with a StatefulSet", kind: "exercise" },
      { title: "Quiz: core workload primitives", kind: "quiz" },
    ],
  },
  react: {
    related: ["Rendering", "State Management", "Hooks", "Memoization", "Virtualization"],
    prereqs: ["JavaScript"],
    halfLifeDays: 70,
    resources: [
      { title: "React rendering & memoization guide", kind: "docs" },
      { title: "Profile and fix a slow list with virtualization", kind: "exercise" },
    ],
  },
  aws: {
    related: ["EC2", "S3", "Lambda", "SQS", "Kinesis", "IAM", "VPC"],
    halfLifeDays: 55,
    resources: [{ title: "AWS messaging: SQS vs Kinesis", kind: "docs" }],
  },
  python: {
    related: ["Concurrency", "AsyncIO", "Data Structures", "Testing", "Packaging"],
    halfLifeDays: 90,
  },
  javascript: {
    related: ["Event Loop", "Promises", "Closures", "Prototypes"],
    halfLifeDays: 90,
  },
  typescript: { related: ["Generics", "Type Narrowing", "Utility Types"], prereqs: ["JavaScript"], halfLifeDays: 80 },
  "system design": {
    related: ["Scalability", "Caching", "Load Balancing", "Sharding", "Consistency", "Message Queues"],
    halfLifeDays: 45,
    resources: [{ title: "System Design Primer", kind: "docs" }],
  },
  "distributed systems": {
    related: ["Consistency", "Partitioning", "Replication", "Consensus", "Fault Tolerance"],
    halfLifeDays: 40,
  },
  sql: { related: ["Indexing", "Query Planning", "Transactions", "Normalization"], halfLifeDays: 75 },
  networking: { related: ["TCP/IP", "DNS", "Load Balancing", "TLS"], halfLifeDays: 65 },
  go: { related: ["Goroutines", "Channels", "Concurrency", "Interfaces"], halfLifeDays: 80 },
  java: { related: ["Concurrency", "JVM", "Garbage Collection", "Collections"], halfLifeDays: 85 },
  leadership: { related: ["Mentorship", "Ownership", "Conflict Resolution", "Delegation"], halfLifeDays: 120 },
  behavioral: { related: ["STAR Method", "Ownership", "Conflict Resolution", "Impact"], halfLifeDays: 100 },
};

/** Look up ontology by any casing; returns a default def for unknown concepts. */
export function conceptDef(name: string): ConceptDef {
  const key = name.toLowerCase().trim();
  return ONTOLOGY[key] ?? { related: [], halfLifeDays: 60 };
}

/** Related concepts (deduped) for a skill/concept name. */
export function relatedConcepts(name: string): string[] {
  return conceptDef(name).related;
}

/**
 * Retention model: exponential forgetting curve. Confidence is what you *knew*; retention is how
 * much of it survives `days` of not practising, given this concept's half-life. Reinforcement
 * (answering it again) resets days-since to 0. This is what powers "Kafka last discussed 72 days
 * ago, confidence likely decaying → generate Kafka questions".
 */
export function retentionAfter(days: number, halfLifeDays = 60): number {
  if (days <= 0) return 100;
  const decayed = 100 * Math.pow(0.5, days / halfLifeDays);
  return Math.max(0, Math.round(decayed));
}

/** Human phrase for how stale a memory is. */
export function stalenessLabel(days: number): string {
  const d = Math.round(days);
  if (d <= 1) return "just now";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  return `${Math.round(d / 30)} months ago`;
}
