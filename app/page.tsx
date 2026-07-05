"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import VoiceRecorder from "@/components/VoiceRecorder";
import QuestionPlayer from "@/components/QuestionPlayer";
import Shuffle from "@/components/bits/Shuffle";
import { aggregateConfidence, buildVerdicts, overallScore } from "@/lib/verify";
import { getCandidateId, setCandidateName, saveGraphLocal, loadGraphLocal } from "@/lib/candidate";
import {
  ParsedResume,
  InterviewQuestion,
  Transcript,
  QuestionEvaluation,
  SkillVerdict,
} from "@/lib/types";

/** Summary of what recall() steered + what improve() grew, surfaced so Cognee is visibly central. */
interface RecallSummary {
  interviewCount: number;
  focusDirectives: string[];
  weakConcepts: { name: string; confidence: number }[];
  forgottenConcepts: { name: string; lastSeenDays: number }[];
  unverifiedSkills: string[];
  masteredConcepts: string[];
  upcomingCompany: string | null;
  cogneeInsight?: string | null;
}
interface ImproveSummary {
  newEdges: number;
  newRecommendations: number;
  milestones: string[];
  weakConceptsHighlighted: string[];
  revision: number;
}

type Step = "intro" | "upload" | "interview" | "results";

/** Parse a JSON response, throwing a readable error when the API returns a non-2xx status. */
async function readJsonOrThrow(res: Response): Promise<any> {
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(data?.requestId ? `${msg} [${data.requestId}]` : msg);
  }
  return data;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong. Please try again.";
}

const STATUS_STYLE: Record<string, { border: string; bg: string; text: string; label: string; glow: string }> = {
  strong: {
    border: "border-emerald-500/30",
    bg: "bg-emerald-950/20",
    text: "text-emerald-400",
    label: "Highly Demonstrated",
    glow: "shadow-[0_0_15px_rgba(16,185,129,0.15)]",
  },
  verified: {
    border: "border-cyan-500/30",
    bg: "bg-cyan-950/20",
    text: "text-cyan-400",
    label: "Developing",
    glow: "shadow-[0_0_15px_rgba(6,182,212,0.15)]",
  },
  exaggerated: {
    border: "border-amber-500/40",
    bg: "bg-amber-950/25",
    text: "text-amber-400",
    label: "Needs More Evidence",
    glow: "shadow-[0_0_15px_rgba(245,158,11,0.15)]",
  },
};

