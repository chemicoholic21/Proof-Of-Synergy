"use client";

/**
 * app/practice/realtime/page.tsx
 *
 * The "minimal, clearly-labeled integration point" for the realtime voice architecture — a
 * separate route from `/practice`, which keeps running the existing, working batch pipeline
 * completely untouched. Requires `server/voice-gateway.ts` running separately (`npm run
 * voice-gateway`) — this page does not start it.
 */

import Link from "next/link";
import RealtimeVoiceRecorder from "@/components/RealtimeVoiceRecorder";

export default function RealtimePracticePage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="mx-auto w-full max-w-3xl px-6 sm:px-10 py-10">
        <Link href="/practice" className="text-sm text-ink-soft hover:text-ink">
          ← Back to practice
        </Link>

        <h1 className="heading-font mt-4 text-3xl font-bold text-ink">Realtime voice (experimental)</h1>
        <p className="mt-2 text-sm text-ink-soft">
          This talks to the standalone WebSocket gateway in <code>server/voice-gateway.ts</code> —
          start it separately with <code>npm run voice-gateway</code> (default{" "}
          <code>ws://localhost:3001</code>). It is independent of, and does not affect, the regular
          practice flow at <code>/practice</code>.
        </p>

        <div className="mt-8">
          <RealtimeVoiceRecorder />
        </div>
      </main>
    </div>
  );
}
