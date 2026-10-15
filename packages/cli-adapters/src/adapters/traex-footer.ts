/** Full rendered viewport evidence. Raw PTY deltas do not preserve rows or
 * columns, and may contain an assistant/draft quoting the same footer. */
const GLYPHS = '⋄◇◆✦◈❖✧⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const ACTIVITY = new RegExp(`^[${GLYPHS}][ \\t]+[A-Z][^()\\r\\n]{0,240}\\(\\d+[hms](?:[ \\t]+\\d+[hms])*[ \\t]+[•·][^()]{0,160}\\besc to interr?upt\\b[^()]{0,160}\\)[ \\t]*$`);
const LEGACY_SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏][ \t]?(?:[A-Z][^()\r\n]{0,240}…|Queued for capacity|Queued for next turn)$/i;
const STANDALONE = /^(?:Queued for (?:capacity|next turn)|esc to interrupt|Too many requests right now(?:\. You're in the queue.*)?|Working[^\r\n]{0,160}esc to interrupt\)?)[ \t]*$/i;
const PROMPT = /^[›❯](?:[ \t]|$)/;

export function isTraexBusyScreen(screen: string): boolean {
  const rows = screen.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').split(/\r?\n/);
  // Only the first column-0 composer is authoritative. Quoted continuations
  // are indented, and a long draft must not replace the real composer.
  const composer = rows.findIndex(row => PROMPT.test(row));
  if (composer < 0) return false;
  let status = composer - 2;
  if (/^[ \t]+(?:└[ \t]*)?Too many requests right now/.test(rows[status] ?? '')) status--;
  const row = rows[status] ?? '';
  // Bound the entire candidate before testing the elapsed-time grammar.
  if (row.length <= 600 && ACTIVITY.test(row)) return true;
  for (const index of [composer - 2, composer - 1]) {
    const candidate = rows[index] ?? '';
    if (candidate.length <= 600 && (LEGACY_SPINNER.test(candidate) || STANDALONE.test(candidate))) return true;
  }
  // Older versions put the standalone interrupt hint below the input surface.
  return rows.slice(composer + 1).some(row => /^esc to interrupt[ \t]*$/i.test(row));
}
