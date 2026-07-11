/**
 * Skill ontology + spaced-repetition retention model.
 *
 * A skill named on a resume ("Public Speaking") is shallow. The graph becomes intelligent when we
 * understand what that skill really involves (Public Speaking -> Clarity -> Confidence -> Storytelling).
 * This ontology defines the relationships between communication skills.
 *
 * This ontology is deliberately deterministic (no LLM required) so the demo works with zero
 * credentials. When Sarvam/Cognee are configured, extracted concepts are UNIONED with this map -
 * the ontology is a floor, not a ceiling.
 */

export interface SkillDef {
  /** sub-skills this skill decomposes into (RELATED_TO edges) */
  related: string[];
  /** skills that are prerequisites for this one (PREREQ_OF edges: prereq -> this) */
  prereqs?: string[];
  /** how quickly confidence decays without practice: higher = forgets faster (half-life days) */
  halfLifeDays?: number;
  /** curated learning resources for the skill -> learning-mission engine */
  resources?: { title: string; kind: "docs" | "video" | "exercise" | "quiz"; url?: string }[];
}

/** Keyed by skill name. Skills map onto the same space. */
export const SKILL_ONTOLOGY: Record<string, SkillDef> = {
  clarity: {
    related: ["Concise Expression", "Structured Thinking", "Plain Language"],
    prereqs: [],
    halfLifeDays: 45,
    resources: [
      { title: "Made to Stick: Why Some Ideas Survive and Others Die", kind: "docs" },
      { title: "Practice explaining complex topics to a 12-year-old", kind: "exercise" },
    ],
  },
  confidence: {
    related: ["Voice Projection", "Eye Contact", "Posture", "Filler Reduction"],
    prereqs: [],
    halfLifeDays: 60,
    resources: [
      { title: "The Confidence Code: The Science and Art of Self-Assurance", kind: "docs" },
      { title: "Practice power posing for 2 minutes before speaking", kind: "exercise" },
    ],
  },
  storytelling: {
    related: ["Narrative Structure", "Emotional Engagement", "Pacing", "Imagery"],
    prereqs: ["clarity"],
    halfLifeDays: 50,
    resources: [
      { title: "Storyworthy: Engage, Teach, Persuade, and Change Your Life", kind: "docs" },
      { title: "Tell a personal story using the 'story spine' structure", kind: "exercise" },
    ],
  },
  activelistening: {
    related: ["Paraphrasing", "Asking Clarifying Questions", "Nonverbal Feedback", "Judgment Suspension"],
    prereqs: [],
    halfLifeDays: 40,
    resources: [
      { title: "Just Listen: Discover the Secret to Getting Through to Absolutely Anyone", kind: "docs" },
      { title: "In your next conversation, practice reflecting back what you heard", kind: "exercise" },
    ],
  },
  persuasion: {
    related: ["Logical Arguments", "Emotional Appeal", "Credibility Building", "Call to Action"],
    prereqs: ["clarity", "confidence"],
    halfLifeDays: 55,
    resources: [
      { title: "Influence: The Psychology of Persuasion", kind: "docs" },
      { title: "Practice making a case for something you believe in", kind: "exercise" },
    ],
  },
  technicaldepth: {
    related: ["Conceptual Understanding", "Detail Orientation", "Analytical Thinking", "Problem Solving"],
    prereqs: [],
    halfLifeDays: 70,
    resources: [
      { title: "Clean Code: A Handbook of Agile Software Craftsmanship", kind: "docs" },
      { title: "Explain a technical concept you know well to a peer", kind: "exercise" },
    ],
  },
  problemSolving: {
    related: ["Root Cause Analysis", "Creative Thinking", "Decision Making", "Risk Assessment"],
    prereqs: [],
    halfLifeDays: 60,
    resources: [
      { title: "Think Smarter: Critical Thinking to Improve Problem-Solving and Decision-Making", kind: "docs" },
      { title: "Work through a logic puzzle or brain teaser", kind: "exercise" },
    ],
  },
  collaboration: {
    related: ["Feedback Giving", "Conflict Resolution", "Ideation Sharing", "Reliability"],
    prereqs: ["activelistening"],
    halfLifeDays: 50,
    resources: [
      { title: "Team Geek: A Software Developer's Guide to Working Well with Others", kind: "docs" },
      { title: "Practice giving and receiving constructive feedback with a partner", kind: "exercise" },
    ],
  },
  empathy: {
    related: ["Perspective Taking", "Emotional Recognition", "Compassionate Response", "Non-judgmental Attitude"],
    prereqs: ["activelistening"],
    halfLifeDays: 80,
    resources: [
      { title: "The Empathy Effect: Seven Neuroscience-Based Keys for Transforming the Way We Live, Love, Work, and Connect Across Differences", kind: "docs" },
      { title: "In your next interaction, consciously try to see things from the other person's perspective", kind: "exercise" },
    ],
  },
  // Technical communication skills
  apis: {
    related: ["REST", "GraphQL", "Authentication", "Rate Limiting", "Documentation"],
    prereqs: ["technicaldepth"],
    halfLifeDays: 60,
    resources: [
      { title: "API Design Patterns", kind: "docs" },
      { title: "Design a simple API for a TODO app", kind: "exercise" },
    ],
  },
  databases: {
    related: ["SQL", "NoSQL", "Indexing", "Transactions", "Normalization"],
    prereqs: ["technicaldepth"],
    halfLifeDays: 55,
    resources: [
      { title: "Designing Data-Intensive Applications", kind: "docs" },
      { title: "Explain the difference between SQL and NoSQL databases", kind: "exercise" },
    ],
  },
  distributedsystems: {
    related: ["Consistency", "Partitioning", "Replication", "Consensus", "Fault Tolerance"],
    prereqs: ["technicaldepth"],
    halfLifeDays: 40,
    resources: [
      { title: "Designing Distributed Systems", kind: "docs" },
      { title: "Draw a diagram of a simple distributed system you've used", kind: "exercise" },
    ],
  },
  ai: {
    related: ["Machine Learning", "Natural Language Processing", "Computer Vision", "Ethics"],
    prereqs: ["technicaldepth"],
    halfLifeDays: 65,
    resources: [
      { title: "Artificial Intelligence: A Modern Approach", kind: "docs" },
      { title: "Explain how a recommendation system works", kind: "exercise" },
    ],
  },
};

/** Look up ontology by any casing; returns a default def for unknown concepts. */
export function skillDef(name: string): SkillDef {
  const key = name.toLowerCase().trim();
  return SKILL_ONTOLOGY[key] ?? { related: [], halfLifeDays: 30 };
}

/** Related skills (deduped) for a skill name. */
export function relatedSkills(name: string): string[] {
  return skillDef(name).related;
}

/**
 * Retention model: exponential forgetting curve. Confidence is what you *knew*; retention is how
 * much of it survives `days` of not practising, given this skill's half-life. Reinforcement
 * (practicing it again) resets days-since to 0. This is what powers "Public Speaking last discussed
 * 72 days ago, confidence likely decaying → generate public speaking questions".
 */
export function retentionAfter(days: number, halfLifeDays = 30): number {
  if (days <= 0) return 100;
  const decayed = 100 * Math.pow(0.5, days / halfLifeDays);
  return Math.max(0, Math.round(decayed));
}

/** Human phrase for how stale a skill is. */
export function stalenessLabel(days: number): string {
  const d = Math.round(days);
  if (d <= 1) return "just now";
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  return `${Math.round(d / 30)} months ago`;
}