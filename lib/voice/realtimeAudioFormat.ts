/**
 * lib/voice/realtimeAudioFormat.ts
 *
 * The wire format both ends of the realtime voice path must agree on: `server/voice-gateway.ts`
 * (when it builds the default `BulbulV3TTSProvider`) and `lib/voice-client/RealtimeAudioCapture.ts`
 * (when it captures the microphone and decodes incoming audio) both import this instead of hardcoding
 * the same numbers twice.
 *
 * Raw `linear16` PCM, not Bulbul's default `mp3`, because a realtime client needs to play each
 * `SpeechChunker` piece back the instant it arrives — decoding a compressed format chunk-by-chunk
 * in a browser, where each chunk isn't necessarily a self-contained encoded unit, is exactly the
 * kind of complexity a realtime path should avoid. `SarvamRealtimeSTT`'s own default input encoding
 * makes the same choice for the same reason (see lib/providers/stt/SarvamRealtimeSTT.ts).
 */

export const REALTIME_AUDIO_SAMPLE_RATE = 16000;
export const REALTIME_AUDIO_CODEC = "linear16" as const;
