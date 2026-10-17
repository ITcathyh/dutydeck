// Adapted from botmux (https://github.com/deepcoldy/botmux), MIT License, Copyright (c) 2026 botmux contributors
import { Buffer } from 'node:buffer';
export interface ProgramStatusEvent {
  state: 'idle' | 'working' | 'done' | 'blocked' | 'error' | 'clear';
  id?: string;
  app?: string;
  kind?: string;
  msg?: string;
  progress?: number;
}

export type ProgramStatusState = ProgramStatusEvent['state'];

export type ProgramStatusPart =
  | { type: 'data'; text: string }
  | { type: 'probe' }
  | { type: 'status'; event: ProgramStatusEvent };

const VALID_STATES = new Set<ProgramStatusState>([
  'idle',
  'working',
  'done',
  'blocked',
  'error',
  'clear',
]);

const PREFIX_TARGET = '7501;';
const DEFAULT_MAX_BUFFER_SIZE = 4096;

/** Safe base64 decoding for msg; returns undefined on malformed base64 or control chars */
export function decodeProgramStatusMsg(val: string): string | undefined {
  if (!val) return undefined;
  // RFC 4648 base64 or URL-safe base64: [A-Za-z0-9+/=_-]
  if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(val) || val.replace(/=+$/, '').length % 4 === 1) return undefined;
  try {
    const text = Buffer.from(val, 'base64').toString('utf8');
    if (text.includes('\ufffd')) return undefined;
    // Reject control characters (U+0000–U+001F, U+007F, U+0080–U+009F)
    if (/[\x00-\x1f\x7f-\x9f]/.test(text)) return undefined;
    return text;
  } catch {
    return undefined;
  }
}

/** Parse colon-separated key=value pairs into a ProgramStatusEvent */
export function parseProgramStatusPayload(payload: string): ProgramStatusEvent | null {
  const pairs = payload.split(':');
  let state: ProgramStatusState | undefined;
  let id: string | undefined;
  let app: string | undefined;
  let kind: string | undefined;
  let msg: string | undefined;
  let progress: number | undefined;

  for (const pair of pairs) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();

    switch (key) {
      case 'state':
        if (VALID_STATES.has(val as ProgramStatusState)) {
          state = val as ProgramStatusState;
        }
        break;
      case 'id':
        if (val) id = val;
        break;
      case 'app':
        if (val) app = val;
        break;
      case 'kind':
        if (val) kind = val;
        break;
      case 'msg': {
        const decoded = decodeProgramStatusMsg(val);
        if (decoded !== undefined) msg = decoded;
        break;
      }
      case 'progress': {
        const n = parseInt(val, 10);
        if (/^\d+$/.test(val) && Number.isFinite(n) && n >= 0 && n <= 100) {
          progress = n;
        }
        break;
      }
    }
  }

  if (!state) return null;
  const event: ProgramStatusEvent = { state };
  if (id !== undefined) event.id = id;
  if (app !== undefined) event.app = app;
  if (kind !== undefined) event.kind = kind;
  if (msg !== undefined) event.msg = msg;
  if (progress !== undefined) event.progress = progress;
  return event;
}

export class ProgramStatusFramingStream {
  private buffered = '';
  private readonly maxBufferSize: number;

  constructor(options?: { maxBufferSize?: number }) {
    this.maxBufferSize = options?.maxBufferSize ?? DEFAULT_MAX_BUFFER_SIZE;
  }

  feed(chunk: string): ProgramStatusPart[] {
    const parts: ProgramStatusPart[] = [];
    const str = this.buffered + chunk;
    this.buffered = '';
    let cursor = 0;

    const emitData = (text: string) => {
      if (!text) return;
      const last = parts[parts.length - 1];
      if (last && last.type === 'data') {
        last.text += text;
      } else {
        parts.push({ type: 'data', text });
      }
    };

    while (cursor < str.length) {
      const escIdx = str.indexOf('\x1b', cursor);
      if (escIdx === -1) {
        emitData(str.slice(cursor));
        cursor = str.length;
        break;
      }

      if (escIdx > cursor) {
        emitData(str.slice(cursor, escIdx));
        cursor = escIdx;
      }

      // str[cursor] === '\x1b'
      if (cursor + 1 >= str.length) {
        // Chunk ends right at ESC byte
        this.buffered = '\x1b';
        cursor = str.length;
        break;
      }

      if (str[cursor + 1] !== ']') {
        // Non-OSC escape sequence (e.g. CSI \x1b[)
        emitData(str.slice(cursor, cursor + 2));
        cursor += 2;
        continue;
      }

      // str[cursor...cursor+2] === '\x1b]'
      const remaining = str.length - cursor - 2;
      if (remaining < PREFIX_TARGET.length && PREFIX_TARGET.startsWith(str.slice(cursor + 2))) {
        this.buffered = str.slice(cursor);
        break;
      }

      if (str.startsWith(PREFIX_TARGET, cursor + 2)) {
        const contentStart = cursor + 2 + PREFIX_TARGET.length;
        // Stop at the FIRST control byte, including malformed nested ESCs.
        // Searching separately for BEL and ST rescans the remaining chunk for
        // each nested prefix, making an otherwise bounded frame quadratic.
        const boundary = /[\x07\x1b]/g;
        boundary.lastIndex = contentStart;
        const match = boundary.exec(str);
        if (!match) {
          if (Buffer.byteLength(str.slice(cursor)) <= this.maxBufferSize) this.buffered = str.slice(cursor);
          break;
        }
        const termIdx = match.index;
        const isEsc = str[termIdx] === '\x1b';
        if (isEsc && termIdx === str.length - 1) {
          // The trailing ESC may start a new frame in the next chunk even
          // when the malformed frame before it exceeded the size bound.
          this.buffered = Buffer.byteLength(str.slice(cursor)) <= this.maxBufferSize ? str.slice(cursor) : '\x1b';
          break;
        }
        if (isEsc && str[termIdx + 1] !== '\\') {
          const malformed = str.slice(cursor, termIdx);
          if (Buffer.byteLength(malformed) <= this.maxBufferSize) emitData(malformed);
          cursor = termIdx;
          continue;
        }
        const termLen = isEsc ? 2 : 1;
        if (Buffer.byteLength(str.slice(cursor, termIdx + termLen)) > this.maxBufferSize) {
          cursor = termIdx + termLen;
          continue;
        }
        const payload = str.slice(contentStart, termIdx);
        if (payload.trim() === '?') {
          parts.push({ type: 'probe' });
        } else {
          const event = parseProgramStatusPayload(payload);
          if (event) {
            parts.push({ type: 'status', event });
          }
        }

        cursor = termIdx + termLen;
        continue;
      }

      // Another OSC code (e.g. \x1b]0;, \x1b]8;, \x1b]52;, \x1b]777;, \x1b]1989;)
      emitData(str.slice(cursor, cursor + 2));
      cursor += 2;
    }

    return parts;
  }

  flush(): ProgramStatusPart[] {
    if (this.buffered.length > 0) {
      const text = this.buffered;
      this.buffered = '';
      return [{ type: 'data', text }];
    }
    return [];
  }

  reset(): void {
    this.buffered = '';
  }
}
