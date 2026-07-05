import { describe, it, expect, beforeEach } from "vitest";
import { extractDNA, aggregateDNA } from "./interview-memory";
import { emptyGraph } from "./graph/model";
import { __setClock, nodesByKind, edgesTo } from "./graph/ops";
import { rememberResume, rememberGithub } from "./remember";
import { realityGap, skillCards } from "./derive";
import { GithubProfile } from "./github";
import { questionGenAdaptiveUser } from "@/lib/prompts";

beforeEach(() => {
  __setClock(() => "2026-06-01T00:00:00.000Z");
});

describe("Interview DNA", () => {
  it("counts fillers/hedges and scores a vague answer low", () => {
    const dna = extractDNA("Um, I think it is basically the same, you know, kind of, I'm not sure.");
    expect(dna.fillerCount).toBeGreaterThan(0);
    expect(dna.hedgeCount).toBeGreaterThan(0);
    expect(dna.confidence).toBeLessThan(55);
    expect(dna.topFillers.length).toBeGreaterThan(0);
  });

  it("scores a specific, first-person answer higher than a vague one", () => {
    const strong = extractDNA("I built the pipeline with idempotency keys and I designed a circuit breaker; in production it kept latency low.");
    const weak = extractDNA("um yeah basically i think it works kind of.");
    expect(strong.confidence).toBeGreaterThan(weak.confidence);
    expect(strong.confidenceMarkers).toBeGreaterThan(0);
    expect(strong.technicalDepth).toBeGreaterThan(0);
  });

  it("derives speech rate (wpm) only when a duration is provided", () => {
    const text = "one two three four five six seven eight nine ten"; // 10 words
    expect(extractDNA(text).speechRateWpm).toBeNull();
    expect(extractDNA(text, 30).speechRateWpm).toBe(20); // 10 words / 30s * 60
  });

  it("aggregates several answers weighted by word count", () => {
    const agg = aggregateDNA([extractDNA("um basically", 5), extractDNA("I designed and built a real system in production", 20)]);
    expect(agg.wordCount).toBeGreaterThan(0);
    expect(agg.speechRateWpm).not.toBeNull();
  });
});

describe("GitHub evidence", () => {
  const profile: GithubProfile = {
    username: "octo",
    repoCount: 3,
    repos: [],
    technologies: { react: 4, python: 2, rust: 1 },
  };

  it("attaches GitHub evidence to matching skills and leaves unmatched claims without it", () => {
    const g = emptyGraph("octo", "Octo", "2026-06-01T00:00:00.000Z");
    rememberResume(g, {
      candidateId: "octo",
      skills: [
        { name: "React", claimedLevel: "advanced" },
        { name: "Kubernetes", claimedLevel: "advanced" },
      ],
    });
    rememberGithub(g, "octo", profile);

    // React matched -> has github evidence; Kubernetes has none (the reality-gap signal).
    const cards = skillCards(g);
    expect(cards.find((c) => c.skill === "React")!.githubEvidence).toBeGreaterThan(0);
    expect(cards.find((c) => c.skill === "Kubernetes")!.githubEvidence).toBe(0);

    // Technology nodes were created for every shipped tech.
    const techs = nodesByKind(g, "technology").map((t) => t.label);
    expect(techs).toEqual(expect.arrayContaining(["react", "python", "rust"]));

    // Reality gap renders github as positive evidence on the matched skill.
    const react = realityGap(g).find((r) => r.skill === "React")!;
    expect(JSON.stringify(react.evidence).toLowerCase()).toContain("github");

    void edgesTo;
  });
});

describe("adaptive prompt", () => {
  it("injects the Cognee graph answer as an authoritative block when present", () => {
    const prompt = questionGenAdaptiveUser([{ name: "Kafka", category: "Data", claimedLevel: "advanced" }], {
      focusDirectives: ["Revisit Kafka"],
      weakConcepts: [{ name: "Kafka", confidence: 40 }],
      forgottenConcepts: [],
      unverifiedSkills: [],
      masteredConcepts: [],
      upcomingCompany: "Stripe",
      interviewCount: 3,
      cogneeInsight: "Weakest concept: Kafka consumer groups.",
    });
    expect(prompt).toContain("COGNEE MEMORY");
    expect(prompt).toContain("Kafka consumer groups");
    expect(prompt).toContain("Stripe");
  });

  it("omits the Cognee block when there is no insight", () => {
    const prompt = questionGenAdaptiveUser([{ name: "Go", category: "Lang", claimedLevel: "expert" }], {
      focusDirectives: [],
      weakConcepts: [],
      forgottenConcepts: [],
      unverifiedSkills: [],
      masteredConcepts: [],
      upcomingCompany: null,
      interviewCount: 1,
      cogneeInsight: null,
    });
    expect(prompt).not.toContain("COGNEE MEMORY");
  });
});
