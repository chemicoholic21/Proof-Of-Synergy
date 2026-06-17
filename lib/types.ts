export type SkillLevel = "beginner" | "intermediate" | "advanced" | "expert";

export interface ResumeSkill {
  name: string;
  category: string;
  claimedLevel: SkillLevel;
}

export interface ParsedResume {
  name: string | null;
  contact: string | null;
  skills: ResumeSkill[];
  experience: { role: string; company: string; years: number }[];
  education: { degree: string; institution: string; year: number | null }[];
  source: "sarvam" | "fallback";
  // When source === "fallback", explains why the real parse was not used (e.g. missing API key,
  // timeout, parse error). Surfaced in the UI so demo mode is never silent/confusing.
  reason?: string;
}

export interface InterviewQuestion {
  id: number;
  text: string;
  targetSkill: string; // matches a ResumeSkill.name
  rubric: string;
}

export interface Transcript {
  text: string;
  language: string;
  languagesDetected: string[];
  source: "sarvam" | "fallback";
}

export interface QuestionEvaluation {
  questionId: number;
  targetSkill: string;
  score: number; // 0-100
  feedback: string;
  strengths: string[];
  improvements: string[];
  // Multi-agent (judge-panel) metadata. Optional so single-judge results stay backward compatible.
  confidence?: number; // 0-100; panel agreement. Low confidence => route to human review.
  subScores?: { technical: number; communication: number; deduction: number };
  // True when panel disagreement leaves the score below the confidence threshold; the caller
  // should NOT write a low-confidence score on-chain without human review.
  lowConfidence?: boolean;
}

export type SkillStatus = "strong" | "verified" | "exaggerated";

export interface SkillVerdict {
  skill: string;
  claimedLevel: SkillLevel;
  observedConfidence: number; // 0-100
  status: SkillStatus;
  flag: string | null;
}

export interface MintResult {
  subject: `0x${string}`;
  registryAddress: string;
  passportAddress: string;
  gateAddress: string;
  attestTxHash: string;
  mintTxHash: string;
  tokenId: string | null;
  metadataURI: string;
  explorerBase: string;
  source: "onchain" | "fallback";
}
