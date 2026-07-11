"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import ScenarioPlayer from "@/components/ScenarioPlayer";
import VoiceRecorder from "@/components/VoiceRecorder";
import { extractDNA } from "@/lib/communication-metrics";
import { getLearnerId, loadGraphLocal, saveGraphLocal } from "@/lib/learner";
import type {
  Scenario,
  ConversationMessage,
  CoachingEvent,
  CommunicationMetrics,
} from "@/lib/types";

interface GemmaResult {
  fillerWords: string[];
  hesitations: string[];
  ramble: boolean;
  weakStructure: boolean;
  confidenceDrop: boolean;
  repetitivePhrases: string[];
  positiveHighlights: string[];
  suggestion: string;
  coachingEvents: CoachingEvent[];
}

type Step = "select" | "conversation" | "summary";

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
 *  `turn` is the number of learner answers so far (>= 1 by the time this is called - the
 *  scenario's opening message is already on screen, so it must never be repeated here). */
function localPartnerReply(userText: string, turn: number): string {
  const trimmed = (userText || "").trim();
  if (!trimmed) return "Take your time - whenever you're ready, tell me more.";
  const followUps = [
    "That's a helpful start. What was the hardest part of that?",
    "Interesting. Can you give me a concrete example?",
    "I follow. What would you do differently next time?",
    "Good. How did that land with the people involved?",
    "Thanks for sharing. What's the one thing you'd want me to remember?",
  ];
  return followUps[Math.max(0, turn - 1) % followUps.length];
}

export default function Practice() {
  const [step, setStep] = useState<Step>("select");
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [selected, setSelected] = useState<Scenario | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [coaching, setCoaching] = useState<GemmaResult | null>(null);
  const [sessionEvents, setSessionEvents] = useState<CoachingEvent[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<CommunicationMetrics | null>(null);
  const [graphUpdated, setGraphUpdated] = useState(false);

  const totalDurationRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

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
  }, [messages, coaching]);

  const start = useCallback(() => {
    if (!selected) return;
    setError(null);
    setSummary(null);
    setMetrics(null);
    setSessionEvents([]);
    setCoaching(null);
    totalDurationRef.current = 0;
    setMessages([{ role: "assistant", content: selected.openingMessage, timestamp: Date.now() }]);
    setStep("conversation");
  }, [selected]);

  const partnerReply = useCallback(
    async (history: ConversationMessage[]): Promise<string | null> => {
      if (!selected) return null;
      try {
        const res = await fetch("/api/gemini", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: history, scenarioId: selected.id }),
        });
        const d = await readJsonOrThrow(res);
        return typeof d.reply === "string" && d.reply.trim() ? d.reply : null;
      } catch {
        return null;
      }
    },
    [selected]
  );

  const runCoaching = useCallback(async (text: string) => {
    try {
      const recent = messages
        .slice(-4)
        .map((m) => ({ content: m.content }));
      const res = await fetch("/api/gemma", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transcript: text, recentMessages: recent }),
      });
      const d: GemmaResult = await readJsonOrThrow(res);
      setCoaching(d);
      setSessionEvents((prev) => [...prev, ...(d.coachingEvents ?? [])]);
    } catch {
      /* coaching is additive; never block the conversation */
    }
  }, [messages]);

  const handleUserInput = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !selected) return;
      setError(null);
      setBusy("Listening to you…");
      const userMsg: ConversationMessage = { role: "user", content: trimmed, timestamp: Date.now() };
      const history = [...messages, userMsg];
      setMessages(history);

      try {
        setBusy("Your partner is replying…");
        const reply = await partnerReply(history);
        const partnerText =
          reply ?? localPartnerReply(trimmed, history.filter((m) => m.role === "user").length);
        setMessages((prev) => [
          ...prev,
          { role: "assistant", content: partnerText, timestamp: Date.now() },
        ]);

        setBusy("Gemma is coaching…");
        await runCoaching(trimmed);
        setBusy(null);
      } catch (e) {
        setBusy(null);
        setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
      }
    },
    [messages, selected, partnerReply, runCoaching]
  );

  const handleRecorded = useCallback(
    async (blobs: Blob[], durationSec: number) => {
      totalDurationRef.current += durationSec;
      setError(null);
      setBusy("Transcribing your answer…");
      try {
        const fd = new FormData();
        blobs.forEach((b, i) => fd.append("audio", b, `answer-${i}.webm`));
        const res = await fetch("/api/transcribe", { method: "POST", body: fd });
        const t = await readJsonOrThrow(res);
        if (!t.text || t.text.trim().length < 2) throw new Error("We couldn't capture any speech. Try speaking a little longer.");
        await handleUserInput(t.text);
      } catch (e) {
        setBusy(null);
        setError(
          e instanceof Error
            ? `${e.message} (You can also type your response below to keep practising.)`
            : "Transcription failed. You can type your response below."
        );
      }
    },
    [handleUserInput]
  );

  const endSession = useCallback(async () => {
    if (!selected) return;
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
  }, [selected, allUserText, sessionEvents, messages]);

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
            {coaching && (
              <CoachingOverlay
                suggestion={coaching.suggestion}
                fillerWords={coaching.fillerWords}
                hesitations={coaching.hesitations}
                repetitivePhrases={coaching.repetitivePhrases}
                positiveHighlights={coaching.positiveHighlights}
              />
            )}

            {/* Transcript */}
            <div ref={scrollRef} className="flex flex-col gap-4 max-h-[44vh] overflow-y-auto pr-1">
              {messages.map((m, i) => (
                <Bubble key={i} message={m} />
              ))}
            </div>

            {/* Input */}
            <div className="glass-card p-5 flex flex-col gap-4">
              <VoiceRecorder disabled={!!busy} onRecorded={handleRecorded} />
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
          the moment with Gemma, and leave you with a clear session summary.
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
        Gemma · live coaching
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
          <div className="text-[10px] uppercase tracking-widest font-bold text-accent mb-2">Gemma&apos;s summary</div>
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
