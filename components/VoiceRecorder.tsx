"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { VoiceActivityDetector, UtteranceDetector } from "@/lib/vad";
import { VoiceLatencyTracker, type VoiceLatencyTimestamps } from "@/lib/voice-latency";

/** Imperative handle so a parent can drive recording (e.g. hands-free interview mode). */
export interface VoiceRecorderHandle {
  start: () => void;
  stop: () => void;
}

const SEGMENT_MS = 25_000;
const VAD_THRESHOLD = 0.015;
const SPEECH_PAD_MS = 200;
const SILENCE_TIMEOUT_MS = 1200;
// After the user has spoken and then stays silent for this long, we treat it as
// a "long pause" and automatically stop the recording — no need to press "Stop"
// for every answer. Kept well above SILENCE_TIMEOUT_MS so natural pauses between
// sentences don't cut the recording short.
const AUTO_STOP_SILENCE_MS = 3000;

const VoiceRecorder = forwardRef<VoiceRecorderHandle, {
  // The 3rd arg is the browser live-transcript captured while speaking (fallback transcript).
  // The 4th arg carries this recording's client-side latency marks (mic_start, speech_detected,
  // speech_end) for the caller to fold into a VoiceLatencyTracker alongside the server-side stages.
  onRecorded: (blobs: Blob[], durationSec: number, liveText?: string, latency?: VoiceLatencyTimestamps) => void;
  onUtteranceEnd?: (text: string) => void;
  onRecordingStart?: () => void;
  disabled?: boolean;
  streamToWs?: boolean;
}>(function VoiceRecorder({
  onRecorded,
  onUtteranceEnd,
  onRecordingStart,
  disabled,
  streamToWs,
}, ref) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [hasClip, setHasClip] = useState(false);
  const [vadActive, setVadActive] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const mediaRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const segmentsRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rotateRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keepGoingRef = useRef(false);
  const streamRef = useRef<MediaStream | null>(null);
  const startMsRef = useRef(0);
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  const utteranceRef = useRef<UtteranceDetector | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamToWsRef = useRef(streamToWs ?? false);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const vadRafRef = useRef<number | null>(null);
  const [autoStopped, setAutoStopped] = useState(false);
  // Per-recording latency tracker: mic_start is marked in start(), speech_detected/speech_end are
  // marked from the VAD tick loop below, and the finished snapshot rides along with onRecorded so
  // the caller can merge in the server-side STT/LLM/TTS stages for this same turn.
  const latencyRef = useRef<VoiceLatencyTracker | null>(null);
  const wasSpeakingRef = useRef(false);
  // The *last* moment speech ended before the trailing silence that actually stops the recording —
  // captured live so a mid-answer pause never gets mistaken for the real end of speech.
  const lastSpeechEndAtRef = useRef<number | null>(null);
  // Live (word-by-word) transcript via the browser SpeechRecognition API — pure UX feedback so the
  // user sees they're being heard. The authoritative transcript still comes from Sarvam STT.
  const [liveTranscript, setLiveTranscript] = useState("");
  const recognitionRef = useRef<any>(null);
  const finalTranscriptRef = useRef("");
  const onUtteranceEndRef = useRef(onUtteranceEnd);
  // onRecorded/onRecordingStart change identity every turn (they close over `messages`), so the
  // imperative start()/stop() (captured once) must reach the LATEST versions via refs, or an
  // auto-started recording would submit through a stale handler and lose conversation context.
  const onRecordedRef = useRef(onRecorded);
  const onRecordingStartRef = useRef(onRecordingStart);

  onUtteranceEndRef.current = onUtteranceEnd;
  onRecordedRef.current = onRecorded;
  onRecordingStartRef.current = onRecordingStart;
  streamToWsRef.current = streamToWs ?? false;

  useImperativeHandle(ref, () => ({ start, stop }), []);

  function clearTimers() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (rotateRef.current) clearTimeout(rotateRef.current);
  }

  /** Start live captions via the browser SpeechRecognition API (no-op if unsupported). */
  function startRecognition() {
    try {
      const Ctor =
        typeof window !== "undefined"
          ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
          : null;
      if (!Ctor) return; // Firefox / unsupported: recording still works, just no live captions.
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;
      rec.lang = "en-IN";
      finalTranscriptRef.current = "";
      rec.onresult = (e: any) => {
        let interim = "";
        let final = finalTranscriptRef.current;
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const chunk = e.results[i][0]?.transcript ?? "";
          if (e.results[i].isFinal) final += chunk + " ";
          else interim += chunk;
        }
        finalTranscriptRef.current = final;
        setLiveTranscript((final + interim).replace(/\s+/g, " ").trim());
      };
      rec.onerror = () => {};
      rec.onend = () => {};
      recognitionRef.current = rec;
      rec.start();
    } catch {
      /* ignore — live captions are best-effort */
    }
  }

  function stopRecognition() {
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
    recognitionRef.current = null;
  }

  useEffect(() => {
    return () => {
      clearTimers();
      if (vadRafRef.current !== null) cancelAnimationFrame(vadRafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
      vadRef.current?.stop();
      utteranceRef.current?.reset();
      stopRecognition();
      if (audioCtxRef.current) {
        audioCtxRef.current.close().catch(() => {});
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, []);

  function connectWs(sessionId: string): void {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/api/voice/ws`;
    const ws = new WebSocket(url);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "register", sessionId }));
    };
    ws.onmessage = () => {};
    ws.onerror = () => {};
    wsRef.current = ws;
  }

  function sendAudioChunk(chunk: Blob): void {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = reader.result as string;
      wsRef.current?.send(JSON.stringify({ type: "audio-chunk", payload: { data: base64, encoding: "base64" } }));
    };
    reader.readAsDataURL(chunk);
  }

  function startSegment(stream: MediaStream) {
    const mr = new MediaRecorder(stream);
    chunksRef.current = [];
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
        if (streamToWsRef.current) {
          sendAudioChunk(e.data);
        }
      }
    };
    mr.onstop = () => {
      if (chunksRef.current.length) {
        segmentsRef.current.push(new Blob(chunksRef.current, { type: "audio/webm" }));
      }
      if (keepGoingRef.current) {
        startSegment(stream);
      } else {
        streamRef.current?.getTracks().forEach((t) => t.stop());
        setHasClip(true);
        const durationSec = Math.max(1, Math.round((performance.now() - startMsRef.current) / 1000));
        // Commit speech_end now, using the last real speech->silence transition if the VAD ever saw
        // one, else falling back to "now" (e.g. the user was cut off mid-word by the segment/manual
        // stop rather than tailing off into silence).
        latencyRef.current?.mark("speech_end", lastSpeechEndAtRef.current ?? Date.now());
        const latencyMarks = latencyRef.current?.snapshot();
        onRecordedRef.current(segmentsRef.current.slice(), durationSec, finalTranscriptRef.current.trim(), latencyMarks);
      }
    };
    mr.start();
    mediaRef.current = mr;
    rotateRef.current = setTimeout(() => {
      if (mr.state === "recording") mr.stop();
    }, SEGMENT_MS);
  }

  function setupVad(stream: MediaStream): void {
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
    }
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);

    audioCtxRef.current = audioCtx;
    sourceRef.current = source;
    analyserRef.current = analyser;

    const vad = new VoiceActivityDetector({
      threshold: VAD_THRESHOLD,
      speechPadMs: SPEECH_PAD_MS,
      silenceTimeoutMs: SILENCE_TIMEOUT_MS,
    });
    const utterance = new UtteranceDetector({
      threshold: VAD_THRESHOLD,
      speechPadMs: SPEECH_PAD_MS,
      silenceTimeoutMs: SILENCE_TIMEOUT_MS,
    });

    vadRef.current = vad;
    utteranceRef.current = utterance;

    const dataArray = new Float32Array(analyser.fftSize);

    const tick = (): void => {
      if (!analyserRef.current || !dataArray) return;
      analyserRef.current.getFloatTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i] * dataArray[i];
      }
      const rms = Math.sqrt(sum / dataArray.length);
      const vadResult = vad.evaluate(rms);
      setIsSpeaking(vadResult.isSpeaking);
      const utteranceState = utterance.update(rms);
      // speech_detected fires once, on the first speech onset of this recording. speech_end is not
      // marked here — a mid-answer pause would flip isSpeaking false and then true again, and only
      // the *last* such transition (right before the recording actually stops) is the real one — so
      // we just remember the timestamp here and let mr.onstop commit whichever was most recent.
      if (!wasSpeakingRef.current && utteranceState.isSpeaking) {
        latencyRef.current?.mark("speech_detected");
      } else if (wasSpeakingRef.current && !utteranceState.isSpeaking) {
        lastSpeechEndAtRef.current = Date.now();
      }
      wasSpeakingRef.current = utteranceState.isSpeaking;
      if (utteranceState.isFinal && onUtteranceEndRef.current) {
        onUtteranceEndRef.current("");
      }
      // Auto-stop after a long pause. VAD already tracks silence duration, so a
      // sustained pause ends the recording without the user pressing "Stop".
      if (keepGoingRef.current && utteranceState.silenceDurationMs >= AUTO_STOP_SILENCE_MS) {
        setAutoStopped(true);
        stop();
        return;
      }
      vadRafRef.current = requestAnimationFrame(tick);
    };

    vadRafRef.current = requestAnimationFrame(tick);
    setVadActive(true);
  }

  async function start() {
    // Guard against double-start (e.g. auto-start + a manual tap racing).
    if (keepGoingRef.current || (mediaRef.current && mediaRef.current.state === "recording")) return;
    onRecordingStartRef.current?.();
    setError(null);
    setHasClip(false);
    setAutoStopped(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      segmentsRef.current = [];
      keepGoingRef.current = true;
      startMsRef.current = performance.now();
      latencyRef.current = new VoiceLatencyTracker();
      latencyRef.current.mark("mic_start");
      wasSpeakingRef.current = false;
      lastSpeechEndAtRef.current = null;
      startSegment(stream);
      setupVad(stream);
      setLiveTranscript("");
      startRecognition();
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((s) => s + 1), 1000);
      if (streamToWsRef.current) {
        connectWs(`session_${Date.now()}`);
      }
    } catch {
      setError("Microphone access blocked. Please allow mic access in your browser settings and try again.");
    }
  }

  function stop() {
    keepGoingRef.current = false;
    if (rotateRef.current) clearTimeout(rotateRef.current);
    if (vadRafRef.current !== null) {
      cancelAnimationFrame(vadRafRef.current);
      vadRafRef.current = null;
    }
    if (mediaRef.current && mediaRef.current.state === "recording") mediaRef.current.stop();
    setRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
    if (vadRef.current) {
      vadRef.current.stop();
      setVadActive(false);
    }
    if (utteranceRef.current) {
      utteranceRef.current.reset();
    }
    stopRecognition();
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
  }

  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-4 flex-wrap">
        {!recording ? (
          <button
            onClick={start}
            disabled={disabled}
            className={`flex items-center gap-2 rounded-full px-5 py-2.5 text-[14px] font-medium transition-all duration-300 active:scale-[0.98] ${
              hasClip
                ? "bg-white/10 text-white border border-white/10 hover:bg-white/15"
                : "bg-accent/10 text-accent border border-accent/20 hover:bg-accent/20 hover:border-accent/35"
            } disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            <svg
              className={`h-4.5 w-4.5 ${hasClip ? "text-zinc-400" : "text-accent"}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 18.75a6 6 0 0 0 6-6v-1.5m-6 7.5a6 6 0 0 1-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 0 1-3-3V4.5a3 3 0 1 1 6 0v8.25a3 3 0 0 1-3 3Z"
              />
            </svg>
            <span>{hasClip ? "Re-record audio" : "Speak"}</span>
          </button>
        ) : (
          <button
            onClick={stop}
            className="pulse-record-active flex items-center gap-2 rounded-full bg-red-500 px-5 py-2.5 text-[14px] font-medium text-white transition-all duration-300 active:scale-[0.98] hover:bg-red-600"
          >
            <svg className="h-4.5 w-4.5 text-white" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="6" width="12" height="12" rx="1.5" />
            </svg>
            <span>Stop recording</span>
          </button>
        )}

        <div className="flex items-center gap-3">
          <span className="font-mono text-base font-semibold tabular-nums text-zinc-400">
            {mm}:{ss}
          </span>

          {recording && (
            <div className="flex h-5 items-end gap-1 px-1">
              {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => (
                <span
                  key={i}
                  className="wavebar w-1 rounded-full bg-accent"
                  style={{
                    height: "100%",
                    animationDelay: `${i * 0.07}s`,
                    animationDuration: `${0.6 + (i % 3) * 0.2}s`,
                  }}
                />
              ))}
            </div>
          )}

          {vadActive && (
            <span
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[10px] font-semibold border ${
                isSpeaking
                  ? "border-emerald-500/30 bg-emerald-950/10 text-emerald-400"
                  : "border-zinc-500/20 bg-zinc-950/10 text-zinc-400"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${isSpeaking ? "bg-emerald-400 animate-pulse" : "bg-zinc-500"}`}
              />
              {isSpeaking ? "Speaking" : "Silence"}
            </span>
          )}

          {hasClip && !recording && (
            <span className="flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-3 py-1 text-xs font-semibold text-emerald-400 border border-emerald-500/20 shadow-[0_0_12px_rgba(16,185,129,0.1)]">
              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="m4.5 12.75 6 6 9-13.5" />
              </svg>
              <span>{autoStopped ? "Auto-captured" : "Captured"}</span>
            </span>
          )}
        </div>
      </div>

      {recording && (
        <div className="rounded-xl border border-accent/25 bg-black/30 px-4 py-3">
          <div className="flex items-center gap-2 text-[10px] uppercase tracking-widest font-bold text-accent">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            Listening — live transcript
          </div>
          <p className="mt-1.5 text-[14px] leading-relaxed text-ink">
            {liveTranscript || <span className="text-ink-soft/70">Start speaking…</span>}
          </p>
        </div>
      )}

      {!recording && liveTranscript && (
        <p className="text-[12px] text-ink-soft">
          <span className="font-semibold text-accent">Transcribing…</span> “{liveTranscript}”
        </p>
      )}

      {recording && (
        <p className="text-[11px] text-zinc-500">
          Recording stops automatically when you pause — or tap “Stop recording”.
        </p>
      )}

      {error && (
        <p className="flex items-center gap-1.5 text-sm font-medium text-red-400">
          <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
          {error}
        </p>
      )}
    </div>
  );
});

export default VoiceRecorder;