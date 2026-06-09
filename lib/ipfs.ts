import crypto from "crypto";

// Upload metadata to Pinata if configured; otherwise return a deterministic mock ipfs:// URI.
// Either way the on-chain attestation/passport is real — only the evidence pointer degrades.
export async function uploadMetadata(metadata: unknown): Promise<{ uri: string; source: "pinata" | "mock" }> {
  const jwt = process.env.PINATA_JWT;
  const body = JSON.stringify(metadata);
  if (jwt) {
    try {
      const res = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ pinataContent: metadata }),
      });
      if (res.ok) {
        const data = await res.json();
        return { uri: `ipfs://${data.IpfsHash}`, source: "pinata" };
      }
    } catch {
      /* fall through to mock */
    }
  }
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 46);
  return { uri: `ipfs://Qm${hash}`, source: "mock" };
}

export function interviewHash(payload: unknown): string {
  return "0x" + crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