export default function Home() {
  const [step, setStep] = useState<Step>("intro");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [resume, setResume] = useState<ParsedResume | null>(null);
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [questionsNotice, setQuestionsNotice] = useState<string | null>(null);
  // Each answer is one or more ordered audio segments (long answers are split to fit the 30s
  // real-time STT limit and stitched back together server-side).
  const [answers, setAnswers] = useState<Record<number, Blob[]>>({});
  // Per-question recording duration (seconds) → speech-rate (WPM) in Interview DNA.
  const [durations, setDurations] = useState<Record<number, number>>({});
  const [transcripts, setTranscripts] = useState<Record<number, Transcript>>({});
  const [evaluations, setEvaluations] = useState<QuestionEvaluation[]>([]);
  const [verdicts, setVerdicts] = useState<SkillVerdict[]>([]);

  // Cognee memory wiring: a stable per-browser candidate id + the recall/improve summaries so the
  // UI can show the memory lifecycle working (adaptive questions in, graph growth out).
  const [candidateId, setCandidateId] = useState<string>("anon");
  const [recallSummary, setRecallSummary] = useState<RecallSummary | null>(null);
  const [improveSummary, setImproveSummary] = useState<ImproveSummary | null>(null);
  useEffect(() => setCandidateId(getCandidateId()), []);

  const overall = useMemo(
    () => (evaluations.length ? overallScore(aggregateConfidence(evaluations)) : 0),
    [evaluations]
  );

  async function handleUpload(file: File) {
    setError(null);
    setBusy("Extracting resume skills with Sarvam AI…");
    const fd = new FormData();
    fd.append("file", file);
    try {
      const res = await fetch("/api/parse-resume", { method: "POST", body: fd });
      const r: ParsedResume = await readJsonOrThrow(res);
      setResume(r);

      // Promote identity from the resume name so memory is stable across sessions, then remember()
      // the resume into the Career Knowledge Graph BEFORE generating questions.
      const cid = r.name ? setCandidateName(r.name) : getCandidateId();
      setCandidateId(cid);
      setBusy("remember() - writing your resume into the Career Knowledge Graph…");
      try {
        const memRes = await fetch("/api/memory/remember", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "resume", candidateId: cid, name: r.name, skills: r.skills, experience: r.experience, education: r.education, graph: loadGraphLocal(cid) }),
        });
        const mem = await memRes.json().catch(() => null);
        if (mem?.graph) saveGraphLocal(cid, mem.graph); // browser is the durable source of truth
      } catch {
        /* memory is additive; never block the interview if it fails */
      }

      setBusy("recall() - consulting memory to personalize this interview…");
      const qRes = await fetch("/api/generate-questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skills: r.skills, candidateId: cid, graph: loadGraphLocal(cid) }),
      });
      const q = await readJsonOrThrow(qRes);
      setQuestions(q.questions);
      setRecallSummary(q.recall ?? null);
      setQuestionsNotice(
        q.source === "fallback"
          ? q.reason ?? "Live question generation is unavailable, so these were generated from your resume skills in demo mode."
          : null
      );
      setBusy(null);
      setStep("interview");
    } catch (err) {
      console.error(err);
      setBusy(null);
      setError(errMessage(err));
    }
  }

  function useSampleResume() {
    const blob = new File([SAMPLE_RESUME_TEXT], "sample-resume.txt", { type: "text/plain" });
    handleUpload(blob);
  }

  async function finishInterview() {
    setError(null);
    setBusy("Transcribing responses with Saarika ASR…");
    try {
      const newTranscripts: Record<number, Transcript> = {};
      for (const q of questions) {
        const fd = new FormData();
        fd.append("questionId", String(q.id));
        const segments = answers[q.id] ?? [];
        segments.forEach((seg, i) => fd.append("audio", seg, `answer-${q.id}-${i}.webm`));
        const tRes = await fetch("/api/transcribe", { method: "POST", body: fd });
        const t: Transcript = await readJsonOrThrow(tRes);
        newTranscripts[q.id] = t;
      }
      setTranscripts(newTranscripts);

      setBusy("Evaluating linguistic depth & knowledge points with Sarvam AI…");
      const items = questions.map((q) => ({ question: q, answer: newTranscripts[q.id]?.text ?? "" }));
      const evRes = await fetch("/api/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ items }),
      });
      const ev = await readJsonOrThrow(evRes);
      const evals: QuestionEvaluation[] = ev.evaluations;
      setEvaluations(evals);

      const conf = aggregateConfidence(evals);
      setVerdicts(buildVerdicts(resume!.skills, conf));

      // The interview-complete pipeline: remember() this interview + improve() the graph. This is
      // the moment the candidate's memory permanently grows.
      setBusy("remember() + improve() - updating your Career Knowledge Graph…");
      try {
        const answersPayload = questions.map((q) => {
          const ev = evals.find((e) => e.questionId === q.id);
          return {
            questionId: q.id,
            questionText: q.text,
            targetSkill: q.targetSkill,
            rubric: q.rubric,
            transcript: newTranscripts[q.id]?.text ?? "",
            language: newTranscripts[q.id]?.language,
            score: ev?.score ?? 0,
            feedback: ev?.feedback,
            strengths: ev?.strengths,
            improvements: ev?.improvements,
            durationSec: durations[q.id],
          };
        });
        const memRes = await fetch("/api/memory/remember", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ kind: "interview", candidateId, name: resume?.name ?? null, company: recallSummary?.upcomingCompany ?? null, answers: answersPayload, graph: loadGraphLocal(candidateId) }),
        });
        const mem = await memRes.json().catch(() => null);
        if (mem?.graph) saveGraphLocal(candidateId, mem.graph); // persist so the dashboard sees it
        if (mem?.improve) setImproveSummary(mem.improve);
      } catch {
        /* memory is additive; results still render if it fails */
      }

      setBusy(null);
      setStep("results");
    } catch (err) {
      console.error(err);
      setBusy(null);
      setError(errMessage(err));
    }
  }

  const allRecorded = questions.length > 0 && questions.every((q) => (answers[q.id]?.length ?? 0) > 0);

  return (
    <div className="min-h-screen relative overflow-hidden bg-black">
      {/* The Hangover Part AI - solving AI amnesia */}
      <div className="absolute inset-0 -z-10 opacity-10">
        <img src="/hangover-bg.svg" alt="" className="w-full h-full object-cover" />
      </div>

      <main className="mx-auto w-full max-w-6xl px-6 sm:px-10 lg:px-16 py-10 relative z-10">
        <Header step={step} />

        {busy && (
          <div className="mb-8 flex items-center gap-4 glass-card pulse-glow-active px-6 py-4.5 text-[15px] border-purple-500/25 bg-purple-950/15 text-purple-200 rounded-2xl">
            <span className="relative flex h-4.5 w-4.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#c8beac] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-4.5 w-4.5 bg-[#c8beac]"></span>
            </span>
            <span className="font-mono tracking-wide font-medium">{busy}</span>
          </div>
        )}

        {error && !busy && (
          <div
            role="alert"
            className="mb-8 flex items-start gap-4 glass-card px-6 py-4.5 text-[15px] border-red-500/30 bg-red-950/20 text-red-200 rounded-2xl"
          >
            <span className="mt-0.5 text-lg">⚠️</span>
            <div className="flex-1">
              <p className="font-mono tracking-wide font-medium">{error}</p>
            </div>
            <button
              onClick={() => setError(null)}
              className="text-red-300/70 hover:text-red-200 transition-colors"
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        )}

        {step === "intro" && (
          <div className="step-container">
            <Intro onStart={() => setStep("upload")} />
          </div>
        )}

        {step === "upload" && (
          <div className="step-container">
            <Card>
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h2 className="heading-font text-2xl font-bold tracking-tight text-white">Upload Candidate Credentials</h2>
                  <p className="mt-1 text-sm text-zinc-400">
                    Submit professional resumes or skill profiles in PDF, text, or image formats.
                  </p>
                </div>
                <span className="hidden sm:inline-flex rounded-full bg-purple-500/10 px-3 py-1 text-xs font-semibold text-purple-300 border border-purple-500/20">
                  Step 1 of 4
                </span>
              </div>

              {/* Upload Dropzone */}
              <label className="group relative flex flex-col items-center justify-center rounded-3xl border-2 border-dashed border-zinc-800 bg-white/[0.01] px-6 py-12 text-center transition-all duration-300 hover:border-purple-500/50 hover:bg-white/[0.02] cursor-pointer">
                <input
                  type="file"
                  accept=".pdf,.docx,.png,.jpg,.jpeg,.txt"
                  disabled={!!busy}
                  onChange={(e) => e.target.files?.[0] && handleUpload(e.target.files[0])}
                  className="sr-only"
                />
                <div className="rounded-full bg-purple-500/10 p-4 mb-4 text-[#c8beac] group-hover:scale-110 transition-transform duration-300 border border-purple-500/20 group-hover:border-purple-500/40">
                  <svg className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M12 16.5V9.75m0 0 3 3m-3-3-3 3M6.75 19.5a4.5 4.5 0 0 1-1.41-8.775 5.25 5.25 0 0 1 10.233-2.33 3 3 0 0 1 3.758 3.848A3.752 3.752 0 0 1 18 19.5H6.75Z" />
                  </svg>
                </div>
                <span className="font-semibold text-zinc-200 text-base">Drag & drop resume here</span>
                <span className="mt-1 text-xs text-zinc-500">Supports PDF, DOCX, TXT, or images up to 10MB</span>
                <span className="btn-ghost mt-6 text-xs px-4 py-2 hover:bg-white/10">Browse local files</span>
              </label>

              {/* Sample Profile Button */}
              <div className="mt-8 pt-6 border-t border-zinc-900 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                <div>
                  <h4 className="text-sm font-semibold text-zinc-300">Testing Sandbox Mode</h4>
                  <p className="text-xs text-zinc-500">Don&apos;t have a resume handy? Try out our pre-configured evaluation profile.</p>
                </div>
                <button
                  onClick={useSampleResume}
                  disabled={!!busy}
                  className="flex items-center justify-center gap-2 rounded-full border border-purple-500/30 bg-purple-950/10 px-5 py-2.5 text-xs font-semibold text-purple-300 hover:bg-purple-950/20 hover:border-purple-500/50 transition-all duration-300"
                >
                  <span>Use Sample Profile (Aarav Sharma)</span>
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                  </svg>
                </button>
              </div>
            </Card>
          </div>
        )}

        {step === "interview" && resume && (
          <div className="step-container flex flex-col gap-6">
            {recallSummary && recallSummary.interviewCount > 0 && (
              <div className="rounded-2xl border border-cyan-500/25 bg-cyan-950/10 px-5 py-4">
                <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-cyan-300">
                  <span>recall()</span>
                  <span className="text-zinc-500 normal-case tracking-normal font-normal">
                    · personalized from {recallSummary.interviewCount} past interview{recallSummary.interviewCount === 1 ? "" : "s"}
                  </span>
                </div>
                <p className="mt-1.5 text-[13px] text-zinc-300">
                  This interview is <b className="text-cyan-200">not random</b>. Cognee steered it using your history:
                </p>
                <ul className="mt-1.5 space-y-0.5 text-[12px] text-zinc-400 list-disc pl-4">
                  {recallSummary.focusDirectives.slice(0, 4).map((d, i) => (
                    <li key={i}>{d}</li>
                  ))}
                </ul>
                {recallSummary.cogneeInsight && (
                  <div className="mt-3 rounded-lg border border-cyan-500/20 bg-black/30 p-3">
                    <div className="text-[10px] uppercase tracking-widest font-bold text-[#c8beac]">
                      Cognee graph · search()
                    </div>
                    <p className="mt-1 text-[12px] text-zinc-300 whitespace-pre-line">{recallSummary.cogneeInsight}</p>
                  </div>
                )}
              </div>
            )}
            {resume.source === "fallback" && (
              <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-950/20 px-5 py-4 text-amber-200">
                <svg className="h-5 w-5 shrink-0 mt-0.5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <div className="text-sm leading-relaxed">
                  <span className="font-bold text-amber-300">Demo mode: your uploaded document was not parsed.</span>{" "}
                  {resume.reason ?? "The AI parsing service is unavailable, so a sample profile is shown instead."}{" "}
                  Showing the sample profile (Aarav Sharma) below.
                </div>
              </div>
            )}
            {resume.source !== "fallback" && questionsNotice && (
              <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-950/20 px-5 py-4 text-amber-200">
                <svg className="h-5 w-5 shrink-0 mt-0.5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <div className="text-sm leading-relaxed">
                  <span className="font-bold text-amber-300">Questions generated in demo mode.</span>{" "}
                  Your resume was parsed, but live question generation was unavailable, so these
                  questions were derived from your listed skills. {questionsNotice}
                </div>
              </div>
            )}
            <Card>
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-purple-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-purple-500 animate-pulse" />
                    Interactive AI Interview Room
                  </div>
                  <h2 className="heading-font mt-2 text-2xl font-bold tracking-tight text-white">
                    {resume.name ? `${resume.name} · Credentials Evaluation` : "Candidate Assessment"}
                  </h2>
                </div>
                {resume.source === "fallback" && (
                  <span className="self-start rounded-full bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-400 border border-amber-500/20">
                    Demo Mode
                  </span>
                )}
              </div>

              <p className="mt-4 text-[14px] leading-relaxed text-zinc-400">
                The AI has extracted your skill credentials. To build your career memory, please answer the questions below out loud in <b className="text-zinc-200">any Indian language</b> (e.g. Hindi, Tamil, Telugu, Kannada, Bengali, etc.). Our Saarika transcription pipeline will auto-detect and translate it.
              </p>

              <div className="mt-6">
                <div className="text-xs font-bold uppercase tracking-wider text-zinc-500 mb-2">Claimed Resume Skills</div>
                <div className="flex flex-wrap gap-2.5">
                  {resume.skills.map((s) => (
                    <span key={s.name} className="chip">
                      <span className="text-zinc-400 font-normal mr-1">{s.name}:</span>
                      <span className="font-semibold text-purple-300">{s.claimedLevel}</span>
                    </span>
                  ))}
                </div>
              </div>
            </Card>

            <div className="flex flex-col gap-4">
              {questions.map((q) => {
                const isRecorded = (answers[q.id]?.length ?? 0) > 0;
                return (
                  <div
                    key={q.id}
                    className={`glass-card p-6 border transition-all duration-300 ${
                      isRecorded ? "border-purple-500/35 bg-purple-950/5" : "border-zinc-800 bg-black/40"
                    }`}
                  >
                    <div className="mb-4 flex items-start gap-4">
                      <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-2xl text-sm font-bold border transition-colors duration-300 ${
                        isRecorded 
                          ? "bg-purple-500/20 border-purple-500/40 text-purple-300"
                          : "bg-zinc-900 border-zinc-800 text-zinc-400"
                      }`}>
                        Q{q.id}
                      </span>
                      <div className="flex-1">
                        <div className="flex items-start justify-between gap-3">
                          <p className="font-medium text-[15px] leading-relaxed text-zinc-100">{q.text}</p>
                          <div className="shrink-0">
                            <QuestionPlayer text={q.text} />
                          </div>
                        </div>
                        <div className="mt-2 flex items-center gap-1.5 text-xs text-zinc-500">
                          <span>Target Attribute ·</span>
                          <span className="rounded-full bg-zinc-900 px-2.5 py-0.5 font-medium text-zinc-400 border border-zinc-800">{q.targetSkill}</span>
                        </div>
                      </div>
                    </div>
                    
                    <div className="pl-12">
                      <VoiceRecorder
                        disabled={!!busy}
                        onRecorded={(blobs, durationSec) => {
                          setAnswers((a) => ({ ...a, [q.id]: blobs }));
                          setDurations((d) => ({ ...d, [q.id]: durationSec }));
                        }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={finishInterview}
              disabled={!allRecorded || !!busy}
              className={`w-full py-4 text-base font-medium transition-colors duration-200 ${
                allRecorded
                  ? "btn-primary"
                  : "rounded-full border border-zinc-800 text-zinc-500 cursor-not-allowed"
              }`}
            >
              {allRecorded ? (
                <span className="flex items-center justify-center gap-2">
                  <span>Complete & Evaluate Responses</span>
                  <svg className="h-5 w-5 animate-pulse" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
                  </svg>
                </span>
              ) : (
                "Record all answers to calculate score"
              )}
            </button>
          </div>
        )}

        {step === "results" && (
          <div className="step-container flex flex-col gap-6">
            <div className="glass-card px-6 py-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-purple-300">
                    <span>remember() + improve()</span>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    <span className="text-emerald-400 normal-case tracking-normal">graph updated</span>
                  </div>
                  <p className="mt-1.5 text-[14px] text-zinc-200">
                    This interview is now <b>permanent memory</b>.
                    {improveSummary && (
                      <>
                        {" "}Your Career Knowledge Graph grew by <b className="text-purple-200">+{improveSummary.newEdges} relationships</b>
                        {improveSummary.newRecommendations > 0 && <> and <b className="text-purple-200">{improveSummary.newRecommendations} learning resources</b></>}.
                      </>
                    )}
                  </p>
                  {improveSummary && improveSummary.milestones.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {improveSummary.milestones.map((m, i) => (
                        <span key={i} className="rounded-full bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                          🎉 {m}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <Link href="/dashboard" className="btn-primary shrink-0 px-6 py-3 text-sm font-bold whitespace-nowrap">
                  🧠 View Career Memory →
                </Link>
              </div>
            </div>
            <Card>
              <div className="flex flex-col md:flex-row items-center gap-8 justify-between">
                <div>
                  <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
                    Interview Complete
                  </span>
                  <h2 className="heading-font mt-3 text-3xl font-bold tracking-tight text-white">Your Skill Snapshot</h2>
                  <p className="mt-2 text-[14px] leading-relaxed text-zinc-400">
                    Here&apos;s what you demonstrated today, grouped by how much evidence backs each skill. This is a
                    starting point - every future interview strengthens the picture. Skills with less evidence are
                    just opportunities to practise, not judgements.
                  </p>
                </div>
                
                {/* Custom SVG Radial Dashboard Score */}
                <div className="relative flex shrink-0 items-center justify-center w-36 h-36">
                  <svg className="absolute w-full h-full transform -rotate-90" viewBox="0 0 100 100">
                    <circle
                      cx="50"
                      cy="50"
                      r="40"
                      stroke="rgba(255,255,255,0.03)"
                      strokeWidth="8"
                      fill="transparent"
                    />
                    <circle
                      cx="50"
                      cy="50"
                      r="40"
                      stroke="#c8beac"
                      strokeWidth="8"
                      strokeDasharray={`${2 * Math.PI * 40}`}
                      strokeDashoffset={`${2 * Math.PI * 40 * (1 - overall / 100)}`}
                      strokeLinecap="round"
                      fill="transparent"
                    />
                  </svg>
                  <div className="text-center z-10">
                    <div className="text-4xl font-semibold heading-font tracking-tight text-ink">
                      {overall}%
                    </div>
                    <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500 mt-0.5">
                      Confidence
                    </div>
                  </div>
                </div>
              </div>
            </Card>

            <div className="space-y-4">
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-500">Skill-by-skill evidence</h3>
              {verdicts.map((v) => {
                const cfg = STATUS_STYLE[v.status] || STATUS_STYLE.verified;
                return (
                  <div
                    key={v.skill}
                    className={`cyber-card-attestation rounded-2xl border px-6 py-5 transition-all duration-300 ${cfg.border} ${cfg.glow}`}
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-lg font-bold text-white heading-font">{v.skill}</span>
                          <span className="rounded-full bg-zinc-900 border border-zinc-800 px-2 py-0.5 text-xs text-zinc-400 font-medium">
                            claimed: {v.claimedLevel}
                          </span>
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 text-xs text-zinc-500">
                          <svg className={`h-4 w-4 ${cfg.text}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                            {v.status === "exaggerated" ? (
                              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                            ) : (
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12c0 1.268-.63 2.39-1.593 3.068a3.745 3.745 0 0 1-1.043 3.296 3.745 3.745 0 0 1-3.296 1.043A3.745 3.745 0 0 1 12 21c-1.268 0-2.39-.63-3.068-1.593a3.746 3.746 0 0 1-3.296-1.043 3.745 3.745 0 0 1-1.043-3.296A3.745 3.745 0 0 1 3 12c0-1.268.63-2.39 1.593-3.068a3.745 3.745 0 0 1 1.043-3.296 3.746 3.746 0 0 1 3.296-1.043A3.746 3.746 0 0 1 12 3c1.268 0 2.39.63 3.068 1.593a3.746 3.746 0 0 1 3.296 1.043 3.746 3.746 0 0 1 1.043 3.296A3.745 3.745 0 0 1 21 12Z" />
                            )}
                          </svg>
                          <span className={`font-semibold ${cfg.text}`}>{cfg.label}</span>
                        </div>
                      </div>

                      <div className="text-left sm:text-right">
                        <div className={`text-2xl font-black heading-font ${cfg.text}`}>
                          {v.observedConfidence}%
                        </div>
                        <div className="text-xs text-zinc-500 font-medium uppercase tracking-wider">Observed Score</div>
                      </div>
                    </div>

                    {v.flag && (
                      <p className="mt-3.5 rounded-lg bg-black/40 border border-zinc-800/80 px-4 py-2.5 text-xs text-zinc-400 leading-relaxed">
                        {v.flag}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Per-Question Details Collapse */}
            <details className="group glass-card border border-zinc-850 rounded-2xl overflow-hidden [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex items-center justify-between cursor-pointer p-5 text-zinc-300 font-semibold hover:bg-white/[0.02] transition-colors duration-300 select-none">
                <span className="flex items-center gap-2">
                  <svg className="h-4.5 w-4.5 text-[#c8beac]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m5.23 13.44-1.59 1.59-3.577-3.577m0 0-1.59 1.59L4.156 12.01m3.111 3.111L12.022 10.5M9 4.5h4.5a1.125 1.125 0 0 1 1.125 1.125V9A1.125 1.125 0 0 0 15.75 10.125H18a1.125 1.125 0 0 1 1.125 1.125v.875" />
                  </svg>
                  Per-Question Transcripts & Evaluation Detail
                </span>
                <span className="transition-transform duration-300 group-open:rotate-180">
                  <svg className="h-4.5 w-4.5 text-zinc-500" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="m19.5 8.25-7.5 7.5-7.5-7.5" />
                  </svg>
                </span>
              </summary>
              <div className="p-5 border-t border-zinc-900 bg-black/60 flex flex-col gap-5">
                {evaluations.map((e) => (
                  <div key={e.questionId} className="first:mt-0 mt-2 border-t border-zinc-900 first:border-0 pt-4 first:pt-0">
                    <div className="flex justify-between items-start">
                      <span className="font-semibold text-zinc-200 text-sm">{e.targetSkill}</span>
                      <span className="rounded bg-purple-500/10 px-2 py-0.5 text-xs font-mono font-semibold text-purple-300 border border-purple-500/25">
                        {e.score}/100
                      </span>
                    </div>
                    <p className="mt-2 text-xs text-zinc-400 leading-relaxed bg-zinc-950/40 p-3 rounded-lg border border-zinc-900">
                      {e.feedback}
                    </p>
                    {transcripts[e.questionId] && (
                      <p className="mt-2 text-xs font-medium text-[#c8beac] flex items-center gap-1.5">
                        <span className="shrink-0 rounded bg-cyan-500/10 px-1.5 py-0.5 text-[10px] uppercase font-bold text-cyan-300 border border-cyan-500/20">
                          {transcripts[e.questionId].language}
                        </span>
                        <span className="italic">“{transcripts[e.questionId].text}”</span>
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </details>

            {/* Terminal action: the interview is now permanent memory. */}
            <Card>
              <div className="flex flex-col sm:flex-row items-center justify-between gap-5">
                <div>
                  <h3 className="heading-font text-lg font-bold text-white flex items-center gap-2">
                    <span>🧠</span> Saved to your Career Memory
                  </h3>
                  <p className="mt-2 max-w-lg text-[13px] leading-relaxed text-zinc-400">
                    This interview is now part of your Cognee Career Knowledge Graph. Your{" "}
                    <span className="text-zinc-200">next interview adapts</span> to what you demonstrated here,
                    and your dashboard shows the evidence, reality gap and learning roadmap that grew from it.
                    Your raw resume and voice recordings never leave this session.
                  </p>
                </div>
                <div className="flex flex-col gap-2 w-full sm:w-auto shrink-0">
                  <Link
                    href="/dashboard"
                    className="btn-primary px-6 py-3 text-sm font-bold text-center whitespace-nowrap"
                  >
                    🧠 Open Career Memory →
                  </Link>
                  <button onClick={() => location.reload()} className="btn-ghost px-6 py-3 text-sm">
                    New interview
                  </button>
                </div>
              </div>
            </Card>
          </div>
        )}
      </main>
    </div>
  );
}

function Header({ step }: { step: Step }) {
  const steps: Step[] = ["upload", "interview", "results"];
  const stepLabels = ["Parse Resume", "Interview Room", "Results & Memory"];
  const idx = steps.indexOf(step);
  
  return (
    <header className="mb-10">
      <div className="flex items-center justify-between gap-4 border-b border-line pb-5">
        <Link href="/" className="heading-font text-lg tracking-tight text-ink hover:text-white transition-colors">
          Proof of Synergy
        </Link>

        <nav className="flex items-center gap-5">
          <Link
            href="/dashboard"
            className="text-sm text-ink border-b border-transparent hover:border-accent pb-0.5 transition-colors"
          >
            Career Memory <span className="text-ink-soft">→</span>
          </Link>
        </nav>
      </div>

      {/* Minimal step indicator */}
      {idx >= 0 && (
        <div className="mt-6 flex items-center gap-4">
          {steps.map((s, i) => {
            const isActive = i <= idx;
            const isCurrent = i === idx;
            return (
              <div key={s} className="flex items-center gap-2.5">
                <span className={`font-mono text-[11px] tabular-nums ${isCurrent ? "text-accent" : isActive ? "text-ink" : "text-ink-soft/50"}`}>
                  {String(i + 1).padStart(2, "0")}
                </span>
                <span className={`text-xs ${isCurrent ? "text-ink" : isActive ? "text-ink-soft" : "text-ink-soft/50"}`}>
                  {stepLabels[i]}
                </span>
                {i < steps.length - 1 && <span className={`h-px w-8 ${i < idx ? "bg-accent" : "bg-line"}`} />}
              </div>
            );
          })}
        </div>
      )}
    </header>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  const features = [
    { k: "forget()", t: "What did you miss?", d: "We surface gaps you forgot, so you can fill them." },
    { k: "gap()", t: "What did they overlook?", d: "Interviewers miss what matters - we find it." },
    { k: "remember()", t: "Never forget again", d: "Your Career Knowledge Graph stores everything permanently." },
  ];
  return (
    <div className="relative py-6 sm:py-10">
      <div className="fade-up flex items-center gap-3" style={{ animationDelay: "60ms" }}>
        <span className="h-px w-8 bg-accent/60 hairline-grow" style={{ animationDelay: "60ms" }} />
        <span className="text-[11px] uppercase tracking-[0.25em] text-ink-soft">The Hangover Part AI</span>
      </div>

      <Shuffle
        as="h1"
        text={"What did you forget?\nWhat did they miss?\nWe remember what matters."}
        stagger={26}
        scrambleMs={240}
        start={160}
        className="heading-font mt-8 block text-[2.5rem] leading-[1.06] tracking-tight text-ink sm:text-[3.5rem] lg:text-[4rem]"
      />

      <p className="fade-up mt-8 max-w-2xl text-base leading-relaxed text-ink-soft sm:text-[17px]" style={{ animationDelay: "620ms" }}>
        Upload your resume, take a voice interview in any Indian language, and watch your answers become
        more than facts - your Career Memory grows permanently, making you better at every attempt.
      </p>

      <div className="fade-up mt-9 flex flex-col sm:flex-row gap-3" style={{ animationDelay: "740ms" }}>
        <button onClick={onStart} className="btn-primary px-8 py-3.5 text-base flex items-center justify-center gap-2">
          <span>Begin</span>
          <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
          </svg>
        </button>
        <Link href="/dashboard" className="btn-ghost px-8 py-3.5 text-base flex items-center justify-center gap-2">
          View Hangover Memory
        </Link>
      </div>

      <div className="mt-16 grid gap-px overflow-hidden border-t border-line sm:grid-cols-3">
        {features.map((f, i) => (
          <div key={f.k} className="fade-up border-line pt-5 sm:pr-6 sm:[&:not(:first-child)]:border-l sm:[&:not(:first-child)]:pl-6" style={{ animationDelay: `${860 + i * 110}ms` }}>
            <div className="font-mono text-[11px] tracking-tight text-accent">{f.k}</div>
            <h3 className="heading-font mt-2 text-lg text-ink">{f.t}</h3>
            <p className="mt-1.5 text-[13px] leading-relaxed text-ink-soft">{f.d}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="glass-card p-6 sm:p-8">{children}</div>;
}

const SAMPLE_RESUME_TEXT = `Aarav Sharma | aarav.sharma@example.com
Senior Backend Engineer, FinStack (3 yrs); Software Engineer, Razorpay (2 yrs)
B.Tech Computer Science, IIT Bombay, 2019
Skills: Python (expert), AWS (advanced), React (advanced), Kubernetes (advanced)
Projects: Built a high-throughput trading service in Python; event pipelines on AWS;
real-time dashboards in React; deployments on Kubernetes.`;
