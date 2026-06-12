import { NextRequest, NextResponse } from "next/server";
import {
  chainConfigured,
  publicClient,
  gateAbi,
  registryAbi,
  skillKey,
  GATE_ADDRESS,
  REGISTRY_ADDRESS,
  serverWallet,
} from "@/lib/chain";
import { GateCheckBody } from "@/lib/schemas";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";

// Demonstrates third-party composability: an unrelated contract reads on-chain reputation
// and decides access, no permission from the subject required.
export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "gate-check" });

  const limited = enforceRateLimit(req, "gate-check", requestId);
  if (limited) return limited;

  let subject: string, skill: string, minConfidence: number;
  try {
    ({ subject, skill, minConfidence } = await parseJsonBody(req, GateCheckBody));
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    }
    throw e;
  }

  try {
    if (!chainConfigured() || !GATE_ADDRESS) throw new Error("chain not configured");
    const pub = publicClient();
    const key = skillKey(skill);

    const passes = await pub.readContract({
      address: GATE_ADDRESS,
      abi: gateAbi,
      functionName: "meetsRequirement",
      args: [subject as `0x${string}`, key, minConfidence],
    });

    const { account } = serverWallet();
    const [confidence, exists] = (await pub.readContract({
      address: REGISTRY_ADDRESS,
      abi: registryAbi,
      functionName: "getConfidence",
      args: [subject as `0x${string}`, key, account.address],
    })) as [number, boolean];

    return NextResponse.json({ passes, confidence, exists, source: "onchain" });
  } catch (e) {
    log.warn("gate-check fallback", { error: (e as Error).message });
    if (!env.DEMO_MODE) {
      return errorResponse(503, "chain_unconfigured", "Gate check is unavailable: chain is not configured.", requestId);
    }
    return NextResponse.json({
      passes: false,
      confidence: 0,
      exists: false,
      source: "fallback",
      note: "Contracts not deployed yet, showing logic locally (DEMO_MODE).",
    });
  }
}
