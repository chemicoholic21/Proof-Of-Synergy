/**
 * Typed event model for the voice interview system.
 *
 * `InterviewEvent` is a discriminated union describing everything that can happen over the
 * lifetime of one voice turn — from the moment the microphone hears speech through transcription,
 * the agent's reply, spoken playback of that reply, and the eventual post-session evaluation —
 * plus the interruption and error conditions that can cut any of those legs short.
 *
 * This module is intentionally **types only**: no emitter, event bus, reducer, or state machine
 * lives here, and nothing in this file has any runtime behavior. It exists so the rest of the
 * voice pipeline has one shared vocabulary to describe "what happened" instead of every call site
 * inventing its own ad hoc shape — later phases can build an emitter/reducer/store on top of this
 * without renegotiating field names.
 *
 * The event names deliberately line up with concepts already instrumented elsewhere in this
 * codebase so a future emitter can be a thin wrapper around existing call sites rather than a
 * parallel pipeline:
 *
 *   - SPEECH_STARTED / SPEECH_ENDED        <-> lib/vad.ts, the VAD's speech on/offset
 *                                              (see `speech_detected` / `speech_end` in
 *                                              lib/voice-latency.ts and
 *                                              lib/observability/VoiceMetrics.ts).
 *   - PARTIAL_TRANSCRIPT / FINAL_TRANSCRIPT <-> lib/sarvam.ts STT (`sarvamTranscribe`); PARTIAL
 *                                              is forward-looking (today's STT call is not
 *                                              streaming — see docs/voice-architecture-current.md
 *                                              §4 — so no producer emits it yet).
 *   - TURN_COMPLETED                        <-> one full user answer has been finalized and is
 *                                              ready to hand to the agent (app/practice/page.tsx
 *                                              `handleUserInput`).
 *   - AGENT_GENERATION_*                    <-> lib/prompts.ts `generatePartnerReply` /
 *                                              app/api/gemini/route.ts. TOKEN is forward-looking
 *                                              (neither the Sarvam nor Gemini chat call streams
 *                                              today — see lib/observability/VoiceMetrics.ts's
 *                                              docstring on `llm_first_token`).
 *   - TTS_PLAYBACK_*                        <-> lib/tts-client.ts `speak()` and its audio/
 *                                              speechSynthesis playback.
 *   - AGENT_INTERRUPTED                     <-> the learner barges in while the agent is still
 *                                              generating or being read aloud (no producer wired
 *                                              up yet; `SpeechController.stop()` in
 *                                              lib/tts-client.ts is the closest existing hook).
 *   - EVALUATION_COMPLETED                  <-> app/api/coaching/summary (the end-of-session
 *                                              coaching summary), or per-turn heuristic coaching
 *                                              (lib/coaching.ts `analyzeWithHeuristics`).
 *   - ERROR                                 <-> any of the above stages failing (mirrors the
 *                                              `code`/`message` shape API routes already return
 *                                              via `errorResponse` in lib/http.ts, without the
 *                                              HTTP-specific fields).
 *
 * All timestamps are epoch milliseconds (`Date.now()`), matching the convention already used by
 * `lib/voice-latency.ts` and `lib/observability/VoiceMetrics.ts` so events and latency marks can
 * be correlated on the same timeline.
 */

/** Which leg of the pipeline an `ERROR` event originated from. */
export type InterviewErrorStage =
  | "SPEECH"
  | "TRANSCRIPTION"
  | "AGENT_GENERATION"
  | "TTS_PLAYBACK"
  | "EVALUATION";

/** Which in-flight activity an `AGENT_INTERRUPTED` event cut short, when known. */
export type InterviewInterruptedStage = "AGENT_GENERATION" | "TTS_PLAYBACK";

export type InterviewEvent =
  /** The microphone/VAD detected the start of the learner speaking. */
  | {
      type: "SPEECH_STARTED";
      timestamp: number;
    }
  /** The microphone/VAD detected the end of the learner's speech (trailing silence). */
  | {
      type: "SPEECH_ENDED";
      timestamp: number;
    }
  /** An incremental, not-yet-final transcript fragment for the in-progress utterance. */
  | {
      type: "PARTIAL_TRANSCRIPT";
      text: string;
      timestamp: number;
    }
  /** The finalized transcript for the completed utterance. */
  | {
      type: "FINAL_TRANSCRIPT";
      text: string;
      timestamp: number;
    }
  /** The learner's turn is complete and ready to be handed to the agent. */
  | {
      type: "TURN_COMPLETED";
      timestamp: number;
    }
  /** The agent has begun generating a reply. */
  | {
      type: "AGENT_GENERATION_STARTED";
      timestamp: number;
    }
  /** An incremental token/chunk of the agent's reply as it streams in. */
  | {
      type: "AGENT_GENERATION_TOKEN";
      token: string;
      timestamp: number;
    }
  /** The agent's reply has finished generating. */
  | {
      type: "AGENT_GENERATION_COMPLETED";
      text: string;
      timestamp: number;
    }
  /** Text-to-speech playback of the agent's reply has started. */
  | {
      type: "TTS_PLAYBACK_STARTED";
      timestamp: number;
    }
  /** Text-to-speech playback of the agent's reply has finished. */
  | {
      type: "TTS_PLAYBACK_COMPLETED";
      timestamp: number;
    }
  /** The learner interrupted the agent while it was generating or speaking. */
  | {
      type: "AGENT_INTERRUPTED";
      /** Which agent activity was in flight when the interruption happened, when known. */
      interruptedStage?: InterviewInterruptedStage;
      timestamp: number;
    }
  /** Post-turn or post-session evaluation (coaching summary / metrics) has finished. */
  | {
      type: "EVALUATION_COMPLETED";
      summary: string;
      timestamp: number;
    }
  /** Any pipeline stage failed. */
  | {
      type: "ERROR";
      stage: InterviewErrorStage;
      message: string;
      /** Optional machine-readable error code, mirroring the `code` field API routes already
       *  return (see `errorResponse` in lib/http.ts). */
      code?: string;
      timestamp: number;
    };

/** The `type` discriminant of every `InterviewEvent` variant. */
export type InterviewEventType = InterviewEvent["type"];

/** Every event type, in the order a single happy-path turn would emit them. Useful for
 *  exhaustiveness checks and fixtures — this is a data manifest, not a dispatcher. */
export const INTERVIEW_EVENT_TYPES: readonly InterviewEventType[] = [
  "SPEECH_STARTED",
  "SPEECH_ENDED",
  "PARTIAL_TRANSCRIPT",
  "FINAL_TRANSCRIPT",
  "TURN_COMPLETED",
  "AGENT_GENERATION_STARTED",
  "AGENT_GENERATION_TOKEN",
  "AGENT_GENERATION_COMPLETED",
  "TTS_PLAYBACK_STARTED",
  "TTS_PLAYBACK_COMPLETED",
  "AGENT_INTERRUPTED",
  "EVALUATION_COMPLETED",
  "ERROR",
];
