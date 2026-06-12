import { NextResponse } from "next/server";
import { env, sarvamConfigured, chainConfigured, ipfsConfigured } from "@/lib/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Liveness + readiness probe. Reports which external dependencies are configured so an operator
 * (or an uptime monitor) can tell at a glance whether the deployment is fully production-ready or
 * running in degraded/demo mode.
 */
export async function GET() {
  return NextResponse.json({
    status: "ok",
    demoMode: env.DEMO_MODE,
    environment: env.NODE_ENV,
    dependencies: {
      sarvam: sarvamConfigured(),
      chain: chainConfigured(),
      ipfs: ipfsConfigured(),
      mintAuth: Boolean(env.MINT_API_SECRET),
    },
  });
}
