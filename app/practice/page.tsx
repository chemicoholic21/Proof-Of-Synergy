"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import ScenarioPlayer from "@/components/ScenarioPlayer";
import VoiceRecorder, { type VoiceRecorderHandle } from "@/components/VoiceRecorder";
import { speak, type SpeechController } from "@/lib/tts-client";
import { VoiceLatencyTracker, type VoiceLatencyTimestamps } from "@/lib/voice-latency";
import { extractDNA } from "@/lib/communication-metrics";
import { analyzeWithHeuristics } from "@/lib/coaching";
import { getLearnerId, loadGraphLocal, saveGraphLocal } from "@/lib/learner";
import type {
  Scenario,
  ConversationMessage,
  CoachingEvent,
  CommunicationMetrics,
} from "@/lib/types";

type Step = "select" | "intake" | "conversation" | "summary";

async function readJsonOrThrow(res: Response): Promise<any> {
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const msg = data?.error || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return data;
}

/** Deterministic local partner reply so the gym is usable even without a model configured.
 *  `turn` is the number of prior user answers — this is only ever called to reply TO a user
 *  answer, never to produce the initial opening, so it must never re-emit scenario.openingMessage
 *  (doing so made the first reply repeat the opening question). */
function localPartnerReply(scenario: Scenario, userText: string, turn: number): string {
  const trimmed = (userText || "").trim();
  const interviewOpeners = [
    "Got it. What was the hardest technical decision you made there, and what were the trade-offs?",
    "Interesting. Can you walk me through the architecture and where the main bottleneck was?",
    "Let's go deeper — what specifically was your contribution versus the rest of the team?",
    "How did you validate that it worked, and what would you do differently today?",
    "What was the biggest thing that broke in production, and how did you handle it?",
  ];
  const openers = [
    "That's a helpful start. What was the hardest part of that?",
    "Interesting. Can you give me a concrete example?",
    "I follow. What would you do differently next time?",
    "Good. How did that land with the people involved?",
    "Thanks for sharing. What's the one thing you'd want me to remember?",
  ];
  if (!trimmed) return "Take your time - whenever you're ready, tell me more.";
  const pool = scenario.intake === "resume" ? interviewOpeners : openers;
  return pool[turn % pool.length];
}

function getCoachingSuggestion(events: CoachingEvent[]): string {
  const positive = events.filter((e) => e.type === "positive");
  const fillers = events.filter((e) => e.type === "filler");
  const rambling = events.find((e) => e.type === "ramble");
  const structure = events.find((e) => e.type === "weak-structure");
  const confidence = events.find((e) => e.type === "confidence-drop");

  if (positive.length >= 2) return "Great session! Your communication is strong and clear.";
  if (confidence) return "Own your expertise. Use 'I did X' instead of 'I think I did X'.";
  if (structure) return "Structure your answer: start with your main point, give an example, then summarize.";
  if (rambling) return "Try to be more concise. Focus on 2-3 key points rather than covering everything.";
  if (fillers.length >= 2) return `Pause instead of using filler words like "${fillers[0].text}".`;
  return "Keep going. Try to slow down slightly and structure your answer with a clear opening.";
}

// Interview length: wrap up at the next natural turn after the soft limit; a hard backstop ends it
// even if the candidate goes idle. (A truly "interesting → extend" call would need a model judgment;
// the soft→hard window approximates that.)
const INTERVIEW_SOFT_LIMIT_MS = 15 * 60 * 1000;
const INTERVIEW_HARD_LIMIT_MS = 20 * 60 * 1000;
const INTERVIEW_CLOSING =
  "That's all the time we have for today — thank you for interviewing. You did really well. I'll pull your feedback together now, and your full analysis and results will be waiting in your session summary in just a moment. Take care and have a great day!";

