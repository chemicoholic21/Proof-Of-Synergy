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

export const monadTestnet = defineChain({
  id: Number(process.env.NEXT_PUBLIC_CHAIN_ID || 143),
  name: "Monad (contract.dev sandbox)",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: {
      http: [process.env.MONAD_RPC_URL || "https://rpc.contract.dev/616bd30af2461a6935c5998c029bfe36"],
    },
  },
  blockExplorers: {
    default: {
      name: "Explorer",
      url: process.env.NEXT_PUBLIC_EXPLORER_URL || "https://testnet.monadexplorer.com",
    },
  },
  testnet: true,
});

export const REGISTRY_ADDRESS = (process.env.NEXT_PUBLIC_REGISTRY_ADDRESS || "") as Address;
export const PASSPORT_ADDRESS = (process.env.NEXT_PUBLIC_PASSPORT_ADDRESS || "") as Address;
export const GATE_ADDRESS = (process.env.NEXT_PUBLIC_GATE_ADDRESS || "") as Address;
export const EXPLORER_URL =
  process.env.NEXT_PUBLIC_EXPLORER_URL || "https://testnet.monadexplorer.com";

export function chainConfigured(): boolean {
  return Boolean(process.env.DEPLOYER_PRIVATE_KEY && REGISTRY_ADDRESS && PASSPORT_ADDRESS);
}

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
  const pk = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
  const account = privateKeyToAccount(pk);
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
