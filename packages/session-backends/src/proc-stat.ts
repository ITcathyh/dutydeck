/** Fields after the `(comm)` of /proc/<pid>/stat: [0] state, [19] start time. The command name may contain spaces and parentheses. */
export function statFields(raw: string): string[] { return raw.slice(raw.lastIndexOf(')') + 2).split(' '); }
/** Linux start time of a process (stat field 22), so a reused PID is not mistaken for the original. */
export function statStart(raw: string): string | undefined { return raw ? statFields(raw)[19] : undefined; }