export default function Practice() {
  const [step, setStep] = useState<Step>("select");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selected, setSelected] = useState<Scenario | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [heuristicCoaching, setHeuristicCoaching] = useState<CoachingEvent[]>([]);
  const [sessionEvents, setSessionEvents] = useState<CoachingEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<CommunicationMetrics | null>(null);
  const [graphUpdated, setGraphUpdated] = useState(false);
  // For interview mode: the resume/JD-derived system prompt sent to the model each turn.
  const [interviewContext, setInterviewContext] = useState<string | null>(null);

  const totalDurationRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Hands-free interview mode: read each question aloud, then auto-open the mic.
  const recorderRef = useRef<VoiceRecorderHandle>(null);
  const speechRef = useRef<SpeechController | null>(null);
  const autoHandledIdxRef = useRef(-1);
  const autoConverse = selected?.intake === "resume";
  // Interview timing: when the conversation started, a hard-limit timer, and a flag marking that
  // the interviewer's closing line has been delivered (after which we auto-end the session).
  const interviewStartRef = useRef(0);
  const hardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closingRef = useRef(false);
  const endSessionRef = useRef<() => void>(() => {});
  // Latency instrumentation for the current voice turn (mic -> STT -> LLM -> TTS -> playback). Set
  // by handleRecorded when a voice answer comes in; null for a typed answer (TypedInput calls
  // handleUserInput directly, with no mic/STT leg to measure). Cleared once a turn is reported so a
  // typed message never accidentally inherits a stale/failed voice turn's marks.
  const latencyRef = useRef<VoiceLatencyTracker | null>(null);

  const stopSpeaking = useCallback(() => {
    speechRef.current?.stop();
    speechRef.current = null;
  }, []);

  // Ship a finished turn's latency breakdown to the server (best-effort, never blocks the UI) and
  // log it locally in dev so the mic->STT->LLM->TTS->playback breakdown is visible without needing
  // Phoenix wired up.
  const reportVoiceLatency = useCallback((tracker: VoiceLatencyTracker | null) => {
    if (!tracker) return;
    const metrics = tracker.metrics();
    if (process.env.NODE_ENV !== "production") {
      // eslint-disable-next-line no-console
      console.debug("[voice-latency]", tracker.turnId, metrics);
    }
    fetch("/api/telemetry/voice-latency", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ turnId: tracker.turnId, timestamps: tracker.snapshot(), metrics }),
      keepalive: true,
    }).catch(() => {
      /* telemetry is best-effort */
    });
  }, []);

  const clearInterviewTimer = useCallback(() => {
    if (hardTimerRef.current) {
      clearTimeout(hardTimerRef.current);
      hardTimerRef.current = null;
    }
  }, []);

  // Deliver the interviewer's closing line, then let the hands-free effect speak it and auto-end.
  const closeInterview = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    clearInterviewTimer();
    recorderRef.current?.stop();
    setMessages((prev) => [...prev, { role: "assistant", content: INTERVIEW_CLOSING, timestamp: Date.now() }]);
  }, [clearInterviewTimer]);

  const allUserText = useMemo(
    () => messages.filter((m) => m.role === "user").map((m) => m.content).join(" "),
    [messages]
  );

  useEffect(() => {
    fetch("/api/scenarios")
      .then((r) => r.json())
      .then((d) => setScenarios(d.scenarios ?? []))
      .catch(() => setScenarios([]));
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("scenario");
    if (id && scenarios.length) {
      const s = scenarios.find((x) => x.id === id);
      if (s) setSelected(s);
    }
  }, [scenarios]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, heuristicCoaching, busy]);

  // Hands-free interview loop: when a new interviewer question appears, read it aloud, then
  // automatically open the mic once reading finishes. Each assistant message is handled once.
  useEffect(() => {
    if (step !== "conversation" || !autoConverse || busy) return;
    const idx = messages.length - 1;
    if (idx < 0 || messages[idx].role !== "assistant") return;
    if (autoHandledIdxRef.current >= idx) return;
    autoHandledIdxRef.current = idx;

    let cancelled = false;
    // The tracker set by handleRecorded for the answer that produced this reply (null for the
    // opening question, which has no preceding voice turn to attach to).
    const turnLatency = latencyRef.current;
    const controller = speak(messages[idx].content, undefined, turnLatency ?? undefined);
    speechRef.current = controller;
    controller.done.then(() => {
      if (cancelled) return;
      if (speechRef.current === controller) speechRef.current = null;
      // The turn that started with this recording is done (reply generated and spoken) — ship its
      // latency breakdown and clear the ref so the next recording starts a fresh tracker.
      if (latencyRef.current === turnLatency) {
        reportVoiceLatency(turnLatency);
        latencyRef.current = null;
      }
      if (closingRef.current) {
        // That was the interviewer's closing line → end the session and show the analysis.
        endSessionRef.current();
        return;
      }
      // Reading finished → start listening for the answer.
      recorderRef.current?.start();
    });
    return () => {
      cancelled = true;
    };
  }, [messages, busy, step, autoConverse, reportVoiceLatency]);

  // Stop any in-flight speech and the interview timer when leaving the page.
  useEffect(
    () => () => {
      speechRef.current?.stop();
      if (hardTimerRef.current) clearTimeout(hardTimerRef.current);
    },
    []
  );

  const resetSession = useCallback(() => {
    setError(null);
    setSummary(null);
    setMetrics(null);
    setSessionEvents([]);
    setHeuristicCoaching([]);
    setInterviewContext(null);
    totalDurationRef.current = 0;
  }, []);

  const start = useCallback(() => {
    if (!selected) return;
    resetSession();
    // Interview scenarios need a resume before we can generate tailored questions.
    if (selected.intake === "resume") {
      setStep("intake");
      return;
    }
    setMessages([{ role: "assistant", content: selected.openingMessage, timestamp: Date.now() }]);
    setStep("conversation");
  }, [selected, resetSession]);

  // Called by the interview intake form once the resume/JD are parsed server-side.
  const prepareInterview = useCallback(async (fd: FormData) => {
    setError(null);
    setBusy("Reading your resume and preparing your interview…");
    try {
      const res = await fetch("/api/interview/prepare", { method: "POST", body: fd });
      const d = await readJsonOrThrow(res);
      if (!d.systemPrompt || !d.openingMessage) {
        throw new Error("We couldn't prepare the interview. Please try again.");
      }
      setInterviewContext(d.systemPrompt);
      autoHandledIdxRef.current = -1; // fresh conversation → the opening question should be read
      // Start the interview clock: a hard backstop ends it even if the candidate later goes idle.
      closingRef.current = false;
      interviewStartRef.current = Date.now();
      clearInterviewTimer();
      hardTimerRef.current = setTimeout(() => closeInterview(), INTERVIEW_HARD_LIMIT_MS);
      setMessages([{ role: "assistant", content: d.openingMessage, timestamp: Date.now() }]);
      setStep("conversation");
    } catch (e) {
      setError(e instanceof Error ? e.message : "We couldn't prepare the interview. Please try again.");
    } finally {
      setBusy(null);
    }
  }, [clearInterviewTimer, closeInterview]);

  const partnerReply = useCallback(
    async (history: ConversationMessage[]): Promise<string | null> => {
      if (!selected) return null;
      try {
        const res = await fetch("/api/gemini", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messages: history,
            scenarioId: selected.id,
            ...(interviewContext ? { systemPrompt: interviewContext } : {}),
          }),
        });
        const d = await readJsonOrThrow(res);
        // Fold the server-timed llm_start/llm_first_token/llm_end into whichever turn is in
        // flight (set by handleRecorded); a no-op for a typed message, which has no tracker.
        latencyRef.current?.merge(d.timing);
        return typeof d.reply === "string" && d.reply.trim() ? d.reply : null;
      } catch {
        return null;
      }
    },
    [selected, interviewContext]
  );

  const runCoaching = useCallback(
    (text: string) => {
      const m = extractDNA(text);
      const result = analyzeWithHeuristics(text, m);
      setHeuristicCoaching(result.coachingEvents);
    },
    []
  );

  const handleUserInput = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !selected) return;
      setError(null);
      setBusy("Listening to you…");
      const userMsg: ConversationMessage = { role: "user", content: trimmed, timestamp: Date.now() };
      const history = [...messages, userMsg];
      setMessages(history);

      // Interview time's up: after the soft limit, wrap up at this natural turn boundary (the
      // candidate's answer is kept) with the interviewer's closing line instead of a new question.
      if (
        autoConverse &&
        !closingRef.current &&
        interviewStartRef.current > 0 &&
        Date.now() - interviewStartRef.current >= INTERVIEW_SOFT_LIMIT_MS
      ) {
        setBusy(null);
        closeInterview();
        return;
      }

      try {
        setBusy("Your partner is replying…");
        const reply = await partnerReply(history);
        // If the interview closed while we were fetching (e.g. hard-limit timer fired), don't append
        // another question on top of the closing line.
        if (closingRef.current) {
          setBusy(null);
          return;
        }
        const partnerText =
          reply ?? localPartnerReply(selected, trimmed, messages.filter((m) => m.role === "user").length);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: partnerText, timestamp: Date.now() },
        ]);

        setBusy("Coaching…");
        runCoaching(trimmed);
        setBusy(null);

        // Hands-free interview mode still has a TTS + playback leg ahead (the effect above speaks
        // `partnerText`), so that effect reports the turn once the reply has actually been spoken.
        // Outside that mode nothing else will touch this tracker, so report it now.
        if (!autoConverse) {
          reportVoiceLatency(latencyRef.current);
          latencyRef.current = null;
        }
      } catch (e) {
        setBusy(null);
        setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      }
    },
    [messages, selected, partnerReply, runCoaching, autoConverse, closeInterview, reportVoiceLatency]
  );

  const handleUtteranceEnd = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      handleUserInput(text);
    },
    [handleUserInput]
  );

  const handleRecorded = useCallback(
    async (blobs: Blob[], durationSec: number, liveText?: string, latencyMarks?: VoiceLatencyTimestamps) => {
      totalDurationRef.current += durationSec;
      setError(null);
      setBusy("Transcribing your answer…");
      // Own this turn's latency tracker for the rest of the pipeline: seeded with VoiceRecorder's
      // client-side marks (mic_start/speech_detected/speech_end), then layered with the server
      // timing each downstream call returns.
      const tracker = new VoiceLatencyTracker(latencyMarks);
      latencyRef.current = tracker;
      try {
        tracker.mark("audio_upload_start");
        const fd = new FormData();
        blobs.forEach((b, i) => fd.append("audio", b, `answer-${i}.webm`));
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const t = await readJsonOrThrow(res);
        tracker.merge(t.timing);
        // Prefer Sarvam's transcript; fall back to the browser live transcript if Sarvam is empty.
        let text = (t.text ?? "").trim();
        if (text.length < 2 && liveText && liveText.trim().length >= 2) text = liveText.trim();
        if (text.length < 2) throw new Error("We couldn't capture any speech. Try speaking a little longer.");
        await handleUserInput(text);
      } catch (e) {
        setBusy(null);
        setError(
          e instanceof Error
            ? `${e.message} (You can also type your response below to keep practising.)`
            : "Transcription failed. You can type your response below."
        );
        // This turn never reached the LLM/TTS stages -> nothing will report or clear it. Report
        // what we do have (mic/upload/STT marks) and drop it so a later typed message can't
        // accidentally inherit it.
        reportVoiceLatency(latencyRef.current === tracker ? tracker : null);
        if (latencyRef.current === tracker) latencyRef.current = null;
      }
    },
    [handleUserInput, reportVoiceLatency]
  );

  const endSession = useCallback(async () => {
    if (!selected) return;
    clearInterviewTimer();
    stopSpeaking();
    recorderRef.current?.stop();
    setError(null);
    setBusy("Summarising your session…");
    const m = extractDNA(allUserText, totalDurationRef.current || undefined);
    setMetrics(m);
    let sessionSummary: string;
    try {
      const res = await fetch("/api/coaching/summary", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scenarioTitle: selected.title,
          wordCount: m.wordCount,
          confidence: m.confidence,
          fillerCount: m.fillerCount,
          coachingEvents: sessionEvents.map((e) => ({ type: e.type, text: e.text })),
        }),
      });
      const d = await readJsonOrThrow(res);
      sessionSummary = d.summary ?? "Nice work showing up to practise.";
    } catch {
      sessionSummary = `You spoke ${m.wordCount} words with a confidence score of ${m.confidence}/100 and ${m.fillerCount} filler words detected. Keep practising - small reps add up.`;
    }
    setSummary(sessionSummary);

    // remember(): fold this session into the Skill Knowledge Graph (best-effort, never blocks).
    setBusy("Updating your skill graph…");
    setGraphUpdated(false);
    try {
      const learnerId = getLearnerId();
      const res = await fetch("/api/skill-graph/remember", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          learnerId,
          session: {
            scenarioId: selected.id,
            durationSec: totalDurationRef.current,
            messages,
            coachingEvents: sessionEvents,
            metrics: m,
            summary: sessionSummary,
          },
          graph: loadGraphLocal(learnerId) ?? undefined,
        }),
      });
      const d = await readJsonOrThrow(res);
      if (d.graph) {
        saveGraphLocal(learnerId, d.graph);
        setGraphUpdated(true);
      }
    } catch {
      /* the session summary still stands; the graph will catch up next time */
    } finally {
      setBusy(null);
      setStep("summary");
    }
  }, [selected, allUserText, sessionEvents, messages, stopSpeaking, clearInterviewTimer]);

  // Keep a stable ref to the latest endSession so the hands-free effect can call it after the
  // interviewer's closing line without re-subscribing every render.
  endSessionRef.current = endSession;

  return (
    <div className="min-h-screen relative overflow-hidden bg-background">
      <main className="mx-auto w-full max-w-5xl px-6 sm:px-10 py-10 relative z-10">
        <Header />

        {busy && (
          <div className="mb-6 flex items-center gap-4 rounded-2xl border border-accent/25 bg-accent/5 px-6 py-4 text-[15px] text-ink pulse-glow-active">
            <span className="relative flex h-4.5 w-4.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex rounded-full h-4.5 w-4.5 bg-accent" />
            </span>
            <span className="font-mono tracking-wide">{busy}</span>
          </div>
        )}

        {error && !busy && (
          <div role="alert" className="mb-6 flex items-start gap-4 rounded-2xl border border-red-500/30 bg-red-950/20 px-6 py-4 text-[14px] text-red-200">
            <span className="mt-0.5 text-lg">⚠️</span>
            <p className="flex-1 font-mono">{error}</p>
            <button onClick={() => setError(null)} className="text-red-300/70 hover:text-red-200" aria-label="Dismiss">✕</button>
          </div>
        )}

        {step === "select" && (
          <ScenarioPicker scenarios={scenarios} selected={selected} onSelect={setSelected} onStart={start} />
        )}

        {step === "intake" && selected && (
          <InterviewIntake
            title={selected.title}
            busy={!!busy}
            onCancel={() => setStep("select")}
            onSubmit={prepareInterview}
          />
        )}

        {step === "conversation" && selected && (
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between gap-4 border-b border-line pb-5">
              <div>
                <div className="text-[11px] uppercase tracking-[0.2em] text-ink-soft">Practising</div>
                <h2 className="heading-font mt-1 text-2xl font-bold text-ink">{selected.title}</h2>
              </div>
              <button onClick={endSession} disabled={!!busy} className="btn-ghost text-sm px-5 py-2.5">
                End session
              </button>
            </div>

            {/* Coaching overlay */}
            {heuristicCoaching.length > 0 && (
              <CoachingOverlay
                suggestion={getCoachingSuggestion(heuristicCoaching)}
                fillerWords={[]}
                hesitations={[]}
                repetitivePhrases={[]}
                positiveHighlights={[]}
              />
            )}

            {/* Transcript */}
            <div ref={scrollRef} className="flex flex-col gap-4 max-h-[44vh] overflow-y-auto pr-1">
              {messages.map((m, i) => (
                <Bubble key={i} message={m} />
              ))}
              {busy && <TypingBubble label={busy} />}
            </div>

            {/* Input */}
            <div className="glass-card p-5 flex flex-col gap-4">
              <VoiceRecorder
                ref={recorderRef}
                disabled={!!busy}
                onRecorded={handleRecorded}
                onUtteranceEnd={handleUtteranceEnd}
                onRecordingStart={stopSpeaking}
                streamToWs
              />
              {autoConverse && (
                <p className="text-[11px] text-ink-soft">
                  Hands-free: each question is read aloud, then the mic opens automatically. You can
                  also tap the mic or type any time. The interview runs about 15–20 minutes and wraps
                  up on its own.
                </p>
              )}
              <div className="flex items-center gap-3">
                <span className="text-[11px] uppercase tracking-wider text-ink-soft">or type</span>
                <span className="h-px flex-1 bg-line" />
              </div>
              <TypedInput disabled={!!busy} onSend={handleUserInput} />
            </div>
          </div>
        )}

        {step === "summary" && selected && (
          <SessionSummary
            scenarioTitle={selected.title}
            metrics={metrics}
            summary={summary}
            events={sessionEvents}
            graphUpdated={graphUpdated}
            onRestart={() => {
              setSelected(null);
              setStep("select");
            }}
          />
        )}
      </main>
    </div>
  );
}

