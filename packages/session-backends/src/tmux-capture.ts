import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { StringDecoder } from 'node:string_decoder';

export const TMUX_CAPTURE_BUFFER_BYTES = 256 * 1024;
const MAX_FRAME_BYTES = 128 * 1024;
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const start = (pid: number) => readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ').at(-1)!.split(' ')[19];

/** The pipe child always drains tmux input. A slow reader drops bytes within a
 * fixed write budget, then reports a gap before any later bytes. No output log. */
export const tmuxCaptureWriter = String.raw`
const {createConnection}=require('node:net');
const socket=createConnection(process.argv[1]);
const budget=Number(process.argv[2]);
let dropped=0,ended=false;
const deadline=setTimeout(()=>process.exit(0),5000);
process.stdin.pause();
const gap=()=>{if(!ended && dropped && socket.writableLength===0){socket.write(JSON.stringify({gap:dropped})+'\n');dropped=0;}};
socket.on('connect',()=>{clearTimeout(deadline);process.stdin.resume();});
socket.on('drain',gap);
process.stdin.on('data',chunk=>{
  gap();
  for(let at=0;at<chunk.length;at+=32768){
    const part=chunk.subarray(at,at+32768);
    const frame=JSON.stringify({data:part.toString('base64')})+'\n';
    if(dropped || socket.writableLength+Buffer.byteLength(frame)>budget)dropped+=part.length;
    else socket.write(frame);
  }
});
process.stdin.on('end',()=>{ended=true;socket.end(dropped ? JSON.stringify({gap:dropped})+'\n' : undefined);});
socket.on('error',()=>process.exit(0));
socket.on('close',()=>process.exit(0));
`;

export class TmuxCapture {
  readonly directory: string;
  readonly path: string;
  private readonly sockets = new Set<Socket>();
  private server?: Server;
  private closed = false;
  constructor(owner: string, private readonly data: (text: string) => void, private readonly gap: (bytes: number) => void) {
    this.directory = mkdtempSync(join(tmpdir(), 'dutydeck-tmux-capture-'));
    chmodSync(this.directory, 0o700);
    this.path = join(this.directory, 'out.sock');
    writeFileSync(join(this.directory, 'owner.json'), JSON.stringify({ owner, pid: process.pid, start: process.platform === 'linux' ? start(process.pid) : undefined, host: hostname() }), { mode: 0o600 });
  }
  listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer(socket => {
        if (this.closed || this.sockets.size) { socket.destroy(); return; }
        this.sockets.add(socket);
        let pending = '';
        let decoder = new StringDecoder('utf8');
        socket.on('error', () => { /* Closing the capture is separate from Agent exit. */ });
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('data', chunk => {
          pending += chunk.toString('ascii');
          for (;;) {
            const newline = pending.indexOf('\n');
            if (newline < 0) break;
            if (newline > MAX_FRAME_BYTES) { socket.destroy(); this.gap(1); return; }
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            try {
              const frame = JSON.parse(line);
              if (Number.isSafeInteger(frame.gap) && frame.gap > 0) { decoder = new StringDecoder('utf8'); this.gap(frame.gap); }
              else if (typeof frame.data === 'string') { const text = decoder.write(Buffer.from(frame.data, 'base64')); if (text) this.data(text); }
              else throw new Error('Invalid capture frame');
            } catch { socket.destroy(); this.gap(1); return; }
          }
          if (pending.length > MAX_FRAME_BYTES) { socket.destroy(); this.gap(1); }
        });
      });
      this.server.once('error', reject);
      this.server.listen(this.path, () => { chmodSync(this.path, 0o600); resolve(); });
    });
  }
  command(): string { return `${quote(process.execPath)} -e ${quote(tmuxCaptureWriter)} ${quote(this.path)} ${TMUX_CAPTURE_BUFFER_BYTES}`; }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    this.server?.close();
    rmSync(this.directory, { recursive: true, force: true });
  }
}

/** Only the exact old capture referenced by this owned tmux session is eligible.
 * A PID/start identity still alive, an unknown host, or unsafe path is retained. */
export function cleanAbandonedTmuxCapture(directory: string, owner: string): void {
  try {
    if (dirname(directory) !== tmpdir() || !/^dutydeck-tmux-capture-[A-Za-z0-9]+$/.test(basename(directory))) return;
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) return;
    const record = JSON.parse(readFileSync(join(directory, 'owner.json'), 'utf8'));
    if (record.owner !== owner || record.host !== hostname() || !Number.isSafeInteger(record.pid) || !record.start || process.platform !== 'linux') return;
    try { if (start(record.pid) === record.start) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return; }
    rmSync(directory, { recursive: true, force: true });
  } catch { /* An unproven stale capture is never deleted. */ }
}
