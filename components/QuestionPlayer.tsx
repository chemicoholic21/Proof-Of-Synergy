"use client";

import { useRef, useState } from "react";

// Plays an interview question aloud. Prefers Sarvam's Bulbul TTS (/api/tts); if that is
// unavailable (no API key, timeout, etc.) it falls back to the browser's built-in
// SpeechSynthesis so the feature still works — and shows which engine was used.
export default function QuestionPlayer({
  text,
  language = "en-IN",
}: {
  text: string;
  language?: string;
}) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const [engine, setEngine] = useState<"bulbul" | "browser" | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  function reset() {
    setState("idle");
  }

  function speakWithBrowser() {
    if (typeof window === "undefined" || !window.speechSynthesis) {
      reset();
      return;
    }
    setEngine("browser");
    const u = new SpeechSynthesisUtterance(text);
    u.lang = language;
    u.onend = reset;
    u.onerror = reset;
    setState("playing");
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  }

  async function play() {
    if (state === "playing") {
      audioRef.current?.pause();
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
      reset();
      return;
    }
    setState("loading");
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, language }),
      });
      const data = await res.json();
      if (data.audio) {
        setEngine("bulbul");
        const audio = new Audio(`data:audio/wav;base64,${data.audio}`);
        audioRef.current = audio;
        audio.onended = reset;
        audio.onerror = () => speakWithBrowser();
        setState("playing");
        await audio.play();
      } else {
        speakWithBrowser();
      }
    } catch {
      speakWithBrowser();
    }
  }

  return (
    <button
      type="button"
      onClick={play}
      title={engine === "browser" ? "Bulbul unavailable — using browser voice" : "Listen (Bulbul AI voice)"}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold border transition-all duration-300 ${
        state === "playing"
          ? "bg-cyan-500/15 border-cyan-500/40 text-cyan-300"
          : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-cyan-300 hover:border-cyan-500/30"
      }`}
    >
      {state === "loading" ? (
        <svg className="h-3.5 w-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992m-4.993 5.304a8.25 8.25 0 1 1-1.353-9.243" />
        </svg>
      ) : state === "playing" ? (
        <svg className="h-3.5 w-3.5" fill="currentColor" viewBox="0 0 24 24">
          <rect x="6" y="5" width="4" height="14" rx="1" />
          <rect x="14" y="5" width="4" height="14" rx="1" />
        </svg>
      ) : (
        <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z" />
        </svg>
      )}
      <span>{state === "playing" ? "Stop" : state === "loading" ? "Loading…" : "Listen"}</span>
    </button>
  );
}
