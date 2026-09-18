import { createHash, createHmac } from 'node:crypto';

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacSha256(key: Uint8Array, value: string | Uint8Array): string {
  return createHmac('sha256', key).update(value).digest('hex');
}

export function opaqueRef(kind: string, key: Uint8Array, value: string): string {
  return `${kind}_${hmacSha256(key, value).slice(0, 24)}`;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const item = (value as Record<string, unknown>)[key];
    if (item !== undefined) output[key] = canonicalize(item);
  }
  return output;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function stableFingerprint(value: unknown): string {
  return sha256(stableJson(value));
}
