import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import * as pty from 'node-pty';
import type { AgentConfig, AgentCapabilities } from '@dockmux/shared';
import { normalizeAcpxEvent, type NormalizedDriverEvent } from '@dockmux/acp-client';

export interface ProbeMatrix { acp: boolean; jsonl: boolean; pipe: boolean; pty: boolean }
export function commandExists(command: string) {
  if (command.includes('/') || command.includes('\\')) return spawnSync('test', ['-x', command]).status === 0;
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' }).status === 0;
}

export function probeAgent(agent: AgentConfig, acpxCommand = 'acpx'): AgentCapabilities {
  const executable = commandExists(agent.command);
  // The default runtime is the pinned `acpx` package imported by acp-client.
  // A non-default command is treated as an operator-supplied dependency probe.
  const acpx = acpxCommand === 'acpx' || commandExists(acpxCommand);
  const requested = agent.protocol === 'auto' ? (acpx && executable ? 'acp' : executable ? 'jsonl' : 'pty') : agent.protocol;
  const available = requested === 'acp' ? acpx && executable : executable;
  return { protocol: requested, available, detail: available ? undefined : requested === 'acp' && !acpx ? `acpx is unavailable; install acpx@0.13.0` : `Command not found: ${agent.command}`, pause: agent.capabilities.pause, resume: agent.capabilities.resume };
}

export interface ProcessTransportOptions { onEvent(event: NormalizedDriverEvent): void; onExit?(code: number | null): void }

export class JsonlTransport {
  private child?: ChildProcessWithoutNullStreams;
  constructor(private readonly agent: AgentConfig, private readonly options: ProcessTransportOptions) {}
  async start() {
    if (this.child) return;
    this.child = spawn(this.agent.command, this.agent.args, { cwd: this.agent.cwd, env: { ...process.env, ...this.agent.env }, detached: process.platform !== 'win32' });
    readline.createInterface({ input: this.child.stdout }).on('line', line => { const event = normalizeAcpxEvent(line); if (event) this.options.onEvent(event); });
    readline.createInterface({ input: this.child.stderr }).on('line', line => this.options.onEvent({ type: 'raw_terminal', data: { text: line }, raw: line }));
    this.child.once('exit', code => { this.child = undefined; this.options.onExit?.(code); });
  }
  async send(prompt: string) { await this.start(); this.child!.stdin.write(`${JSON.stringify({ type: 'prompt', prompt })}\n`); }
  async interrupt() { this.child?.kill('SIGINT'); }
  async resume() { await this.start(); }
  async stop() { if (this.child?.pid) { try { process.kill(process.platform === 'win32' ? this.child.pid : -this.child.pid, 'SIGTERM'); } catch { this.child.kill(); } } this.child = undefined; }
}

/** Newline-delimited stdin/stdout compatibility transport without ACP ownership. */
export class PipeTransport extends JsonlTransport {}

export class PtyTransport {
  private child?: pty.IPty;
  constructor(private readonly agent: AgentConfig, private readonly options: ProcessTransportOptions) {}
  async start() {
    if (this.child) return;
    const env = Object.fromEntries(Object.entries({ ...process.env, ...this.agent.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    this.child = pty.spawn(this.agent.command, this.agent.args, { name: 'xterm-256color', cwd: this.agent.cwd ?? process.cwd(), env });
    this.child.onData(raw => this.options.onEvent({ type: 'raw_terminal', data: { text: raw }, raw }));
    this.child.onExit(({ exitCode }) => { this.child = undefined; this.options.onExit?.(exitCode); });
  }
  async send(prompt: string) { await this.start(); this.child!.write(`${prompt}\r`); }
  async interrupt() { this.child?.write('\x03'); }
  async resume() { await this.start(); }
  async stop() { this.child?.kill(); this.child = undefined; }
}