function Header() {
  return (
    <header className="mb-10">
      <div className="flex items-center justify-between gap-4 border-b border-line pb-5">
        <Link href="/" className="heading-font text-lg tracking-tight text-ink hover:text-white transition-colors">
          Proof of Synergy
        </Link>
        <nav className="flex items-center gap-5 text-sm">
          <Link href="/practice" className="text-ink border-b border-transparent hover:border-accent pb-0.5 transition-colors">Practice</Link>
          <Link href="/knowledge-graph" className="text-ink-soft border-b border-transparent hover:border-accent pb-0.5 transition-colors">
            Skill Graph <span className="text-ink-soft">→</span>
          </Link>
          <Link href="/practice/realtime" className="text-ink-soft border-b border-transparent hover:border-accent pb-0.5 transition-colors">
            Realtime (experimental) <span className="text-ink-soft">→</span>
          </Link>
        </nav>
      </div>
    </header>
  );
}

function ScenarioPicker({
  scenarios,
  selected,
  onSelect,
  onStart,
}: {
  scenarios: Scenario[];
  selected: Scenario | null;
  onSelect: (s: Scenario) => void;
  onStart: () => void;
}) {
  return (
    <div className="step-container">
      <div className="fade-up">
        <span className="text-[11px] uppercase tracking-[0.25em] text-ink-soft">Deliberate practice</span>
        <h1 className="heading-font mt-3 text-[2.5rem] leading-[1.05] tracking-tight text-ink sm:text-[3.5rem]">
          Choose a scenario
        </h1>
        <p className="mt-6 max-w-2xl text-base leading-relaxed text-ink-soft sm:text-[17px]">
          Pick a situation you want to get better at. We&apos;ll run a live conversation, coach you in
          the moment with live coaching, and leave you with a clear session summary.
        </p>
      </div>

      <div className="mt-10 grid gap-px overflow-hidden border border-line sm:grid-cols-2 lg:grid-cols-3">
        {scenarios.map((s, i) => {
          const active = selected?.id === s.id;
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s)}
              className={`group relative flex flex-col gap-3 bg-surface p-6 text-left transition-colors duration-300 hover:bg-surface-2 ${
                active ? "ring-1 ring-accent" : ""
              } fade-up`}
              style={{ animationDelay: `${120 + i * 60}ms` }}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] tabular-nums text-accent">0{i + 1}</span>
                <span className="rounded-full border border-line px-2.5 py-0.5 text-[10px] uppercase tracking-wider text-ink-soft">{s.difficulty}</span>
              </div>
              <h3 className="heading-font text-xl font-bold text-ink">{s.title}</h3>
              <p className="flex-1 text-[13px] leading-relaxed text-ink-soft">{s.description}</p>
              <div className="flex flex-wrap gap-1.5">
                {s.tags.map((t) => (
                  <span key={t} className="rounded-full border border-line px-2 py-0.5 text-[10px] text-ink-soft">{t}</span>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      <div className="mt-10 flex items-center gap-4">
        <button
          onClick={onStart}
          disabled={!selected}
          className={selected ? "btn-primary px-8 py-3.5 text-base" : "rounded-full border border-line px-8 py-3.5 text-base text-ink-soft cursor-not-allowed"}
        >
          {selected ? `Start · ${selected.title}` : "Select a scenario to begin"}
        </button>
      </div>
    </div>
  );
}

function InterviewIntake({
  title,
  busy,
  onCancel,
  onSubmit,
}: {
  title: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (fd: FormData) => void;
}) {
  const [resumeFile, setResumeFile] = useState<File | null>(null);
  const [resumeText, setResumeText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [jdFile, setJdFile] = useState<File | null>(null);
  const [jdText, setJdText] = useState("");
  const [role, setRole] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  const hasResume = Boolean(resumeFile) || resumeText.trim().length >= 30;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!hasResume) {
      setLocalError("Please upload your resume, or paste at least a few lines of it.");
      return;
    }
    setLocalError(null);
    const fd = new FormData();
    if (resumeFile) fd.append("resume", resumeFile);
    if (resumeText.trim()) fd.append("resumeText", resumeText.trim());
    if (jdFile) fd.append("jobDescription", jdFile);
    if (jdText.trim()) fd.append("jobDescriptionText", jdText.trim());
    if (role.trim()) fd.append("role", role.trim());
    onSubmit(fd);
  }

  return (
    <div className="step-container">
      <div className="fade-up">
        <span className="text-[11px] uppercase tracking-[0.25em] text-ink-soft">Interview setup</span>
        <h1 className="heading-font mt-3 text-[2.25rem] leading-[1.05] tracking-tight text-ink sm:text-[3rem]">{title}</h1>
        <p className="mt-5 max-w-2xl text-base leading-relaxed text-ink-soft">
          Upload your resume so the interviewer can ask questions about your real projects and experience.
          Add the job description too (optional) for role-specific questions.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-6">
        {/* Resume (required) */}
        <div className="glass-card p-6 flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[13px] font-semibold text-ink">
              Resume <span className="text-accent">*</span>
              <span className="ml-2 text-[11px] font-normal text-ink-soft">
                PDF, Word (.docx), text, or a scan/photo (OCR)
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowPaste((v) => !v)}
              className="text-[12px] text-ink-soft underline decoration-line hover:text-accent"
            >
              {showPaste ? "Upload a file instead" : "Paste text instead"}
            </button>
          </div>

          {!showPaste ? (
            <label className="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line-strong bg-black/20 px-6 py-8 text-center transition-colors hover:border-accent/40">
              <svg className="h-7 w-7 text-ink-soft" fill="none" stroke="currentColor" strokeWidth="1.6" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75V16.5m-13.5-6L12 3m0 0 4.5 4.5M12 3v13.5" />
              </svg>
              <span className="text-[14px] text-ink">
                {resumeFile ? resumeFile.name : "Click to upload your resume"}
              </span>
              <span className="text-[11px] text-ink-soft">Max 8 MB</span>
              <input
                type="file"
                accept=".pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/*"
                className="hidden"
                onChange={(e) => {
                  setResumeFile(e.target.files?.[0] ?? null);
                  setLocalError(null);
                }}
              />
            </label>
          ) : (
            <textarea
              value={resumeText}
              onChange={(e) => setResumeText(e.target.value)}
              rows={8}
              placeholder="Paste your resume text here…"
              className="w-full resize-y rounded-2xl border border-line bg-black/30 px-4 py-3 text-[14px] text-ink placeholder:text-ink-soft/60 outline-none focus:border-accent/40"
            />
          )}
        </div>

        {/* Role + Job description (optional) */}
        <div className="glass-card p-6 flex flex-col gap-4">
          <div className="text-[13px] font-semibold text-ink">
            Target role & job description <span className="text-[11px] font-normal text-ink-soft">optional</span>
          </div>
          <input
            value={role}
            onChange={(e) => setRole(e.target.value)}
            placeholder="Role, e.g. Senior Backend Engineer"
            className="w-full rounded-full border border-line bg-black/30 px-4 py-2.5 text-[14px] text-ink placeholder:text-ink-soft/60 outline-none focus:border-accent/40"
          />
          <textarea
            value={jdText}
            onChange={(e) => setJdText(e.target.value)}
            rows={4}
            placeholder="Paste the job description (optional)…"
            className="w-full resize-y rounded-2xl border border-line bg-black/30 px-4 py-3 text-[14px] text-ink placeholder:text-ink-soft/60 outline-none focus:border-accent/40"
          />
          <label className="flex items-center gap-3 text-[12px] text-ink-soft">
            <span>or upload a JD file:</span>
            <input
              type="file"
              accept=".pdf,.doc,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/*"
              onChange={(e) => setJdFile(e.target.files?.[0] ?? null)}
              className="text-[12px] text-ink file:mr-3 file:rounded-full file:border-0 file:bg-surface-2 file:px-3 file:py-1.5 file:text-ink-soft hover:file:text-accent"
            />
          </label>
        </div>

        {localError && <p className="text-[13px] text-red-300">{localError}</p>}

        <div className="flex flex-col gap-3 sm:flex-row">
          <button
            type="submit"
            disabled={busy || !hasResume}
            className={
              busy || !hasResume
                ? "rounded-full border border-line px-8 py-3.5 text-base text-ink-soft cursor-not-allowed"
                : "btn-primary px-8 py-3.5 text-base"
            }
          >
            {busy ? "Preparing your interview…" : "Start interview"}
          </button>
          <button type="button" onClick={onCancel} disabled={busy} className="btn-ghost px-8 py-3.5 text-base">
            Back
          </button>
        </div>
      </form>
    </div>
  );
}

/** ChatGPT/Claude-style "AI is processing" indicator: a Partner bubble with three bouncing dots. */
function TypingBubble({ label }: { label?: string }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] rounded-2xl border border-accent/25 bg-accent/5 px-5 py-3.5">
        <div className="mb-1.5 flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest font-bold text-accent">Partner</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1">
            <span className="typing-dot" style={{ animationDelay: "0ms" }} />
            <span className="typing-dot" style={{ animationDelay: "150ms" }} />
            <span className="typing-dot" style={{ animationDelay: "300ms" }} />
          </span>
          {label && <span className="text-[12px] text-ink-soft">{label}</span>}
        </div>
      </div>
    </div>
  );
}

