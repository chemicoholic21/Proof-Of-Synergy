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
import { MintResult, SkillVerdict } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json();
  const verdicts: SkillVerdict[] = body.verdicts ?? [];
  const overall: number = body.overall ?? 0;
  const candidateName: string = body.name ?? "Anonymous";

  // A fresh subject wallet per interview (server attests about it — no candidate key needed).
  const subject = privateKeyToAccount(generatePrivateKey()).address;

  // Build evidence metadata (kept off-chain; only skills/scores, never raw resume/audio).
  const metadata = {
    candidate: { wallet: subject, name: candidateName },
    evaluator: "ProofOfSynergy AI v1.0 (Sarvam-M)",
    overall,
    skills: verdicts.map((v) => ({
      name: v.skill,
      claimedLevel: v.claimedLevel,
      observedConfidence: v.observedConfidence,
      status: v.status,
    })),
  };
  const hash = interviewHash(metadata);
  const { uri: metadataURI } = await uploadMetadata({ ...metadata, interviewHash: hash });

  if (!chainConfigured()) {
    // Honest fallback: contracts not yet deployed/funded. Return a clearly-labelled mock.
    return NextResponse.json({
      subject,
      registryAddress: REGISTRY_ADDRESS || "0x(deploy pending)",
      passportAddress: PASSPORT_ADDRESS || "0x(deploy pending)",
      gateAddress: GATE_ADDRESS || "0x(deploy pending)",
      attestTxHash: "0x" + "0".repeat(64),
      mintTxHash: "0x" + "0".repeat(64),
      tokenId: null,
      metadataURI,
      explorerBase: EXPLORER_URL,
      source: "fallback",
    } satisfies MintResult);
  }

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
  await pub.waitForTransactionReceipt({ hash: attestTxHash });

  // 2) Mint the soulbound passport.
  const mintTxHash = await client.writeContract({
    address: PASSPORT_ADDRESS,
    abi: passportAbi,
    functionName: "mint",
    args: [subject, metadataURI],
    account,
    chain: undefined,
  });
  await pub.waitForTransactionReceipt({ hash: mintTxHash });

  const tokenId = await pub.readContract({
    address: PASSPORT_ADDRESS,
    abi: passportAbi,
    functionName: "passportOf",
    args: [subject],
  });

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
}
