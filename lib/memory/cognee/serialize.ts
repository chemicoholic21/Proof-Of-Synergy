/**
 * Normalize a memory into relationship-rich text before it is handed to Cognee.
 *
 * The brief is explicit: don't store "I used Redis because it was faster" — store the MEANING.
 * Cognee builds its own knowledge graph from what we `add`, so we feed it normalized subject–
 * predicate–object statements, not raw transcripts. That way Cognee's graph and our local graph
 * agree on entities and relationships.
 */

import { RememberInterviewInput, RememberResumeInput } from "../types";

export function serializeResumeForCognee(input: RememberResumeInput): string {
  const lines: string[] = [];
  const who = input.name || "The candidate";
  lines.push(`${who} owns a resume.`);
  for (const s of input.skills) lines.push(`Resume CLAIMS skill "${s.name}" at ${s.claimedLevel} level (category: ${s.category ?? "general"}).`);
  for (const e of input.experience ?? []) lines.push(`${who} worked as ${e.role} at ${e.company} for ${e.years} years.`);
  for (const p of input.projects ?? []) {
    lines.push(`${who} built project "${p.name}"${p.summary ? `: ${p.summary}` : ""}.`);
    for (const t of p.technologies ?? []) lines.push(`Project "${p.name}" USES technology "${t}".`);
  }
  return lines.join("\n");
}

export function serializeInterviewForCognee(input: RememberInterviewInput, index: number): string {
  const lines: string[] = [];
  const who = input.name || "The candidate";
  lines.push(`Interview #${index}${input.company ? ` (preparation for ${input.company})` : ""}.`);
  for (const a of input.answers) {
    const verdict = a.score >= 78 ? "STRONG" : a.score < 55 ? "WEAK" : "PARTIAL";
    lines.push(`Interview #${index} TESTS concept "${a.targetSkill}". ${who} demonstrated ${verdict} understanding (score ${a.score}%).`);
    if (a.feedback) lines.push(`Evaluation of "${a.targetSkill}": ${a.feedback}`);
  }
  return lines.join("\n");
}
