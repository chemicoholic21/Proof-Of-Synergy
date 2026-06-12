import {
  createPublicClient,
  createWalletClient,
  http,
  defineChain,
  keccak256,
  toHex,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { env, chainConfigured } from "./env";

// Public Monad testnet RPC. NEVER hardcode a tokenized/private RPC URL here, configure it via
// the MONAD_RPC_URL environment variable. The default below is a public, unauthenticated endpoint.
const DEFAULT_RPC_URL = "https://testnet-rpc.monad.xyz";
const RPC_URL = env.MONAD_RPC_URL || DEFAULT_RPC_URL;

export { chainConfigured };

export const monadTestnet = defineChain({
  id: env.NEXT_PUBLIC_CHAIN_ID,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [RPC_URL] },
  },
  blockExplorers: {
    default: { name: "Explorer", url: env.NEXT_PUBLIC_EXPLORER_URL },
  },
  testnet: true,
});

export const REGISTRY_ADDRESS = (env.NEXT_PUBLIC_REGISTRY_ADDRESS || "") as Address;
export const PASSPORT_ADDRESS = (env.NEXT_PUBLIC_PASSPORT_ADDRESS || "") as Address;
export const GATE_ADDRESS = (env.NEXT_PUBLIC_GATE_ADDRESS || "") as Address;
export const EXPLORER_URL = env.NEXT_PUBLIC_EXPLORER_URL;

export const registryAbi = [
  {
    type: "function",
    name: "attestBatch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "subject", type: "address" },
      { name: "skills", type: "bytes32[]" },
      { name: "confidences", type: "uint8[]" },
      { name: "evidenceURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getConfidence",
    stateMutability: "view",
    inputs: [
      { name: "subject", type: "address" },
      { name: "skill", type: "bytes32" },
      { name: "attester", type: "address" },
    ],
    outputs: [
      { name: "confidence", type: "uint8" },
      { name: "exists", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "getAttestations",
    stateMutability: "view",
    inputs: [{ name: "subject", type: "address" }],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        components: [
          { name: "skill", type: "bytes32" },
          { name: "confidence", type: "uint8" },
          { name: "attester", type: "address" },
          { name: "timestamp", type: "uint64" },
          { name: "evidenceURI", type: "string" },
        ],
      },
    ],
  },
] as const;

export const passportAbi = [
  {
    type: "function",
    name: "mint",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "uri", type: "string" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
  {
    type: "function",
    name: "passportOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const gateAbi = [
  {
    type: "function",
    name: "meetsRequirement",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "skill", type: "bytes32" },
      { name: "minConfidence", type: "uint8" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export function skillKey(name: string): `0x${string}` {
  return keccak256(toHex(name.trim().toLowerCase()));
}

export function publicClient() {
  return createPublicClient({ chain: monadTestnet, transport: http() });
}

export function serverWallet() {
  const pk = env.DEPLOYER_PRIVATE_KEY;
  if (!pk) throw new Error("DEPLOYER_PRIVATE_KEY is not configured");
  const account = privateKeyToAccount(pk as `0x${string}`);
  return {
    account,
    client: createWalletClient({ account, chain: monadTestnet, transport: http() }),
  };
}

export function txUrl(hash: string) {
  return `${EXPLORER_URL}/tx/${hash}`;
}
export function addressUrl(addr: string) {
  return `${EXPLORER_URL}/address/${addr}`;
}
