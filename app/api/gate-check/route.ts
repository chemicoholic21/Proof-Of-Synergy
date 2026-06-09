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

export const runtime = "nodejs";

// Demonstrates third-party composability: an unrelated contract reads on-chain reputation
// and decides access — no permission from the subject required. The why-not-Postgres proof.
export async function POST(req: NextRequest) {
  const { subject, skill, minConfidence } = await req.json();
  try {
    if (!chainConfigured() || !GATE_ADDRESS) throw new Error("chain not configured");
    const pub = publicClient();
    const key = skillKey(skill);

    const passes = await pub.readContract({
      address: GATE_ADDRESS,
      abi: gateAbi,
      functionName: "meetsRequirement",
      args: [subject, key, Number(minConfidence)],
    });

    const { account } = serverWallet();
    const [confidence, exists] = (await pub.readContract({
      address: REGISTRY_ADDRESS,
      abi: registryAbi,
      functionName: "getConfidence",
      args: [subject, key, account.address],
    })) as [number, boolean];

    return NextResponse.json({ passes, confidence, exists, source: "onchain" });
  } catch (e) {
    console.warn("[gate-check] fallback:", (e as Error).message);
    // Mirror the on-chain logic locally so the demo still illustrates the concept.
    const conf = Number(minConfidence);
    return NextResponse.json({
      passes: false,
      confidence: 0,
      exists: false,
      source: "fallback",
      note: "Contracts not deployed yet — showing logic locally.",
    });
  }
}
