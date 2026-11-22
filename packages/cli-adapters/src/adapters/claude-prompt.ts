// Claude 2.1.295 removes these codepoints from a paste and suppresses its first
// Enter. Keep its conditional emoji/script sequences: deleting every format
// character would corrupt otherwise ordinary user input.
const claudeLineBreak = (cp: number) => [10, 11, 12, 13, 133, 8232, 8233].includes(cp);
const claudeInvisible = (cp: number): boolean => {
  if (cp < 160) return cp < 32 && cp !== 9 && cp !== 10 || cp >= 127;
  if (cp < 8192) return [173, 847, 1564, 4447, 4448, 6068, 6069].includes(cp) || cp >= 6155 && cp <= 6159;
  if (cp < 65536) return cp >= 8203 && cp <= 8207 || cp >= 8232 && cp <= 8238 || cp >= 8288 && cp <= 8303
    || cp === 12644 || cp >= 65024 && cp <= 65039 || cp === 65279 || cp === 65440 || cp >= 65520 && cp <= 65531;
  return cp === 69759 || cp >= 78896 && cp <= 78911 || cp === 94180 || cp >= 113824 && cp <= 113827
    || cp >= 119155 && cp <= 119162 || cp >= 917504 && cp <= 921599;
};
const letter = /^\p{L}$/u, mark = /^\p{M}$/u, whitespace = /^\p{White_Space}$/u;
const emoji = /^[\p{Emoji}\p{Extended_Pictographic}]$/u, pictograph = /^\p{Extended_Pictographic}$/u, mathSymbol = /^\p{Sm}$/u;
const decimal = /^\p{Nd}$/u;
const script = (names: string, extensions = false) => new RegExp(`^[${names.split(' ').map(name => `\\p{${extensions ? 'Script_Extensions' : 'Script'}=${name}}`).join('')}]$`, 'u');
const rtlScript = script('Arabic Hebrew Syriac Thaana Nko Samaritan Mandaic Adlam Hanifi_Rohingya Yezidi');
const arabicMarkScript = script('Arabic Syriac Thaana Hanifi_Rohingya');
const scriptPair = (names: string) => ({ base: script(names), mark: script(names, true) });
const zwnjScripts = scriptPair('Arabic Syriac Nko Mongolian Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan');
const zwjScripts = scriptPair('Devanagari Bengali Gurmukhi Gujarati Oriya Tamil Telugu Kannada Malayalam Sinhala Myanmar Khmer Tibetan Arabic Syriac Tifinagh');
const zwjJoinScripts = scriptPair('Arabic Syriac Mongolian Nko');
const zeroWidthScripts = script('Khmer Thai Lao Myanmar');
const zeroWidthPair = { base: zeroWidthScripts, mark: zeroWidthScripts };
const mongolian = scriptPair('Mongolian'), khmer = scriptPair('Khmer'), egyptian = scriptPair('Egyptian_Hieroglyphs'), duployan = scriptPair('Duployan');
const brahmi = script('Brahmi'), variationScripts = script('Myanmar Phags_Pa Manichaean');
const matches = (regex: RegExp, cp: number | undefined) => cp !== undefined && regex.test(String.fromCodePoint(cp));
const scriptLetter = (regex: RegExp, cp: number | undefined) => matches(letter, cp) && matches(regex, cp);

