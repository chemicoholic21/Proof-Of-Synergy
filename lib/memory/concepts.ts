/**
  * Communication skill ontology + spaced-repetition retention model.
  *
  * A skill named on a profile ("Storytelling") is shallow. The graph becomes intelligent when a single
  * weak answer expands into a *connected* sub-graph of the concepts that skill really involves
  * (Storytelling -> Hook -> Emotional Arc -> Call to Action -> Audience Awareness). That is the
  * "Weakness Graph" and it is also what lets improve() build meaningful RELATED_TO / PREREQ_OF edges
  * and what lets the Practice Mission engine target the exact weak node.
  *
  * This ontology is deliberately deterministic (no LLM required) so the demo works with zero
  * credentials. When Sarvam/Cognee are configured, extracted concepts are UNIONED with this map -
  * the ontology is a floor, not a ceiling.
  */

export interface ConceptDef {
  /** sub-concepts this skill/concept decomposes into (RELATED_TO edges) */
  related: string[];
  /** concepts that are prerequisites for this one (PREREQ_OF edges: prereq -> this) */
  prereqs?: string[];
  /** how quickly confidence decays without practice: higher = forgets faster (half-life days) */
  halfLifeDays?: number;
  /** curated learning resources for the weakness -> practice-mission engine */
  resources?: { title: string; kind: "docs" | "video" | "exercise" | "quiz"; url?: string }[];
}

/** Keyed by concept slug-ish lowercase name. Skills map onto the same space. */
export const ONTOLOGY: Record<string, ConceptDef> = {
  storytelling: {
    related: ["Hook", "Emotional Arc", "Call to Action", "Audience Awareness", "Narrative Structure"],
    prereqs: ["Clarity"],
    halfLifeDays: 45,
    resources: [
      { title: "Storytelling at Work: The Power of Narrative", kind: "docs" },
      { title: "Build a 30-second elevator pitch", kind: "exercise" },
      { title: "Quiz: narrative structure and hooks", kind: "quiz" },
    ],
  },
  hook: {
    related: ["Opening Line", "Curiosity Gap", "Bold Claim"],
    prereqs: ["Storytelling"],
    halfLifeDays: 40,
  },
  clarity: {
    related: ["Conciseness", "Structure", "Jargon-Free Language", "Active Voice"],
    halfLifeDays: 60,
    resources: [
      { title: "The Pyramid Principle for clear communication", kind: "docs" },
      { title: "Rewrite a paragraph for clarity", kind: "exercise" },
    ],
  },
  confidence: {
    related: ["Eye Contact", "Pace Control", "Voice Projection", "Body Language", "Hedge Removal"],
    halfLifeDays: 50,
    resources: [
      { title: "Presence and vocal confidence guide", kind: "docs" },
      { title: "Record and review a 2-minute pitch", kind: "exercise" },
    ],
  },
  "technical depth": {
    related: ["Analogy", "Simplification", "System Thinking", "Tradeoff Articulation"],
    prereqs: ["Clarity"],
    halfLifeDays: 70,
    resources: [
      { title: "Explain Like I'm 5: technical simplification", kind: "docs" },
      { title: "Explain a complex API to a non-engineer", kind: "exercise" },
    ],
  },
  empathy: {
    related: ["Active Listening", "Validation", "Perspective Taking", "Emotional Regulation"],
    halfLifeDays: 55,
    resources: [
      { title: "Nonviolent Communication basics", kind: "docs" },
      { title: "Practice reflective listening in a mock conversation", kind: "exercise" },
    ],
  },
  persuasion: {
    related: ["Social Proof", "Reciprocity", "Authority", "Scarcity"],
    prereqs: ["Storytelling", "Clarity"],
    halfLifeDays: 50,
  },
  "active listening": {
    related: ["Paraphrasing", "Questioning", "Silence", "Validation"],
    halfLifeDays: 65,
  },
  negotiation: {
    related: ["BATNA", "Anchoring", "Concessions", "Win-Win Framing"],
    halfLifeDays: 60,
    resources: [{ title: "Getting to Yes: essential negotiation concepts", kind: "docs" }],
  },
  "public speaking": {
    related: ["Stage Presence", "Slides", "Pacing", "Pauses", "Audience Engagement"],
    halfLifeDays: 45,
  },
  feedback: {
    related: ["SBI Model", "Timing", "Tone", "Follow-Up"],
    halfLifeDays: 55,
    resources: [{ title: "Radical Candor: caring personally while challenging directly", kind: "docs" }],
  },
  presence: {
    related: ["Posture", "Eye Contact", "Pauses", "Energy"],
    halfLifeDays: 50,
  },
  structure: {
    related: ["Opening", "Body", "Conclusion", "Signposting"],
    prereqs: ["Clarity"],
    halfLifeDays: 60,
  },
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
  * (practicing it again) resets days-since to 0. This is what powers "Storytelling last practiced 72
  * days ago, confidence likely decaying -> generate Storytelling scenarios".
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
