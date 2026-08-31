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

/**
 * `speechSynthesis.getVoices()` is frequently empty on the first call because voice lists load
 * asynchronously (most notably Chrome). Wait for the `voiceschanged` event, but don't hang forever
 * if a browser never fires it (older Safari) -> resolve with whatever is available after a short
 * timeout.
 */
function loadVoices(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
  const existing = synth.getVoices();
  if (existing.length > 0) return Promise.resolve(existing);
  return new Promise((resolve) => {
    const done = (voices: SpeechSynthesisVoice[]) => {
      clearTimeout(timer);
      synth.onvoiceschanged = null;
      resolve(voices);
    };
    const timer = setTimeout(() => done(synth.getVoices()), 300);
    synth.onvoiceschanged = () => done(synth.getVoices());
  });
}

// Names that indicate a higher-fidelity neural/cloud voice rather than the platform's default
// robotic/compact synthesizer (e.g. eSpeak on Linux, or "Compact"-tier voices on iOS/macOS).
const HQ_VOICE_HINT = /natural|neural|online|enhanced|premium|wavenet|google/i;
const LQ_VOICE_HINT = /compact|espeak/i;

/**
 * Pick the best-sounding voice available for `language`. Prefers an exact language match over a
 * base-language match (e.g. "en-IN" over another "en-*"), and within a match tier prefers voices
 * whose name signals a higher-quality neural/cloud engine over the default compact/robotic one.
 */
function pickVoice(voices: SpeechSynthesisVoice[], language: string): SpeechSynthesisVoice | null {
  if (voices.length === 0) return null;
  const base = language.split("-")[0].toLowerCase();
  const score = (v: SpeechSynthesisVoice) => {
    let s = 0;
    if (v.lang?.toLowerCase() === language.toLowerCase()) s += 20;
    else if (v.lang?.toLowerCase().startsWith(base)) s += 10;
    else return -1; // wrong language entirely, never pick it
    if (HQ_VOICE_HINT.test(v.name)) s += 5;
    if (LQ_VOICE_HINT.test(v.name)) s -= 5;
    if (v.default) s += 1;
    return s;
  };
  const ranked = voices.map((v) => ({ v, s: score(v) })).filter((x) => x.s >= 0);
  if (ranked.length === 0) return null;
  ranked.sort((a, b) => b.s - a.s);
  return ranked[0].v;
}

async function browserSpeak(text: string, language: string, isStopped: () => boolean): Promise<void> {
  if (typeof window === "undefined" || !window.speechSynthesis || isStopped()) return;
  const synth = window.speechSynthesis;
  const voices = await loadVoices(synth);
  if (isStopped()) return;
  return new Promise<void>((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = language;
    const voice = pickVoice(voices, language);
    if (voice) u.voice = voice;
    // A hair under natural pace and full pitch reads less clipped/robotic than the raw default,
    // which most engines otherwise render slightly fast and flat.
    u.rate = 0.97;
    u.pitch = 1.0;
    u.onend = () => resolve();
    u.onerror = () => resolve();
    synth.cancel();
    synth.speak(u);
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
