import { NextRequest, NextResponse } from "next/server";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  chainConfigured,
  publicClient,
  serverWallet,
  registryAbi,
  passportAbi,
  skillKey,
  REGISTRY_ADDRESS,
  PASSPORT_ADDRESS,
  GATE_ADDRESS,
  EXPLORER_URL,
} from "@/lib/chain";
import { uploadMetadata, interviewHash } from "@/lib/ipfs";
import { MintResult } from "@/lib/types";
import { MintBody } from "@/lib/schemas";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { newRequestId, errorResponse, enforceRateLimit, parseJsonBody, ValidationError } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

// Constant-time-ish comparison to avoid leaking the secret via timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function POST(req: NextRequest) {
  const requestId = newRequestId();
  const log = logger.child({ requestId, route: "mint" });

  // This endpoint signs and submits on-chain transactions using the server's funded wallet.
  // It is rate-limited tightly and can be locked behind a shared secret.
  const limited = enforceRateLimit(req, "mint", requestId, { max: 5, windowMs: 60_000 });
  if (limited) return limited;

  // Auth: when MINT_API_SECRET is configured, require a matching bearer token.
  if (env.MINT_API_SECRET) {
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token || !safeEqual(token, env.MINT_API_SECRET)) {
      log.warn("mint unauthorized");
      return errorResponse(401, "unauthorized", "Missing or invalid authorization.", requestId);
    }
  } else if (env.isProduction && chainConfigured()) {
    // Refuse to expose a funded wallet to anonymous callers in production.
    log.error("mint blocked: MINT_API_SECRET not set while chain is configured in production");
    return errorResponse(503, "auth_required", "Minting is disabled: server is not configured with MINT_API_SECRET.", requestId);
  }

  let body;
  try {
    body = await parseJsonBody(req, MintBody);
  } catch (e) {
    if (e instanceof ValidationError) {
      return errorResponse(400, "invalid_body", "Invalid request body.", requestId, { details: e.details });
    }
    throw e;
  }
  const { verdicts, overall, name: candidateName, consent } = body;

  // CONSENT GATE: publishing makes the candidate's results public and permanent on-chain.
  // Refuse to mint unless the candidate has explicitly opted in.
  if (!consent) {
    log.warn("mint refused: candidate consent not granted");
    return errorResponse(
      403,
      "consent_required",
      "Candidate consent is required before publishing results on-chain.",
      requestId
    );
  }

  try {
    // A fresh subject wallet per interview (server attests about it — no candidate key needed).
    const subject = privateKeyToAccount(generatePrivateKey()).address;

    // Build evidence metadata (kept off-chain; only skills/scores, never raw resume/audio).
    const metadata = {
      candidate: { wallet: subject, name: candidateName },
      evaluator: "ProofOfSynergy AI v1.0 (Sarvam-M)",
      consent: { granted: true, recordedAt: new Date().toISOString() },
      overall,
      skills: verdicts.map((v) => ({
        name: v.skill,
        claimedLevel: v.claimedLevel,
        observedConfidence: v.observedConfidence,
        status: v.status,
      })),
    };
    const hash = interviewHash(metadata);

    if (!chainConfigured()) {
      if (!env.DEMO_MODE) {
        return errorResponse(503, "chain_unconfigured", "On-chain minting is unavailable: chain is not configured.", requestId);
      }
      // DEMO_MODE: contracts not deployed — return a clearly-labelled mock (no IPFS write required).
      const { uri: demoUri } = await uploadMetadata({ ...metadata, interviewHash: hash });
      return NextResponse.json({
        subject,
        registryAddress: REGISTRY_ADDRESS || "0x(deploy pending)",
        passportAddress: PASSPORT_ADDRESS || "0x(deploy pending)",
        gateAddress: GATE_ADDRESS || "0x(deploy pending)",
        attestTxHash: "0x" + "0".repeat(64),
        mintTxHash: "0x" + "0".repeat(64),
        tokenId: null,
        metadataURI: demoUri,
        explorerBase: EXPLORER_URL,
        source: "fallback",
      } satisfies MintResult);
    }

    // Pin real evidence to IPFS before writing the pointer on-chain.
    const { uri: metadataURI } = await uploadMetadata({ ...metadata, interviewHash: hash });

    const { client, account } = serverWallet();
    const pub = publicClient();
    const skills = verdicts.map((v) => skillKey(v.skill));
    const confidences = verdicts.map((v) => v.observedConfidence);

    // 1) Batch-attest all skills in one tx.
    const attestTxHash = await client.writeContract({
      address: REGISTRY_ADDRESS,
      abi: registryAbi,
      functionName: "attestBatch",
      args: [subject, skills, confidences, metadataURI],
      account,
      chain: undefined,
    });
    const attestReceipt = await pub.waitForTransactionReceipt({ hash: attestTxHash });
    if (attestReceipt.status !== "success") {
      throw new Error(`attestBatch reverted (tx ${attestTxHash})`);
    }

    // 2) Mint the soulbound passport.
    const mintTxHash = await client.writeContract({
      address: PASSPORT_ADDRESS,
      abi: passportAbi,
      functionName: "mint",
      args: [subject, metadataURI],
      account,
      chain: undefined,
    });
    const mintReceipt = await pub.waitForTransactionReceipt({ hash: mintTxHash });
    if (mintReceipt.status !== "success") {
      throw new Error(`mint reverted (tx ${mintTxHash})`);
    }

    const tokenId = await pub.readContract({
      address: PASSPORT_ADDRESS,
      abi: passportAbi,
      functionName: "passportOf",
      args: [subject],
    });

    log.info("mint complete", { subject, attestTxHash, mintTxHash });
    return NextResponse.json({
      subject,
      registryAddress: REGISTRY_ADDRESS,
      passportAddress: PASSPORT_ADDRESS,
      gateAddress: GATE_ADDRESS,
      attestTxHash,
      mintTxHash,
      tokenId: tokenId.toString(),
      metadataURI,
      explorerBase: EXPLORER_URL,
      source: "onchain",
    } satisfies MintResult);
  } catch (e) {
    log.error("mint failed", { error: e });
    return errorResponse(502, "mint_failed", `Minting failed: ${(e as Error).message}`, requestId);
  }
}
