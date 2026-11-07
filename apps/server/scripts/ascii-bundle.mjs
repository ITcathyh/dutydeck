import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

/**
 * Rewrites a built bundle to pure ASCII without changing what it does. V8 keeps a script's source in memory
 * for lazy compilation, and a single non-ASCII character makes it store all of it at two bytes per character.
 * esbuild already escapes strings, untagged templates and identifiers; what is left is comments, regular
 * expression literals and the occasional exotic case. Comments keep their layout with each non-ASCII code
 * unit replaced by '?', and regular expressions get \u escapes with the same meaning (only their .source text
 * changes). Anything else that is not ASCII (for example a tagged template, whose raw text the tag can read)
 * fails the build.
 */
export function asciiBundle(file) {
  const text = readFileSync(file, 'utf8');
  const output = asciiSource(text, file);
  if (output !== text) writeFileSync(file, output);
}

export function asciiSource(text, file = 'bundle.js') {
  if (!/[^\x00-\x7f]/.test(text)) return text;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);
  if (source.parseDiagnostics?.length) throw new Error(`${file}: cannot parse bundle for ASCII rewrite: ${source.parseDiagnostics[0].messageText}`);
  // Literal tokens, by start: [end, kind]. Tagged template parts are recorded as 'tagged'.
  const literals = new Map();
  const record = (node, kind) => literals.set(node.getStart(source), [node.end, kind]);
  const templateParts = (template, kind) => {
    if (ts.isNoSubstitutionTemplateLiteral(template)) record(template, kind);
    else { record(template.head, kind); for (const span of template.templateSpans) record(span.literal, kind); }
  };
  const stack = [source];
  while (stack.length) {
    const node = stack.pop();
    switch (node.kind) {
      case ts.SyntaxKind.RegularExpressionLiteral: record(node, 'regexp'); break;
      case ts.SyntaxKind.StringLiteral: record(node, 'string'); break;
      case ts.SyntaxKind.NoSubstitutionTemplateLiteral: if (!literals.has(node.getStart(source))) record(node, 'template'); break;
      case ts.SyntaxKind.TemplateExpression: if (!literals.has(node.head.getStart(source))) templateParts(node, 'template'); break;
      case ts.SyntaxKind.TaggedTemplateExpression: templateParts(node.template, 'tagged'); break;
    }
    ts.forEachChild(node, child => { stack.push(child); });
  }
  // Comments, found by scanning tokens and stepping over the literal tokens above, which the scanner
  // cannot tell apart from division or a closing brace without the parser's context.
  const comments = [];
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const start = scanner.getTokenStart();
    const literal = literals.get(start);
    if (literal) { scanner.resetTokenState(literal[0]); continue; }
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia || token === ts.SyntaxKind.ShebangTrivia) comments.push([start, scanner.getTokenEnd()]);
  }
  const ranges = [...[...literals].map(([start, [end, kind]]) => [start, end, kind]), ...comments.map(([start, end]) => [start, end, 'comment'])].sort((a, b) => a[0] - b[0]);
  const containing = index => {
    let low = 0, high = ranges.length - 1, found;
    while (low <= high) { const middle = (low + high) >> 1; if (ranges[middle][0] <= index) { found = ranges[middle]; low = middle + 1; } else high = middle - 1; }
    return found && index < found[1] ? found : undefined;
  };
  const where = index => { const { line, character } = source.getLineAndCharacterOfPosition(index); return `${file}:${line + 1}:${character + 1}`; };
  const hex = (value, width) => value.toString(16).toUpperCase().padStart(width, '0');
  let output = '', copied = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) < 0x80) continue;
    const range = containing(index);
    if (!range) throw new Error(`${where(index)}: non-ASCII character outside a comment or literal`);
    const [start, end, kind] = range;
    if (kind === 'comment') {
      // U+2028/2029 are line terminators: inside a block comment they can trigger semicolon insertion.
      const code = text.charCodeAt(index);
      output += text.slice(copied, index) + (code === 0x2028 || code === 0x2029 ? '\n' : '?'); copied = index + 1;
      continue;
    }
    if (kind !== 'regexp') throw new Error(`${where(index)}: non-ASCII character in a ${kind} literal; esbuild should have escaped it`);
    // Whole regular expression at once: escape each non-ASCII code point.
    const literal = text.slice(start, end), flags = literal.slice(literal.lastIndexOf('/') + 1);
    const unicode = flags.includes('u') || flags.includes('v');
    let rewritten = '';
    for (let offset = 0; offset < literal.length;) {
      const point = literal.codePointAt(offset), width = point > 0xffff ? 2 : 1;
      if (point < 0x80) { rewritten += literal[offset]; offset++; continue; }
      let slashes = 0; for (let back = offset - 1; back >= 0 && literal[back] === '\\'; back--) slashes++;
      // An escaped non-syntax character only means itself (and is an error in unicode mode).
      if (slashes % 2) { if (unicode) throw new Error(`${where(start + offset)}: escaped non-ASCII character in a unicode regular expression`); rewritten = rewritten.slice(0, -1); }
      if (/\(\?<(?![=!])[^>]*$|\\k<[^>]*$/.test(literal.slice(0, offset))) throw new Error(`${where(start + offset)}: non-ASCII capture group name`);
      // \uXXXX per code unit means the same in every mode: unicode mode reads an escaped surrogate pair as one
      // code point. The escapes stay valid if code splices this expression's source into another expression.
      for (let unit = 0; unit < width; unit++) rewritten += `\\u${hex(literal.charCodeAt(offset + unit), 4)}`;
      offset += width;
    }
    try { new RegExp(rewritten.slice(1, rewritten.lastIndexOf('/')), flags); }
    catch (error) { throw new Error(`${where(start)}: rewritten regular expression is invalid: ${error.message}`); }
    output += text.slice(copied, start) + rewritten; copied = end; index = end - 1;
  }
  output += text.slice(copied);
  if (/[^\x00-\x7f]/.test(output)) throw new Error(`${file}: ASCII rewrite left non-ASCII characters`);
  return output;
}
