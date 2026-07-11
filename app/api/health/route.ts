import { NextResponse } from "next/server";
import { env, sarvamConfigured, geminiConfigured } from "@/lib/env";
import { cogneePing, cogneeConfigured } from "@/lib/memory/cognee/client";
import { geminiPing } from "@/lib/gemini";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness probe. Reports which external dependencies are configured, and - crucially -
 * whether Cognee and Gemini are actually REACHABLE (a live ping), so a silent fallback can never
 * masquerade as a working integration during a demo.
 */
export async function GET() {
  const cognee = cogneeConfigured() ? await cogneePing() : { ok: false, status: null };
  const gemini = geminiConfigured() ? await geminiPing() : { ok: false, status: null };
  return NextResponse.json({
    status: "ok",
    demoMode: env.DEMO_MODE,
    environment: env.NODE_ENV,
    dependencies: {
      sarvam: sarvamConfigured(),
      cogneeConfigured: cogneeConfigured(),
      cogneeReachable: cognee.ok,
      geminiConfigured: geminiConfigured(),
      geminiReachable: gemini.ok,
    },
  });
}
