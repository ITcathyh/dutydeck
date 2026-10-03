import { z } from 'zod';
import type { ConfigRepository, Protocol } from '@dutydeck/shared';

export type TokenEfficiencyMode = 'legacy' | 'optimized';
export interface TokenEfficiencyPolicy {
  mode: TokenEfficiencyMode;
  memoryProfiles: Array<{ agentId: string; protocol: Exclude<Protocol, 'auto'>; model?: string; reasoningEffort?: string; maxInputChars: number; verificationRef: string }>;
  /** Content-free reason why the configured policy could not be used. */
  diagnosticReason?: 'invalid_configuration' | 'configuration_unavailable';
}
const policySchema = z.object({
  mode: z.enum(['legacy', 'optimized']),
  memoryProfiles: z.array(z.object({
    agentId: z.string().trim().min(1), protocol: z.enum(['acp', 'jsonl', 'pipe', 'pty', 'pty-cli']), model: z.string().trim().min(1).optional(), reasoningEffort: z.string().trim().min(1).optional(),
    maxInputChars: z.number().int().positive().safe(), verificationRef: z.string().trim().min(1)
  }).strict())
}).strict().superRefine((policy, context) => {
  const keys = policy.memoryProfiles.map(profile => JSON.stringify([profile.agentId, profile.protocol, profile.model ?? null, profile.reasoningEffort ?? null]));
  if (new Set(keys).size !== keys.length) context.addIssue({ code: z.ZodIssueCode.custom, message: 'Duplicate memory profile' });
});
export async function readTokenEfficiencyPolicy(config: ConfigRepository): Promise<TokenEfficiencyPolicy> {
  let raw: string | undefined;
  try { raw = await config.get('token_efficiency'); }
  catch { return { mode: 'legacy', memoryProfiles: [], diagnosticReason: 'configuration_unavailable' }; }
  if (raw === undefined) return { mode: 'legacy', memoryProfiles: [] };
  try { return policySchema.parse(JSON.parse(raw)); }
  catch { return { mode: 'legacy', memoryProfiles: [], diagnosticReason: 'invalid_configuration' }; }
}
