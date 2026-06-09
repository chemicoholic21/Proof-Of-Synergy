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
