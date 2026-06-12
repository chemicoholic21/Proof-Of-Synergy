import crypto from "crypto";
import { env, ipfsConfigured } from "./env";
import { logger } from "./logger";

/**
 * Upload metadata to Pinata (IPFS).
 *
 * When Pinata is configured the returned URI points at a real, resolvable IPFS object. When it is
 * NOT configured we only fall back to a deterministic, clearly-labelled `source: "mock"` URI in
 * DEMO_MODE — that URI is NOT resolvable and must never be written on-chain as if it were real
 * evidence. Outside demo mode a missing/failing Pinata config throws so the caller fails honestly.
 */
export async function uploadMetadata(
  metadata: unknown
): Promise<{ uri: string; source: "pinata" | "mock" }> {
  const jwt = env.PINATA_JWT;
  const body = JSON.stringify(metadata);
  if (jwt) {
    const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
      body: JSON.stringify({ pinataContent: metadata }),
    });
    if (res.ok) {
      const data = await res.json();
      return { uri: `ipfs://${data.IpfsHash}`, source: "pinata" };
    }
    const text = await res.text().catch(() => "");
    throw new Error(`Pinata pin failed ${res.status}: ${text}`);
  }

  if (!env.DEMO_MODE) {
    throw new Error("PINATA_JWT is not configured — cannot pin evidence to IPFS");
  }
  logger.warn("IPFS not configured — returning a non-resolvable mock CID (DEMO_MODE only)");
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 46);
  return { uri: `ipfs://Qm${hash}`, source: "mock" };
}

export { ipfsConfigured };

export function interviewHash(payload: unknown): string {
  return "0x" + crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
