/**
 * Canonical models exchanged with the memory layer. These are stable; the graph representation may
 * evolve underneath them.
 */

import { SkillLevel } from "@/lib/types";

export interface MemorySkill {
  name: string;
  category?: string;
  claimedLevel: SkillLevel;
}

export interface MemoryProject {
  name: string;
  technologies?: string[];
  summary?: string;
}

/** What remember() needs to ingest a resume (v1, v2, ...). */
export interface RememberResumeInput {
  candidateId: string;
  name?: string | null;
  skills: MemorySkill[];
  experience?: { role: string; company: string; years: number }[];
  education?: { degree: string; institution: string; year: number | null }[];
  projects?: MemoryProject[];
  /** raw resume text — used for Cognee ingestion + light project extraction */
  rawText?: string;
}

/** One answered question, already transcribed + evaluated. */
export interface RememberAnswer {
  questionId: number;
  questionText: string;
  targetSkill: string;
  rubric?: string;
  transcript: string;
  language?: string;
  score: number; // 0-100
  feedback?: string;
  strengths?: string[];
  improvements?: string[];
  durationSec?: number;
}

/** What remember() needs to ingest a completed interview. */
export interface RememberInterviewInput {
  candidateId: string;
  name?: string | null;
  company?: string | null;
  answers: RememberAnswer[];
}

/** The Career Reasoner's answer — everything an adaptive interview or dashboard needs. */
export interface RecallResult {
  candidateId: string;
  isNew: boolean; // no interview history yet
  weakConcepts: RecalledConcept[]; // low confidence
  forgottenConcepts: RecalledConcept[]; // decayed retention (spaced repetition due)
  unverifiedSkills: string[]; // claimed but never tested
  weakEvidenceClaims: string[]; // claimed high but evidence thin
  strongConcepts: RecalledConcept[]; // recently improved / high confidence
  undiscussedProjects: string[]; // in resume, never talked about
  masteredConcepts: string[]; // stop asking beginner questions about these
  upcomingCompany: string | null;
  interviewCount: number;
  /** ready-made natural-language directives to steer question generation */
  focusDirectives: string[];
  /** optional Cognee semantic answer when a real backend is configured */
  cogneeInsight?: string | null;
}

export interface RecalledConcept {
  name: string;
  confidence: number;
  retention: number;
  lastSeenDays: number;
  reason: string;
}
