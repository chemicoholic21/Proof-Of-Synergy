"use client";

import { useMemo, useState } from "react";
import VoiceRecorder from "@/components/VoiceRecorder";
import QuestionPlayer from "@/components/QuestionPlayer";
import { aggregateConfidence, buildVerdicts, overallScore } from "@/lib/verify";
import {
  ParsedResume,
  InterviewQuestion,
  Transcript,
  QuestionEvaluation,
  SkillVerdict,
  MintResult,
} from "@/lib/types";

type Step = "intro" | "upload" | "interview" | "results" | "passport" | "private";

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
    label: "Expert Verified",
    glow: "shadow-[0_0_15px_rgba(16,185,129,0.15)]",
  },
  verified: {
    border: "border-cyan-500/30",
    bg: "bg-cyan-950/20",
    text: "text-cyan-400",
    label: "Skills Verified",
    glow: "shadow-[0_0_15px_rgba(6,182,212,0.15)]",
  },
  exaggerated: {
    border: "border-amber-500/40",
    bg: "bg-amber-950/25",
    text: "text-amber-400",
    label: "Flagged Discrepancy",
    glow: "shadow-[0_0_15px_rgba(245,158,11,0.15)]",
  },
};

export default function Home() {
  const [step, setStep] = useState<Step>("intro");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [resume, setResume] = useState<ParsedResume | null>(null);
  const [questions, setQuestions] = useState<InterviewQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<number, Blob>>({});
  const [transcripts, setTranscripts] = useState<Record<number, Transcript>>({});
  const [evaluations, setEvaluations] = useState<QuestionEvaluation[]>([]);
  const [verdicts, setVerdicts] = useState<SkillVerdict[]>([]);
  const [mint, setMint] = useState<MintResult | null>(null);
  const [consent, setConsent] = useState(false);

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

      setBusy("Analyzing skill vectors & generating questions…");
      const qRes = await fetch("/api/generate-questions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ skills: r.skills }),
      });
      const q = await readJsonOrThrow(qRes);
      setQuestions(q.questions);
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
        const blob = answers[q.id];
        if (blob) fd.append("audio", blob, `answer-${q.id}.webm`);
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
      setBusy(null);
      setStep("results");
    } catch (err) {
      console.error(err);
      setBusy(null);
      setError(errMessage(err));
    }
  }

  async function handleMint() {
    // The candidate must explicitly opt in before anything is published publicly on-chain.
    if (!consent) {
      setError("Please confirm your consent before publishing results on the blockchain.");
      return;
    }
    setError(null);
    setBusy("Publishing proofs to IPFS & minting SBT on Monad Sandbox…");
    try {
      const mRes = await fetch("/api/mint", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ verdicts, overall, name: resume?.name ?? "Anonymous", consent: true }),
      });
      const m: MintResult = await readJsonOrThrow(mRes);
      setMint(m);
      setBusy(null);
      setStep("passport");
    } catch (err) {
      console.error(err);
      setBusy(null);
      setError(errMessage(err));
    }
  }

  // Candidate opts out of publishing — keep the report private, nothing is written on-chain.
  function keepPrivate() {
    setError(null);
    setMint(null);
    setStep("private");
  }

  const allRecorded = questions.length > 0 && questions.every((q) => answers[q.id]);

  return (
    <div className="min-h-screen relative overflow-hidden">
      {/* Background grids and lighting */}
      <div className="cyber-bg" />
      <div className="cyber-glow-1" />
      <div className="cyber-glow-2" />
      <div className="cyber-glow-3" />

      <main className="mx-auto max-w-3xl px-5 py-12 relative z-10">
        <Header step={step} />

        {busy && (
          <div className="mb-8 flex items-center gap-4 glass-card pulse-glow-active px-6 py-4.5 text-[15px] border-purple-500/25 bg-purple-950/15 text-purple-200 rounded-2xl">
            <span className="relative flex h-4.5 w-4.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#a855f7] opacity-75"></span>
              <span className="relative inline-flex rounded-full h-4.5 w-4.5 bg-[#836ef9]"></span>
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
                <div className="rounded-full bg-purple-500/10 p-4 mb-4 text-[#a855f7] group-hover:scale-110 transition-transform duration-300 border border-purple-500/20 group-hover:border-purple-500/40">
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
            {resume.source === "fallback" && (
              <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-950/20 px-5 py-4 text-amber-200">
                <svg className="h-5 w-5 shrink-0 mt-0.5 text-amber-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
                </svg>
                <div className="text-sm leading-relaxed">
                  <span className="font-bold text-amber-300">Demo mode — your uploaded document was not parsed.</span>{" "}
                  {resume.reason ?? "The AI parsing service is unavailable, so a sample profile is shown instead."}{" "}
                  Showing the sample profile (Aarav Sharma) below.
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
                The AI has extracted your skill credentials. To complete attestations, please answer the questions below out loud in <b className="text-zinc-200">any Indian language</b> (e.g. Hindi, Tamil, Telugu, Kannada, Bengali, etc.). Our Saarika transcription pipeline will auto-detect and translate it.
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
                const isRecorded = !!answers[q.id];
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
                        onRecorded={(blob) => setAnswers((a) => ({ ...a, [q.id]: blob }))}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              onClick={finishInterview}
              disabled={!allRecorded || !!busy}
              className={`btn-primary w-full py-4 text-base font-bold shadow-lg transition-all duration-300 ${
                allRecorded 
                  ? "from-[#836ef9] to-[#a855f7] hover:scale-[1.01] hover:brightness-110 active:scale-[0.99]"
                  : "from-zinc-800 to-zinc-900 text-zinc-500 border border-zinc-800 shadow-none cursor-not-allowed"
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
            <Card>
              <div className="flex flex-col md:flex-row items-center gap-8 justify-between">
                <div>
                  <span className="rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20">
                    Verification Complete
                  </span>
                  <h2 className="heading-font mt-3 text-3xl font-bold tracking-tight text-white">Attestation Report</h2>
                  <p className="mt-2 text-[14px] leading-relaxed text-zinc-400">
                    The credentials have been cross-checked against actual responses. Flagged items indicate skill level exaggeration compared to baseline knowledge responses.
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
                      stroke="url(#purpleCyanGradient)"
                      strokeWidth="8"
                      strokeDasharray={`${2 * Math.PI * 40}`}
                      strokeDashoffset={`${2 * Math.PI * 40 * (1 - overall / 100)}`}
                      strokeLinecap="round"
                      fill="transparent"
                    />
                    <defs>
                      <linearGradient id="purpleCyanGradient" x1="0%" y1="0%" x2="100%" y2="100%">
                        <stop offset="0%" stopColor="#836ef9" />
                        <stop offset="100%" stopColor="#00E5FF" />
                      </linearGradient>
                    </defs>
                  </svg>
                  <div className="text-center z-10">
                    <div className="text-4xl font-extrabold heading-font tracking-tighter bg-gradient-to-r from-purple-300 to-cyan-300 bg-clip-text text-transparent">
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
              <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-500">Skill-by-Skill Credential Verdicts</h3>
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
                  <svg className="h-4.5 w-4.5 text-[#a855f7]" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
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
                      <p className="mt-2 text-xs font-medium text-[#00E5FF] flex items-center gap-1.5">
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

            {/* Consent gate — the candidate chooses whether to publish publicly on-chain */}
            <Card>
              <div className="flex flex-col gap-4">
                <div>
                  <h3 className="heading-font text-lg font-bold text-white flex items-center gap-2">
                    <span>🔐</span> Your data, your choice
                  </h3>
                  <p className="mt-2 text-[13px] leading-relaxed text-zinc-400">
                    Publishing mints a soulbound Skill Passport on the Monad blockchain. This makes your{" "}
                    <span className="text-zinc-200">skill names and verified confidence scores</span> public,
                    portable and permanent — anyone can verify them without going through us. Your{" "}
                    <span className="text-zinc-200">raw resume and voice recordings are never published</span>;
                    only the summarized results leave this session. Publishing is optional — you can keep your
                    report private instead.
                  </p>
                </div>

                <label className="flex items-start gap-3 cursor-pointer rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 hover:border-purple-500/30 transition-colors">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 accent-[#836ef9]"
                  />
                  <span className="text-[13px] leading-relaxed text-zinc-300">
                    I consent to publishing my verified skill results publicly and permanently on the Monad
                    blockchain. I understand this action cannot be undone.
                  </span>
                </label>

                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    onClick={handleMint}
                    disabled={!!busy || !consent}
                    className="btn-primary flex-1 py-4 text-base font-bold tracking-wider hover:brightness-110 active:scale-[0.99] flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(131,110,249,0.4)] disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none"
                  >
                    <span>Publish on Blockchain</span>
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.75h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
                    </svg>
                  </button>
                  <button
                    onClick={keepPrivate}
                    disabled={!!busy}
                    className="flex-1 py-4 text-base font-semibold tracking-wide rounded-xl border border-zinc-700 text-zinc-300 hover:bg-zinc-900/60 hover:text-white active:scale-[0.99] transition-colors flex items-center justify-center gap-2 disabled:opacity-40"
                  >
                    <span>Keep Private</span>
                  </button>
                </div>
              </div>
            </Card>
          </div>
        )}

        {step === "passport" && mint && (
          <div className="step-container">
            <Passport mint={mint} verdicts={verdicts} overall={overall} name={resume?.name ?? "Anonymous"} />
          </div>
        )}

        {step === "private" && (
          <div className="step-container">
            <Card>
              <div className="flex flex-col items-center text-center gap-5 py-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-zinc-700 bg-zinc-950/60 text-3xl">
                  🔒
                </div>
                <div>
                  <h2 className="heading-font text-2xl font-bold text-white">Kept Private</h2>
                  <p className="mt-2 max-w-md text-[14px] leading-relaxed text-zinc-400">
                    Nothing was published. Your verification report stays private to this session — no
                    attestation was written on-chain and no passport was minted. You can review your results
                    below, or change your mind and publish them whenever you're ready.
                  </p>
                </div>

                <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950/40 p-4 text-left">
                  <div className="flex items-center justify-between">
                    <span className="text-xs uppercase tracking-wide text-zinc-500">Overall confidence</span>
                    <span className="font-mono text-lg font-bold text-white">{overall}/100</span>
                  </div>
                  <div className="mt-3 flex flex-col gap-1.5">
                    {verdicts.map((v) => (
                      <div key={v.skill} className="flex items-center justify-between text-[13px]">
                        <span className="text-zinc-300">{v.skill}</span>
                        <span className={STATUS_STYLE[v.status]?.text ?? "text-zinc-400"}>
                          {v.observedConfidence}% · {STATUS_STYLE[v.status]?.label ?? v.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3 w-full max-w-sm">
                  <button
                    onClick={() => setStep("results")}
                    className="btn-primary flex-1 py-3.5 text-sm font-bold tracking-wider hover:brightness-110 active:scale-[0.99]"
                  >
                    Reconsider & Publish
                  </button>
                </div>
              </div>
            </Card>
          </div>
        )}

        <WhyMonad />
      </main>
    </div>
  );
}

function Header({ step }: { step: Step }) {
  const steps: Step[] = ["upload", "interview", "results", "passport"];
  const stepLabels = ["Parse Resume", "Interview Room", "Attest Report", "Skill Passport"];
  const idx = steps.indexOf(step);
  
  return (
    <header className="mb-10">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-2xl bg-[#836ef9]/15 border border-[#836ef9]/30 text-lg shadow-[0_0_15px_rgba(131,110,249,0.25)]">
            <svg className="h-5.5 w-5.5 text-[#836ef9]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.75h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
            </svg>
          </span>
          <div>
            <h1 className="heading-font text-2xl font-black tracking-tight text-white flex items-center gap-2">
              ProofOfSynergy
            </h1>
            <div className="text-[10px] tracking-widest text-[#00E5FF] uppercase font-bold">Monad Attestation Sandbox</div>
          </div>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-center">
          <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="font-mono text-xs text-zinc-400 font-semibold">Deploy Node: sandbox.monad.dev</span>
        </div>
      </div>

      <p className="mt-3 text-[14px] leading-relaxed text-zinc-400 max-w-xl">
        Portable, on-chain skill reputation on Monad — verified by AI interview nodes, not self-claimed.
      </p>

      {/* Futuristic Timeline Stepper */}
      {idx >= 0 && (
        <div className="mt-8 relative">
          {/* Progress bar background track */}
          <div className="absolute top-1/2 left-0 right-0 h-0.5 bg-zinc-900 -translate-y-1/2 z-0" />
          
          {/* Progress bar active track */}
          <div 
            className="absolute top-1/2 left-0 h-0.5 bg-gradient-to-r from-[#836ef9] to-[#00E5FF] -translate-y-1/2 z-0 transition-all duration-500" 
            style={{ width: `${(idx / (steps.length - 1)) * 100}%` }}
          />

          <div className="relative flex justify-between z-10">
            {steps.map((s, i) => {
              const isActive = i <= idx;
              const isCurrent = i === idx;
              return (
                <div key={s} className="flex flex-col items-center">
                  <div 
                    className={`grid h-8 w-8 place-items-center rounded-full text-xs font-bold font-mono transition-all duration-500 border ${
                      isCurrent
                        ? "bg-black border-[#00E5FF] text-[#00E5FF] shadow-[0_0_15px_rgba(0,229,255,0.4)] scale-110"
                        : isActive
                        ? "bg-[#836ef9] border-[#836ef9] text-black"
                        : "bg-zinc-950 border-zinc-850 text-zinc-600"
                    }`}
                  >
                    {i + 1}
                  </div>
                  <span className={`mt-2 text-[10px] font-semibold uppercase tracking-wider hidden sm:block ${
                    isCurrent ? "text-[#00E5FF]" : isActive ? "text-zinc-300" : "text-zinc-650"
                  }`}>
                    {stepLabels[i]}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </header>
  );
}

function Intro({ onStart }: { onStart: () => void }) {
  return (
    <Card>
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-purple-900/10 via-black/0 to-cyan-950/10 p-2">
        <h2 className="heading-font text-3xl font-extrabold leading-snug tracking-tight text-white sm:text-4xl">
          GitHub shows code.<br/>
          LinkedIn shows claims.<br/>
          <span className="bg-gradient-to-r from-purple-400 via-[#836ef9] to-cyan-300 bg-clip-text text-transparent">
            We verify what neither can.
          </span>
        </h2>
        
        <p className="mt-5 text-[15px] leading-relaxed text-zinc-400">
          Upload your resume credentials, undergo a secure voice-based smart interview in any Indian language, and turn your demonstrated expertise into <b className="text-zinc-200">soulbound skill attestations</b> written directly to Monad — trustlessly queryable by any recruitment app or decentralized agent.
        </p>

        {/* Feature Grid */}
        <div className="mt-8 grid gap-4 grid-cols-1 sm:grid-cols-2">
          <div className="rounded-2xl border border-white/[0.03] bg-white/[0.01] p-5 hover:border-purple-500/20 transition-colors duration-300">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20 mb-3.5">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z" />
              </svg>
            </div>
            <h3 className="font-bold text-sm text-zinc-200">Multilingual Sarvam Voice AI</h3>
            <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
              Native voice processing in local Indian languages. Translates, transcribes, and rates skill depth.
            </p>
          </div>

          <div className="rounded-2xl border border-white/[0.03] bg-white/[0.01] p-5 hover:border-cyan-500/20 transition-colors duration-300">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 mb-3.5">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5V18a2.25 2.25 0 0 1-2.25 2.25H5.25A2.25 2.25 0 0 1 3 18V7.5m18 0V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v1.5m18 0h-18M12 12h.008v.008H12V12Zm3 0h.008v.008H15V12Zm-6 0h.008v.008H9V12Zm6 3h.008v.008H15V15Zm-3 0h.008v.008H12V15Zm-3 0h.008v.008H9V15Z" />
              </svg>
            </div>
            <h3 className="font-bold text-sm text-zinc-200">Composable Monad SBTs</h3>
            <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
              Attests verified skill levels directly on-chain using Soulbound NFT tokens. Permissonless data.
            </p>
          </div>

          <div className="rounded-2xl border border-white/[0.03] bg-white/[0.01] p-5 hover:border-emerald-500/20 transition-colors duration-300 sm:col-span-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 mb-3.5">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.75h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
              </svg>
            </div>
            <h3 className="font-bold text-sm text-zinc-200">Real-Time Fraud Filter</h3>
            <p className="mt-1 text-xs text-zinc-400 leading-relaxed">
              Detects gaps between CV claiming tiers (beginner vs expert) and observed competency levels within ~90 seconds.
            </p>
          </div>
        </div>

        <button 
          onClick={onStart} 
          className="btn-primary mt-8 w-full sm:w-auto px-8 py-4 text-base font-bold shadow-lg hover:scale-102 flex items-center justify-center gap-2"
        >
          <span>Begin Verification Journey</span>
          <svg className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 4.5 21 12m0 0-7.5 7.5M21 12H3" />
          </svg>
        </button>
      </div>
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="glass-card p-6 sm:p-8">{children}</div>;
}

function Passport({
  mint,
  verdicts,
  overall,
  name,
}: {
  mint: MintResult;
  verdicts: SkillVerdict[];
  overall: number;
  name: string;
}) {
  const [gate, setGate] = useState<null | { passes: boolean; confidence: number; source: string }>(null);
  const [gateBusy, setGateBusy] = useState(false);
  const [copiedText, setCopiedText] = useState<string | null>(null);
  const strongSkill = verdicts.find((v) => v.status !== "exaggerated") ?? verdicts[0];

  async function runGate() {
    if (!strongSkill) return;
    setGateBusy(true);
    try {
      const res = await fetch("/api/gate-check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject: mint.subject, skill: strongSkill.skill, minConfidence: 80 }),
      });
      const r = await readJsonOrThrow(res);
      setGate(r);
    } catch (err) {
      console.error(err);
    } finally {
      setGateBusy(false);
    }
  }

  function handleCopy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    setCopiedText(label);
    setTimeout(() => setCopiedText(null), 2000);
  }

  const isReal = mint.source === "onchain";

  return (
    <div className="flex flex-col gap-6">
      {/* Premium On-Chain Skill Passport Card widget */}
      <div className="relative group overflow-hidden rounded-3xl bg-gradient-to-br from-zinc-950 via-[#18181b] to-zinc-900 border border-purple-500/25 p-7 shadow-[0_15px_40px_rgba(131,110,249,0.15)] flex flex-col justify-between min-h-[340px] transition-all duration-500 hover:shadow-[0_20px_50px_rgba(131,110,249,0.3)] hover:border-[#00E5FF]/40">
        
        {/* Hologram card effect & logo watermark */}
        <div className="absolute top-0 right-0 w-80 h-80 bg-gradient-to-bl from-purple-500/10 via-[#00E5FF]/5 to-transparent rounded-full blur-2xl pointer-events-none group-hover:scale-110 transition-transform duration-700" />
        
        <div className="flex items-start justify-between z-10 relative">
          <div>
            <div className="flex items-center gap-1.5">
              <svg className="h-5 w-5 text-[#836ef9]" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75 11.25 15 15 9.75m-3-7.036A11.959 11.959 0 0 1 3.598 6 11.99 11.99 0 0 0 3 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.57-.598-3.75h-.152c-3.196 0-6.1-1.248-8.25-3.285Z" />
              </svg>
              <span className="font-mono text-xs font-bold tracking-widest text-[#00E5FF]">MONAD SOULBOUND CREDENTIAL</span>
            </div>
            <h2 className="heading-font text-3xl font-extrabold text-white mt-3 leading-tight tracking-tight">
              {name}
            </h2>
          </div>

          <div className="flex flex-col items-end">
            <span className="rounded-full bg-purple-500/10 px-3 py-1 text-[11px] font-bold text-purple-400 border border-purple-500/20 uppercase tracking-wider">
              SBT Passport
            </span>
            {!isReal && (
              <span className="mt-2 text-[9px] text-amber-400 font-bold uppercase tracking-wider bg-amber-500/10 px-2.5 py-0.5 border border-amber-500/20 rounded">
                Fallback Sandbox
              </span>
            )}
          </div>
        </div>

        {/* Card Middle: Attested skill metrics */}
        <div className="z-10 relative my-6">
          <div className="text-[10px] uppercase font-bold tracking-widest text-zinc-500 mb-2">Verified Skillsets</div>
          <div className="flex flex-wrap gap-2 max-h-[85px] overflow-y-auto pr-1">
            {verdicts.map((v) => (
              <div 
                key={v.skill} 
                className={`flex items-center gap-1 text-xs rounded-full px-2.5 py-1 font-semibold border ${
                  v.status === "exaggerated" 
                    ? "bg-amber-950/20 border-amber-500/20 text-amber-400"
                    : "bg-emerald-950/20 border-emerald-500/20 text-emerald-400"
                }`}
              >
                <span>{v.status === "exaggerated" ? "⚠" : "✓"}</span>
                <span>{v.skill}</span>
                <span className="opacity-70 font-mono">({v.observedConfidence}%)</span>
              </div>
            ))}
          </div>
        </div>

        {/* Card Footer: Metadata and details */}
        <div className="z-10 relative flex items-end justify-between border-t border-white/5 pt-4.5">
          <div className="grid grid-cols-2 gap-x-8 gap-y-1">
            <div>
              <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">Subject Address</div>
              <div className="font-mono text-xs text-zinc-300 font-medium tracking-wide">
                {mint.subject.slice(0, 6)}...{mint.subject.slice(-4)}
              </div>
            </div>
            <div>
              <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">Token ID</div>
              <div className="font-mono text-xs text-zinc-300 font-bold">
                #{mint.tokenId ?? "Pending"}
              </div>
            </div>
          </div>

          <div className="text-right">
            <div className="text-[9px] uppercase tracking-wider text-zinc-500 font-semibold">Overall Attestation</div>
            <div className="text-2xl font-black heading-font text-white bg-gradient-to-r from-purple-400 to-cyan-300 bg-clip-text text-transparent">
              {overall}%
            </div>
          </div>
        </div>
      </div>

      {/* Transaction links section */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold uppercase tracking-wider text-zinc-400">On-Chain Evidence & Registry Proofs</h3>
          {copiedText && (
            <span className="text-xs font-semibold text-emerald-400 bg-emerald-500/10 px-2.5 py-0.5 border border-emerald-500/20 rounded-full">
              Copied {copiedText}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-3.5 text-sm">
          <LinkRow
            label="Attestation Transaction"
            href={`${mint.explorerBase}/tx/${mint.attestTxHash}`}
            value={mint.attestTxHash}
            enabled={isReal}
            onCopy={() => handleCopy(mint.attestTxHash, "Tx Hash")}
          />
          <LinkRow
            label="Passport Mint Transaction"
            href={`${mint.explorerBase}/tx/${mint.mintTxHash}`}
            value={mint.mintTxHash}
            enabled={isReal}
            onCopy={() => handleCopy(mint.mintTxHash, "Mint Hash")}
          />
          <LinkRow
            label="Registry Address"
            href={`${mint.explorerBase}/address/${mint.registryAddress}`}
            value={mint.registryAddress}
            enabled={isReal}
            onCopy={() => handleCopy(mint.registryAddress, "Registry Address")}
          />
          <LinkRow
            label="IPFS Metadata Evidence"
            href={mint.metadataURI}
            value={mint.metadataURI}
            enabled
            onCopy={() => handleCopy(mint.metadataURI, "Metadata URI")}
          />
        </div>
      </Card>

      {/* Composability / SkillGate interactive card */}
      <Card>
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z" />
            </svg>
          </div>
          <h3 className="text-lg font-bold tracking-tight text-white heading-font">Decomposition / SkillGate Check</h3>
        </div>
        
        <p className="mt-2 text-[14px] leading-relaxed text-zinc-400">
          An <b className="text-zinc-200">external hiring gate contract</b> (SkillGate) reads this candidate&apos;s passport on-chain and evaluates access to a job role. This occurs trustlessly, with no centralized server lookup.
        </p>

        <button
          onClick={runGate}
          disabled={gateBusy}
          className="btn-ghost border-purple-500/30 text-purple-300 hover:bg-purple-950/10 hover:border-purple-500/50 mt-4.5 text-xs font-semibold py-2 px-5"
        >
          {gateBusy ? "Querying registry contract..." : `Simulate Role Gate (${strongSkill?.skill} ≥ 80)`}
        </button>

        {gate && (
          <div className={`mt-4 rounded-xl border p-4 font-mono text-xs ${
            gate.passes 
              ? "bg-emerald-950/20 border-emerald-500/20 text-emerald-400" 
              : "bg-red-950/20 border-red-500/20 text-red-400"
          }`}>
            <div className="font-bold mb-1 uppercase tracking-wide">
              {gate.passes ? ">>> ACCESS GRANTED" : ">>> ACCESS DENIED"}
            </div>
            <div>Wallet Subject: {mint.subject}</div>
            <div>Attribute Confidence: {gate.confidence}% (Required: ≥80%)</div>
            <div className="opacity-70 mt-1">
              Source: {gate.source === "fallback" ? "Local simulation node" : "Monad RPC State"}
            </div>
          </div>
        )}
      </Card>

      <button
        onClick={() => location.reload()}
        className="mx-auto flex items-center gap-1.5 text-xs font-semibold text-zinc-500 hover:text-zinc-300 transition-colors duration-300 mt-2"
      >
        <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182m0-4.991v4.99" />
        </svg>
        <span>Evaluate Another Resume</span>
      </button>
    </div>
  );
}

function LinkRow({ 
  label, 
  href, 
  value, 
  enabled, 
  onCopy 
}: { 
  label: string; 
  href: string; 
  value: string; 
  enabled: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-zinc-900 pb-3 last:border-0 last:pb-0">
      <span className="text-zinc-400 font-semibold text-xs">{label}</span>
      <div className="flex items-center gap-2 max-w-full">
        {enabled ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="truncate font-mono text-xs text-purple-400 hover:text-purple-300 hover:underline transition-colors max-w-[180px] sm:max-w-[280px]"
          >
            {value}
          </a>
        ) : (
          <span className="truncate font-mono text-xs text-zinc-650 max-w-[180px] sm:max-w-[280px]">
            {value}
          </span>
        )}
        
        <button
          onClick={onCopy}
          className="rounded p-1 text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-all"
          title="Copy to clipboard"
        >
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 17.25v3.375c0 .621-.504 1.125-1.125 1.125h-9.75a1.125 1.125 0 0 1-1.125-1.125V7.875c0-.621.504-1.125 1.125-1.125H5.25m11.9-3.674A2.25 2.25 0 0 0 18.022 9.175a9 9 0 0 1-1.8 1.8 2.25 2.25 0 0 0-2.25 2.25v.896m1.156-1.156a2.25 2.25 0 0 0-2.25-2.25H9.75m0 0A2.25 2.25 0 0 1 7.5 7.5V5.25m0 0A2.25 2.25 0 0 1 9.75 3h3.75a2.25 2.25 0 0 1 2.25 2.25Z" />
          </svg>
        </button>

        {enabled && (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="rounded p-1 text-zinc-500 hover:text-zinc-350 hover:bg-white/5 transition-all"
          >
            <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 0 0 3 8.25v10.5A2.25 2.25 0 0 0 5.25 21h10.5A2.25 2.25 0 0 0 18 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
            </svg>
          </a>
        )}
      </div>
    </div>
  );
}

function WhyMonad() {
  return (
    <section className="glass-card mt-10 p-6 sm:p-8">
      <div className="flex items-center gap-2.5 mb-3">
        <span className="grid h-8 w-8 place-items-center rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
          <svg className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904 9 21l8.982-8.997M18 10.5H9.75L10.5 3H3v10.5h7.5L9.813 15.904Z" />
          </svg>
        </span>
        <h3 className="text-base font-bold text-white uppercase tracking-wider heading-font">Why Monad instead of Postgres?</h3>
      </div>
      
      <p className="text-sm leading-relaxed text-zinc-400">
        AI-driven skill evaluation is only the mechanism; the <b className="text-zinc-200">proof is the trustless on-chain product</b>. Attested attributes live directly on the high-speed Monad L1. This allows any third party—including DAOs, other recruitment platforms, or AI agents—to permissionlessly read and compose with a wallet&apos;s verified skill score (as simulated in the SkillGate demo above).
      </p>
    </section>
  );
}

const SAMPLE_RESUME_TEXT = `Aarav Sharma — aarav.sharma@example.com
Senior Backend Engineer, FinStack (3 yrs); Software Engineer, Razorpay (2 yrs)
B.Tech Computer Science, IIT Bombay, 2019
Skills: Python (expert), AWS (advanced), React (advanced), Kubernetes (advanced)
Projects: Built a high-throughput trading service in Python; event pipelines on AWS;
real-time dashboards in React; deployments on Kubernetes.`;
