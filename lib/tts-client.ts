"use client";

/**
 * Client-side text-to-speech used for hands-free interview mode.
 *
 * Prefers Sarvam Bulbul (/api/tts); if that is unavailable, or the browser blocks autoplay of the
 * returned clip, it falls back to the browser's built-in SpeechSynthesis. `speak()` returns a
 * controller whose `done` promise resolves when playback finishes (or immediately if nothing can
 * play), and whose `stop()` cancels playback.
 */

export interface SpeechController {
  /** Resolves when playback finishes, errors, or is stopped. Never rejects. */
  done: Promise<void>;
  /** Stop any in-flight or ongoing playback. */
  stop: () => void;
}

function browserSpeak(text: string, language: string, isStopped: () => boolean): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof window === "undefined" || !window.speechSynthesis || isStopped()) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = language;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

export function speak(text: string, language = "en-IN"): SpeechController {
  let audioEl: HTMLAudioElement | null = null;
  let stopped = false;
  let finishPlayback: (() => void) | null = null;

  const done = (async () => {
    if (!text || !text.trim()) return;
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, language }),
      });
      if (stopped) return;
      const data = await res.json().catch(() => null);
      if (stopped) return;
      if (data?.audio) {
        await new Promise<void>((resolve) => {
          finishPlayback = resolve;
          const audio = new Audio(`data:audio/wav;base64,${data.audio}`);
          audioEl = audio;
          audio.onended = () => resolve();
          audio.onerror = () => resolve();
          audio
            .play()
            .then(() => {
              if (stopped) {
                audio.pause();
                resolve();
              }
            })
            .catch(() => {
              // Autoplay blocked (no user gesture) -> fall back to browser speech.
              browserSpeak(text, language, () => stopped).finally(() => resolve());
            });
        });
        return;
      }
    } catch {
      /* fall through to browser speech */
    }
    if (stopped) return;
    await browserSpeak(text, language, () => stopped);
  })();

  return {
    done,
    stop: () => {
      stopped = true;
      try {
        audioEl?.pause();
      } catch {
        /* ignore */
      }
      if (typeof window !== "undefined") window.speechSynthesis?.cancel();
      // Resolve any in-flight playback promise so `done` settles immediately on stop.
      finishPlayback?.();
      finishPlayback = null;
    },
  };
}