function Bubble({ message }: { message: ConversationMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] rounded-2xl border px-5 py-3.5 ${isUser ? "border-line bg-surface-2 text-ink" : "border-accent/25 bg-accent/5 text-ink"}`}>
        <div className="mb-1.5 flex items-center gap-2">
          <span className={`text-[10px] uppercase tracking-widest font-bold ${isUser ? "text-ink-soft" : "text-accent"}`}>
            {isUser ? "You" : "Partner"}
          </span>
          {!isUser && <ScenarioPlayer text={message.content} />}
        </div>
        <p className="text-[15px] leading-relaxed">{message.content}</p>
      </div>
    </div>
  );
}

function CoachingOverlay({
  suggestion,
  fillerWords,
  hesitations,
  repetitivePhrases,
  positiveHighlights,
}: {
  suggestion: string;
  fillerWords: string[];
  hesitations: string[];
  repetitivePhrases: string[];
  positiveHighlights: string[];
}) {
  const chips = [
    ...fillerWords.map((w) => ({ label: `“${w}”`, tone: "amber" as const })),
    ...hesitations.map((w) => ({ label: `hesitation: ${w}`, tone: "amber" as const })),
    ...repetitivePhrases.map((w) => ({ label: `repeat: ${w}`, tone: "repeat" as const })),
  ];
  return (
    <div className="rounded-2xl border border-accent/30 bg-accent/5 p-5">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold text-accent">
        <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
        Live coaching
      </div>
      <p className="mt-2 text-[14px] leading-relaxed text-ink">{suggestion}</p>
      {chips.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {chips.map((c, i) => (
            <span
              key={i}
              className={`rounded-full border px-2.5 py-0.5 text-[11px] ${
                c.tone === "amber"
                  ? "border-amber-500/30 bg-amber-950/20 text-amber-300"
                  : "border-line-strong bg-surface-2 text-ink-soft"
              }`}
            >
              {c.label}
            </span>
          ))}
        </div>
      )}
      {positiveHighlights.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {positiveHighlights.slice(0, 3).map((h, i) => (
            <span key={i} className="rounded-full border border-emerald-500/30 bg-emerald-950/10 px-2.5 py-0.5 text-[11px] text-emerald-300">
              ✓ {h}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TypedInput({ disabled, onSend }: { disabled?: boolean; onSend: (t: string) => void }) {
  const [text, setText] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        onSend(text);
        setText("");
      }}
      className="flex items-center gap-3"
    >
      <input
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
        placeholder="Type your response…"
        className="flex-1 rounded-full border border-line bg-black/30 px-4 py-2.5 text-[14px] text-ink placeholder:text-ink-soft/60 outline-none focus:border-accent/40"
      />
      <button type="submit" disabled={disabled || !text.trim()} className="btn-ghost text-sm px-5 py-2.5 disabled:opacity-40">
        Send
      </button>
    </form>
  );
}

function SessionSummary({
  scenarioTitle,
  metrics,
  summary,
  events,
  graphUpdated,
  onRestart,
}: {
  scenarioTitle: string;
  metrics: CommunicationMetrics | null;
  summary: string | null;
  events: CoachingEvent[];
  graphUpdated: boolean;
  onRestart: () => void;
}) {
  return (
    <div className="step-container flex flex-col gap-6">
      <div className="glass-card p-8 text-center">
        <div className="text-[11px] uppercase tracking-[0.25em] text-ink-soft">Session complete</div>
        <h2 className="heading-font mt-3 text-3xl font-bold text-ink">{scenarioTitle}</h2>
      </div>

      {metrics && (
        <div className="grid gap-3 sm:grid-cols-3">
          <MetricCard label="Confidence" value={`${metrics.confidence}%`} tone="emerald" />
          <MetricCard label="Words spoken" value={String(metrics.wordCount)} tone="accent" />
          <MetricCard label="Filler words" value={String(metrics.fillerRate ? `${metrics.fillerRate}%` : metrics.fillerCount)} tone="amber" />
        </div>
      )}

      {summary && (
        <div className="glass-card p-6">
          <div className="text-[10px] uppercase tracking-widest font-bold text-accent mb-2">Session summary</div>
          <p className="text-[15px] leading-relaxed text-ink whitespace-pre-line">{summary}</p>
        </div>
      )}

      {events.length > 0 && (
        <div className="glass-card p-6">
          <div className="text-[10px] uppercase tracking-widest font-bold text-ink-soft mb-3">Coaching moments</div>
          <ul className="space-y-2">
            {events.slice(0, 12).map((e, i) => (
              <li key={i} className="flex items-start gap-2 text-[13px] text-ink-soft">
                <span className={e.type === "positive" ? "text-emerald-400" : "text-amber-400"}>
                  {e.type === "positive" ? "✓" : "•"}
                </span>
                <span>{e.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {graphUpdated && (
        <div className="rounded-2xl border border-emerald-500/25 bg-emerald-950/10 px-5 py-3.5 text-[13px] text-emerald-200">
          ✓ Your Skill Knowledge Graph was updated with this session.
        </div>
      )}

      <div className="flex flex-col sm:flex-row gap-3">
        <button onClick={onRestart} className="btn-primary px-8 py-3.5 text-base">Practise again</button>
        <Link href="/knowledge-graph" className="btn-ghost px-8 py-3.5 text-base text-center">
          {graphUpdated ? "See your graph grow" : "View Skill Graph"}
        </Link>
      </div>
    </div>
  );
}

function MetricCard({ label, value, tone }: { label: string; value: string; tone: "emerald" | "amber" | "accent" }) {
  const color = { emerald: "text-emerald-300", amber: "text-amber-300", accent: "text-ink" }[tone];
  return (
    <div className="rounded-2xl border border-line bg-surface p-4 text-center">
      <div className={`heading-font text-3xl font-bold ${color}`}>{value}</div>
      <div className="mt-1 text-[10px] uppercase tracking-wider text-ink-soft">{label}</div>
    </div>
  );
}
