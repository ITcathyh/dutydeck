// Pure parsing for the RoveTap `/job` command.
//
// Security note: this module only decides *whether a message is a /job command
// and which project token it names*. It never authorizes anyone and never
// treats message/mention text as trusted instructions. Authorization lives in
// handler.mjs.
//
// This file is dependency-free ESM so the packaged plugin service can run on
// plain Node >=22 without an install/build step.

export const DEFAULT_INSTRUCTION = '请项目 leader 跟进这条反馈。';

/**
 * Feishu text messages render mentions as placeholders such as `@_user_1`.
 * `mentions` is the raw `event.message.mentions` array; we normalize it here
 * because command parsing needs to see a leading bot mention and an optional
 * `@project` target.
 *
 * Returns the display text with placeholders replaced:
 *  - a mention whose open_id equals the trusted `selfOpenId` is removed (the
 *    addressed bot);
 *  - any other known mention becomes `@<name>` (whitespace removed so it is
 *    one token), which keeps blocking the /job anchor when it leads;
 *  - a placeholder with no matching event mention is left verbatim, so text
 *    that merely looks like a mention can never be stripped.
 *
 * `selfOpenId` comes from trusted configuration. When it is empty no mention
 * is proven to be self, so @-prefixed forms do not parse; a bare `/job` still
 * does.
 */
export function renderMentionText(text, mentions, selfOpenId) {
  if (typeof text !== 'string') return '';
  if (!Array.isArray(mentions) || mentions.length === 0) return text;
  const byKey = new Map();
  for (const m of mentions) {
    if (!m || typeof m !== 'object') continue;
    const key = typeof m.key === 'string' ? m.key : undefined;
    if (!key) continue;
    const openId = m.id && typeof m.id === 'object' ? m.id.open_id : undefined;
    const isSelf = selfOpenId && openId && openId === selfOpenId;
    if (isSelf) byKey.set(key, ' ');
    else {
      const name = typeof m.name === 'string' && m.name.trim() ? m.name.replace(/\s+/g, '') : 'user';
      byKey.set(key, `@${name}`);
    }
  }
  if (!byKey.size) return text;
  // Replace longer keys first (keys are `@_user_<n>` so order barely matters,
  // but be safe).
  const keys = [...byKey.keys()].sort((a, b) => b.length - a.length);
  let out = text;
  for (const key of keys) out = out.split(key).join(byKey.get(key));
  return out;
}

// `/job` must be followed by whitespace or end-of-text: `/jobs`, `/jobx`,
// `/job/foo` and `/job,` are different text, not a command with an argument.
const JOB_ANCHOR = /^\/job(?=\s|$)/i;
const TARGET_TOKEN = /^@?([A-Za-z0-9_-]+)(?=\s|$)/;

/**
 * Parse a message's readable text.
 *
 * @returns {{kind:'not-command'} |
 *           {kind:'job', alias:string, instruction:string, explicitTarget:boolean} |
 *           {kind:'unknown-project', token:string}}
 *
 * Mirrors the approved prototype semantics:
 *  - the trusted self mention is stripped beforehand by renderMentionText;
 *    after that only whitespace may precede `/job`. Any remaining leading
 *    `@token` (another person/bot, or an unauthenticated look-alike) makes the
 *    message `not-command`;
 *  - `/job rovetap …` or `/job @rovetap …` selects the project;
 *  - a leading `@something` after /job is always a project token; anything but a
 *    configured alias is an ambiguous/unknown project (caller stops propagation);
 *  - a bare word that is not the alias is the start of the instruction, so
 *    `/job fix the draft bug` uses the default project;
 *  - empty instruction -> the default instruction.
 *
 * Only a `/job` anchored at the start (after whitespace/a stripped self
 * mention) is a command. An ordinary sentence that merely contains `/job`
 * mid-text is `not-command` and must continue through Dutydeck normally.
 */
