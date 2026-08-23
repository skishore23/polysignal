import { ClobClient, type ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "ethers";

export type ClobAuthConfig = {
  host: string;
  chainId: number;
  privateKey?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
  apiPassphrase?: string | null;
  signatureType?: number;
  funder?: string | null;
};

export type ClobAuthBundle = {
  client: ClobClient;
  apiCreds: ApiKeyCreds;
  signer: Wallet;
};

const isNonEmpty = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

export function hasApiCreds(config: ClobAuthConfig): boolean {
  return isNonEmpty(config.apiKey) && isNonEmpty(config.apiSecret) && isNonEmpty(config.apiPassphrase);
}

export function buildApiCreds(config: ClobAuthConfig): ApiKeyCreds | null {
  if (!hasApiCreds(config)) return null;
  return {
    key: String(config.apiKey),
    secret: String(config.apiSecret),
    passphrase: String(config.apiPassphrase)
  };
}

export async function resolveApiCreds(config: ClobAuthConfig): Promise<ApiKeyCreds | null> {
  const existing = buildApiCreds(config);
  if (existing) return existing;
  if (!isNonEmpty(config.privateKey)) return null;
  const signer = new Wallet(String(config.privateKey));
  const signatureType = config.signatureType ?? 0;
  const funder = isNonEmpty(config.funder) ? String(config.funder) : undefined;
  const client = new ClobClient(config.host, config.chainId, signer, undefined, signatureType, funder);
  return await client.createOrDeriveApiKey();
}

export async function createClobClient(config: ClobAuthConfig): Promise<ClobAuthBundle | null> {
  if (!isNonEmpty(config.privateKey)) return null;
  const signer = new Wallet(String(config.privateKey));
  const apiCreds = await resolveApiCreds(config);
  if (!apiCreds) return null;
  const signatureType = config.signatureType ?? 0;
  const funder = isNonEmpty(config.funder) ? String(config.funder) : undefined;
  const client = new ClobClient(
    config.host,
    config.chainId,
    signer,
    apiCreds,
    signatureType,
    funder
  );
  return { client, apiCreds, signer };
}
