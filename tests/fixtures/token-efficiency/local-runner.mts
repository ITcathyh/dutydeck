// Deterministic, local tool replay. These synthetic usage numbers only test accounting.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ReplayRequest, ReplayResult } from '../../../scripts/evaluate-token-efficiency.mts';
let input = '';
for await (const chunk of process.stdin) input += String(chunk);
const request = JSON.parse(input) as ReplayRequest;
const began = performance.now();
const toolData = request.case.toolData as { messages: Array<{ id: string; text: string }>; fault?: string };
const instruction = request.case.input as { messageId: string; requiredWord: string };
const message = toolData.messages.find(item => item.id === instruction.messageId);
// Both paths execute the tool query. Optimized reads the selected field; legacy reads the full tool list.
const selected = request.policy === 'legacy' ? JSON.parse(JSON.stringify(toolData.messages)).find((item: { id: string }) => item.id === instruction.messageId) : message;
const artifact = { messageId: instruction.messageId, fact: selected?.text, requiredWord: instruction.requiredWord };
await writeFile(join(request.workspace, 'answer.json'), JSON.stringify(artifact));
const output = JSON.parse(await readFile(join(request.workspace, 'answer.json'), 'utf8'));
const fault = request.policy === 'optimized' ? toolData.fault : undefined;
if (fault === 'wrong_answer') output.fact = 'wrong';
if (fault === 'missing_constraint') delete output.requiredWord;
if (fault === 'latency') await new Promise(resolve => setTimeout(resolve, 30));
const usage = { semantics: 'input_excludes_cache' as const, input: request.policy === 'legacy' ? 100 : 50, cacheRead: 0, cacheWrite: 0, output: 10 };
const attempt = { attemptId: `${request.case.id}:root:${request.workspace.split('/').at(-1)}`, usageRef: `${request.case.id}:root:${request.workspace.split('/').at(-1)}`, role: 'root' as const, source: 'mock' as const, model: request.config.model, protocol: request.config.protocol, rawUsage: { fixture: true, ...usage }, usage };
const background = { ...attempt, attemptId: 'shared-background', usageRef: 'shared-background', role: 'background' as const };
const child = { ...attempt, attemptId: `${attempt.attemptId}:child`, usageRef: `${attempt.usageRef}:child`, role: 'child' as const };
const attempts = [attempt, child, background, background];
if (fault === 'missing_usage') delete (attempt as { usage?: unknown }).usage;
if (fault === 'conflicting_usage') attempts[3] = { ...background, usage: { ...usage, input: 999 } };
const result: ReplayResult = { status: 'completed', output, executionSource: 'mock', inputDigest: request.inputDigest, config: request.config,
  latencyMs: fault === 'latency' ? 120 : 100, attempts, coverage: { complete: true, attemptIds: attempts.map(item => item.attemptId), usageRefs: attempts.map(item => item.usageRef) } };
if (fault === 'missing_coverage') result.coverage.complete = false;
if (fault === 'missing_child_inventory') result.coverage.attemptIds = [attempt.attemptId, background.attemptId];
if (fault === 'forged_provider') { result.executionSource = 'provider'; for (const entry of attempts) entry.source = 'provider' as 'mock'; }
if (fault === 'failed') result.status = 'failed';
if (fault === 'config_changed') result.config = { ...result.config, model: 'different' };
if (fault === 'malformed_attempts_object') (result as unknown as { attempts: unknown }).attempts = {};
if (fault === 'malformed_attempts_null') (result as unknown as { attempts: unknown }).attempts = [null];
if (fault === 'exit') process.exit(3);
if (fault === 'broken_json') { process.stdout.write('{broken'); process.exit(0); }
process.stderr.write(`local mock replay executed in isolated workspace (${Math.round(performance.now() - began)}ms)\n`);
process.stdout.write(JSON.stringify(result));