export function parseJobCommand(rawText, options = {}) {
  if (typeof rawText !== 'string') return { kind: 'not-command' };
  const s = rawText.trim();
  if (!s) return { kind: 'not-command' };

  const anchor = JOB_ANCHOR.exec(s);
  if (!anchor) return { kind: 'not-command' };
  let rest = s.slice(anchor[0].length).trim();

  const aliases = new Set(
    [options.defaultAlias ?? 'rovetap', ...(Array.isArray(options.aliases) ? options.aliases : [])]
      .filter((a) => typeof a === 'string' && a.trim())
      .map((a) => a.toLowerCase()),
  );
  const defaultAlias = options.defaultAlias ?? 'rovetap';

  // An explicit `@token` right after /job is always intended as the project.
  const atTarget = /^@([^\s]+)(?=\s|$)/.exec(rest);
  if (atTarget) {
    // A leftover Feishu placeholder (`_user_2`) simply never matches an alias.
    const token = atTarget[1];
    rest = rest.slice(atTarget[0].length).trim();
    if (aliases.has(token.toLowerCase())) {
      return job(defaultAlias, rest, true);
    }
    return { kind: 'unknown-project', token };
  }

  // A bare token is a project target only when it exactly names an alias and is
  // followed by whitespace/end. Otherwise the whole remainder is instruction.
  const tm = TARGET_TOKEN.exec(rest);
  if (tm && aliases.has(tm[1].toLowerCase())) {
    rest = rest.slice(tm[0].length).trim();
    return job(defaultAlias, rest, true);
  }

  return job(defaultAlias, rest, false);
}

function job(alias, rest, explicitTarget) {
  const instruction = rest && rest.trim() ? rest.trim() : DEFAULT_INSTRUCTION;
  return { kind: 'job', alias, instruction, explicitTarget };
}

/** Extract plain text from a Feishu `text` or simple `post` message content. */
export function extractMessageText(messageType, content) {
  let parsed = content;
  if (typeof content === 'string') {
    try { parsed = JSON.parse(content); } catch { return typeof content === 'string' ? content : ''; }
  }
  if (!parsed || typeof parsed !== 'object') return '';
  if (messageType === 'text' && typeof parsed.text === 'string') return parsed.text;
  if (messageType === 'post') {
    // post content is either {title, content:[[{tag,text,...}]]} or locale-keyed.
    const root = parsed.post && typeof parsed.post === 'object' ? parsed.post : parsed;
    const localeBody = root.zh_cn ?? root.en_us ?? root.ja_jp ?? root;
    const parts = [];
    if (localeBody && typeof localeBody.title === 'string' && localeBody.title.trim()) parts.push(localeBody.title);
    const lines = localeBody && Array.isArray(localeBody.content) ? localeBody.content : [];
    for (const line of lines) {
      if (!Array.isArray(line)) continue;
      const lineText = line
        .map((node) => {
          if (!node || typeof node !== 'object') return '';
          if (node.tag === 'a' && typeof node.href === 'string') return node.text ? `${node.text} (${node.href})` : node.href;
          if (node.tag === 'at' && typeof node.user_name === 'string') return `@${node.user_name}`;
          if (typeof node.text === 'string') return node.text;
          return '';
        })
        .join('');
      if (lineText) parts.push(lineText);
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * Whether an inbound event message itself carries forward provenance.
 *
 * `merge_forward` is the reliable platform type for merged/chat-record
 * forwards and is handled by the caller via message_type. The explicit
 * descriptors below mirror materials.mjs and only matter on shapes that
 * expose them; a single forwarded text message can arrive as an ordinary
 * `text` event with no provenance, which the platform does not let us tell
 * apart from freshly typed text.
 */
export function isForwardedMessage(message) {
  if (!message || typeof message !== 'object') return false;
  return message.forward === true
    || (message.forward && typeof message.forward === 'object')
    || Boolean(message.forward_from)
    || Boolean(message.origin && typeof message.origin === 'object' && message.origin.message_id);
}
