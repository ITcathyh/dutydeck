import { parseProcStat } from '@dutydeck/shared';

/** Linux start time of a process (stat field 22), so a reused PID is not mistaken for the original. */
export function statStart(raw: string): string | undefined { return raw ? parseProcStat(raw).start : undefined; }
