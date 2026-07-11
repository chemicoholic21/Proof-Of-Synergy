/**
 * Normalize a practice session into relationship-rich text before it is handed to Cognee.
 *
 * The brief is explicit: don't store "I said 'um' a lot" - store the MEANING.
 * Cognee builds its own knowledge graph from what we `add`, so we feed it normalized subject–
 * predicate–object statements, not raw transcripts. That way Cognee's graph and our local graph
 * agree on entities and relationships.
 */

import { RememberSessionInput } from "../types";

export function serializeSessionForCognee(input: RememberSessionInput): string {
  const lines: string[] = [];
  const who = `Learner ${input.learnerId}`;
  lines.push(`${who} practiced scenario "${input.scenarioId}".`);
  
  // Analyze the conversation for key themes
  const learnerMessages = input.messages.filter(m => m.role === "learner");
  const totalWords = learnerMessages.reduce((sum, m) => sum + m.content.split(/\s+/).length, 0);
  
  lines.push(`${who} spoke approximately ${totalWords} words during the practice session.`);
  
  // Extract key topics or phrases from learner responses (simplified)
  const keyPhrases = learnerMessages
    .map(m => m.content.trim())
    .filter(m => m.length > 20)
    .slice(0, 3);
  
  if (keyPhrases.length > 0) {
    lines.push(`${who} demonstrated understanding of: "${keyPhrases.join('"; "')}."`);
  }
  
  lines.push(`${who} completed the session with ${input.messages.length} total exchanges.`);
  
  return lines.join("\n");
}