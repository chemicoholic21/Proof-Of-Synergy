import { NextRequest, NextResponse } from "next/server";
import { parseAbiItem, decodeEventLog } from "viem";
import { publicClient } from "@/lib/chain";

export const runtime = "nodejs";

// Reads a transaction back from the chain and decodes its ProofOfSynergy events, so a judge can
// verify on-chain data IN the app — no dependency on an external block explorer being available
// for this network.
const ATTESTED = parseAbiItem(
  "event Attested(address indexed subject, bytes32 indexed skill, address indexed attester, uint8 confidence, string evidenceURI, uint64 timestamp)"
);
const MINTED = parseAbiItem(
  "event PassportMinted(address indexed to, uint256 indexed tokenId, string tokenURI)"
);

export async function POST(req: NextRequest) {
  const { hash } = await req.json();
  try {
    const pub = publicClient();
    const receipt = await pub.getTransactionReceipt({ hash });

    const events: { type: string; fields: Record<string, string> }[] = [];
    for (const log of receipt.logs) {
      for (const ev of [ATTESTED, MINTED]) {
        try {
          const dec = decodeEventLog({ abi: [ev], data: log.data, topics: log.topics });
          const args = dec.args as Record<string, unknown>;
          events.push({
            type: dec.eventName,
            fields: Object.fromEntries(
              Object.entries(args).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : String(v)])
            ),
          });
        } catch {
          /* not this event */
        }
      }
    }

    return NextResponse.json({
      ok: true,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      from: receipt.from,
      to: receipt.to,
      gasUsed: receipt.gasUsed.toString(),
      logCount: receipt.logs.length,
      events,
    });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 200 });
  }
}
