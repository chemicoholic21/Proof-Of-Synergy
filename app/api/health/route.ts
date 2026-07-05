import { NextResponse } from "next/server";
import { env, sarvamConfigured, cogneeConfigured } from "@/lib/env";
import { cogneePing } from "@/lib/memory/cognee/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
  * Liveness + readiness probe. Reports which external dependencies are configured, and - crucially -
  * whether Cognee is actually REACHABLE (a live ping), so a silent fallback to the local graph
  * engine can never masquerade as a working Cognee integration during a demo.
  */
export async function GET() {
  const cognee = cogneeConfigured() ? await cogneePing() : { ok: false, status: null };
  return NextResponse.json({
    status: "ok",
    demoMode: env.DEMO_MODE,
    environment: env.NODE_ENV,
    dependencies: {
      sarvam: sarvamConfigured(),
      cogneeConfigured: cogneeConfigured(),
      cogneeReachable: cognee.ok,
    },
  });
}
