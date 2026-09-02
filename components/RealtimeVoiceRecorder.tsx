"use client";

/**
 * components/RealtimeVoiceRecorder.tsx
 *
 * The minimal, clearly-labeled integration point for the realtime voice path
 * (server/voice-gateway.ts + lib/voice/InterviewPipeline.ts + lib/voice-client/*) — separate from,
 * and never loaded by, the existing batch pipeline (`components/VoiceRecorder.tsx` +
 * `app/practice/page.tsx`), which keeps working completely unchanged. Mounted only from
 * `app/practice/realtime/page.tsx`, an explicitly "Experimental" route.
 *
 * This component is intentionally thin: it owns UI state and a `RealtimeAudioCapture` instance,
 * and otherwise just renders whatever `InterviewEvent`s and connection state flow through it. All
 * of the actual protocol/VAD/playback-queue logic it depends on is unit-tested elsewhere (see
 * lib/voice-client/*.test.ts) — this file's own logic is too DOM-bound to unit test, so it's kept
 * as close to "wiring, not logic" as possible.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RealtimeAudioCapture } from "@/lib/voice-client/RealtimeAudioCapture";
import type { InterviewEvent } from "@/lib/events/interviewEvents";

const DEFAULT_GATEWAY_URL = process.env.NEXT_PUBLIC_VOICE_GATEWAY_URL ?? "ws://localhost:3001";

type Status = "idle" | "connecting" | "live" | "error" | "ended";

interface LogLine {
  id: number;
  text: string;
}

export default function RealtimeVoiceRecorder() {
  const [status, setStatus] = useState<Status>("idle");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [level, setLevel] = useState(0);
  const [log, setLog] = useState<LogLine[]>([]);
  const [error, setError] = useState<string | null>(null);

  const captureRef = useRef<RealtimeAudioCapture | null>(null);
  const logIdRef = useRef(0);

  const appendLog = useCallback((text: string) => {
    logIdRef.current += 1;
    setLog((prev) => [...prev.slice(-49), { id: logIdRef.current, text }]);
  }, []);

  const handleEvent = useCallback(
    (event: InterviewEvent) => {
      switch (event.type) {
        case "PARTIAL_TRANSCRIPT":
          appendLog(`… ${event.text}`);
          break;
        case "FINAL_TRANSCRIPT":
          appendLog(`You: ${event.text}`);
          break;
        case "AGENT_GENERATION_COMPLETED":
          appendLog(`Interviewer: ${event.text}`);
          break;
        case "AGENT_INTERRUPTED":
          appendLog(`(interrupted — ${event.interruptedStage ?? "unknown stage"})`);
          break;
        case "ERROR":
          appendLog(`Error (${event.stage}): ${event.message}`);
          break;
        default:
          break;
      }
    },
    [appendLog]
  );

  const stop = useCallback(async () => {
    await captureRef.current?.stop();
    captureRef.current = null;
    setStatus("ended");
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStatus("connecting");
    appendLog("Connecting to the realtime voice gateway…");

    const capture = new RealtimeAudioCapture({
      gatewayUrl: DEFAULT_GATEWAY_URL,
      onEvent: handleEvent,
      onLevel: (rms) => setLevel(rms),
      onProtocolError: (message) => appendLog(`Protocol error: ${message}`),
      onSequenceGap: (expected, actual) =>
        appendLog(`(connection hiccup — expected message #${expected}, got #${actual})`),
      onConnectionClosed: () => {
        appendLog("Connection closed.");
        setStatus("ended");
      },
    });
    captureRef.current = capture;

    try {
      await capture.start();
      setSessionId(capture.client.sessionId);
      setStatus("live");
      appendLog("Live — start talking whenever you're ready.");
    } catch (e) {
      setError((e as Error).message);
      setStatus("error");
      captureRef.current = null;
    }
  }, [appendLog, handleEvent]);

  useEffect(() => {
    return () => {
      void captureRef.current?.stop();
    };
  }, []);

  return (
    <div className="flex flex-col gap-6 rounded-2xl border border-line bg-surface p-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[11px] uppercase tracking-[0.2em] text-ink-soft">Experimental</div>
          <h2 className="heading-font mt-1 text-xl font-bold text-ink">Realtime voice gateway</h2>
          <p className="mt-1 text-sm text-ink-soft">
            Streams your microphone to <code>server/voice-gateway.ts</code> over a live WebSocket
            instead of the batch record-then-upload flow used elsewhere in this app.
          </p>
        </div>
        {status === "idle" || status === "ended" || status === "error" ? (
          <button
            onClick={() => void start()}
            className="rounded-full bg-accent px-5 py-2.5 text-[14px] font-medium text-white transition-all active:scale-[0.98] hover:opacity-90"
          >
            Start
          </button>
        ) : (
          <button
            onClick={() => void stop()}
            disabled={status === "connecting"}
            className="rounded-full bg-red-500 px-5 py-2.5 text-[14px] font-medium text-white transition-all active:scale-[0.98] hover:bg-red-600 disabled:opacity-50"
          >
            Stop
          </button>
        )}
      </div>

      <div className="flex items-center gap-4 text-sm text-ink-soft">
        <span>
          Status: <span className="font-mono text-ink">{status}</span>
        </span>
        {sessionId && (
          <span>
            Session: <span className="font-mono text-ink">{sessionId}</span>
          </span>
        )}
        {status === "live" && (
          <div className="flex h-4 w-24 items-center overflow-hidden rounded-full bg-line">
            <div
              className="h-full bg-accent transition-all"
              style={{ width: `${Math.min(100, Math.round(level * 400))}%` }}
            />
          </div>
        )}
      </div>

      {error && (
        <p role="alert" className="rounded-xl border border-red-500/30 bg-red-950/20 px-4 py-3 text-sm text-red-200">
          {error}
        </p>
      )}

      <div className="max-h-72 overflow-y-auto rounded-xl border border-line bg-background p-4 font-mono text-[13px] text-ink-soft">
        {log.length === 0 ? (
          <p className="text-ink-soft/60">Nothing yet.</p>
        ) : (
          log.map((line) => <p key={line.id}>{line.text}</p>)
        )}
      </div>
    </div>
  );
}