/** Equivalent to Claude's paste sanitizer, without its diagnostic counters. */
export function claudeSafePrompt(text: string): string {
  const normalized = text.normalize('NFC');
  const chars = Array.from(normalized);
  const originalMarkerStarts = new Set<number>();
  const marker = /<<<(\/?)UNTRUSTED_DATA/gi;
  const markerUtf16Starts = new Set(Array.from(normalized.matchAll(marker), match => match.index));
  let normalizedUtf16 = 0;
  for (let index = 0; index < chars.length; index++) {
    if (markerUtf16Starts.has(normalizedUtf16)) originalMarkerStarts.add(index);
    normalizedUtf16 += chars[index]!.length;
  }
  const preservedMarkerOffsets = new Set<number>();
  const output: string[] = [];
  let outputLength = 0;
  const previous: number[] = [];
  let lastWasHidden = false;
  let lineStart = 0;
  const push = (cp: number, hidden = false) => {
    previous.push(cp); if (previous.length > 16) previous.shift();
    lastWasHidden = hidden;
  };
  const prior = (back = 0) => previous[previous.length - 1 - back];
  const nextVisible = (regex: RegExp, cp: number | undefined) => cp !== undefined && !claudeInvisible(cp) && matches(regex, cp);
  const nextScriptLetter = (pair: { base: RegExp }, cp: number | undefined) => cp !== undefined && !claudeInvisible(cp) && scriptLetter(pair.base, cp);
  const priorScriptLetter = (pair: { base: RegExp; mark: RegExp }, baseOnly: boolean) => {
    if (lastWasHidden) return false;
    for (let index = previous.length - 1; index >= 0; index--) {
      const cp = previous[index]!;
      if (matches(mark, cp)) { if (!matches(pair.mark, cp)) return false; continue; }
      return baseOnly ? matches(pair.base, cp) : scriptLetter(pair.base, cp);
    }
    return false;
  };
  const priorMatch = (regex: RegExp) => previous.length > 0 && !lastWasHidden && matches(regex, prior());
  let scriptCacheLine = -1;
  const scriptCache = new Map<RegExp, boolean>();
  const lineHasScript = (regex: RegExp) => {
    if (scriptCacheLine !== lineStart) { scriptCacheLine = lineStart; scriptCache.clear(); }
    const cached = scriptCache.get(regex);
    if (cached !== undefined) return cached;
    for (let index = lineStart; index < chars.length; index++) {
      const cp = chars[index]!.codePointAt(0)!;
      if (claudeLineBreak(cp)) break;
      if ((cp >= 1424 && cp <= 2303 || cp >= 64285 && cp <= 65023 || cp >= 65136 && cp <= 65279
        || cp >= 67584 && cp <= 69631 || cp >= 124928 && cp <= 126975) && scriptLetter(regex, cp)) {
        scriptCache.set(regex, true);
        return true;
      }
    }
    scriptCache.set(regex, false);
    return false;
  };
  const ambiguousBidi = (next: number | undefined) => {
    const nextLetter = matches(letter, next);
    if (!nextLetter && !matches(decimal, next)) return false;
    for (let index = previous.length - 1; index >= 0; index--) {
      const cp = previous[index]!;
      if (claudeInvisible(cp)) return true;
      if (matches(mark, cp)) continue;
      return nextLetter ? matches(letter, cp) && (cp === 1600 || matches(rtlScript, cp)) === (next === 1600 || matches(rtlScript, next)) : matches(decimal, cp);
    }
    return previous.length >= 16;
  };
  const conditionalKeep = (index: number, cp: number): boolean => {
    const next = chars[index + 1]?.codePointAt(0);
    const prev = prior();
    switch (cp) {
      case 8204: case 8205: {
        if (priorScriptLetter(cp === 8204 ? zwnjScripts : zwjScripts, false)) return true;
        if (cp === 8205) {
          let base = prev;
          if (base === 65039 || base !== undefined && base >= 127995 && base <= 127999) {
            base = prior(1);
            if (base === 65039 || base !== undefined && base >= 127995 && base <= 127999) base = prior(2);
          }
          if (prev !== undefined && prev !== 8205 && matches(pictograph, base) && nextVisible(pictograph, next)) return true;
        }
        if (prev === undefined || lastWasHidden) return false;
        return cp === 8204
          ? nextScriptLetter(zwnjScripts, next) && !matches(whitespace, prev) && !matches(mark, prev)
          : nextScriptLetter(zwjJoinScripts, next) && !matches(letter, prev) && !matches(decimal, prev) && !matches(mark, prev);
      }
      case 8203: {
        const following = nextVisible(zeroWidthScripts, next) && !matches(mark, next);
        return priorScriptLetter(zeroWidthPair, true) && (following || nextVisible(/^[0-9]$/, next))
          || following && priorMatch(/^[0-9]$/);
      }
      case 65038: case 65039:
        return prev !== undefined && !lastWasHidden && (prev >= 169 && matches(emoji, prev)
          || (prev >= 48 && prev <= 57 || prev === 35 || prev === 42) && next === 8419);
      case 65024: case 65025: case 65026:
        return prev !== undefined && !lastWasHidden && (matches(egyptian.base, prev)
          || cp === 65024 && (prev >= 8704 && prev <= 11007 && matches(mathSymbol, prev) || matches(variationScripts, prev)));
      case 8206: case 8207: case 1564: {
        const relevant = lineHasScript(cp === 1564 ? arabicMarkScript : rtlScript);
        return relevant && !lastWasHidden && (next === undefined || claudeLineBreak(next) || !claudeInvisible(next) && !matches(mark, next)) && !ambiguousBidi(next);
      }
      case 847: return priorMatch(mark) || !lastWasHidden && nextVisible(mark, next);
      case 6068: case 6069: return priorScriptLetter(khmer, false);
      case 6155: case 6156: case 6157: case 6158: case 6159:
        return priorScriptLetter(mongolian, false) || !lastWasHidden && nextScriptLetter(mongolian, next);
      case 69759: return priorMatch(brahmi) && nextVisible(brahmi, next);
      default:
        if (cp >= 78896 && cp <= 78911) return priorScriptLetter(egyptian, false) || !lastWasHidden && nextScriptLetter(egyptian, next);
        if (cp >= 113824 && cp <= 113827) return priorScriptLetter(duployan, false) || !lastWasHidden && nextScriptLetter(duployan, next);
        return false;
    }
  };

  for (let index = 0; index < chars.length; index++) {
    if (originalMarkerStarts.has(index)) preservedMarkerOffsets.add(outputLength);
    const char = chars[index]!;
    const cp = char.codePointAt(0)!;
    if (cp === 127988) {
      const tags = chars.slice(index + 1, index + 6).map(tag => tag.codePointAt(0)!);
      const abbreviation = tags.every(tag => tag >= 917601 && tag <= 917626)
        ? tags.map(tag => String.fromCharCode(tag - 917504)).join('') : '';
      if (['gbeng', 'gbsct', 'gbwls'].includes(abbreviation) && chars[index + 6]?.codePointAt(0) === 917631) {
        for (const kept of chars.slice(index, index + 7)) { output.push(kept); outputLength += kept.length; push(kept.codePointAt(0)!, kept !== char); }
        index += 6;
        continue;
      }
    }
    if (claudeLineBreak(cp)) {
      if (cp === 13 && chars[index + 1]?.codePointAt(0) === 10) index++;
      output.push('\n'); outputLength++; push(10); lineStart = index + 1;
      continue;
    }
    if (!claudeInvisible(cp)) { output.push(char); outputLength += char.length; push(cp); continue; }
    if (conditionalKeep(index, cp)) { output.push(char); outputLength += char.length; push(cp, true); }
  }
  let result = output.join('');
  const reconstructed: number[] = [];
  for (const match of result.matchAll(/<<<(\/?)UNTRUSTED_DATA/gi)) {
    if (!preservedMarkerOffsets.has(match.index)) reconstructed.push(match.index);
  }
  for (let index = reconstructed.length - 1; index >= 0; index--) {
    const offset = reconstructed[index]! + 2;
    result = `${result.slice(0, offset)} ${result.slice(offset)}`;
  }
  return result;
}
