import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 凭据保护：非管理员发起的这一轮里，Agent 的工具调用要读取或改动凭据、Agent 会话记录时拒绝。
 *
 * Dutydeck 把本文件作为 Claude Code / Codex 的 PreToolUse hook 运行（stdin 收工具调用，stdout 回拒绝）。
 * 是否生效看本轮的会话策略文件（runtime 每轮写入 <cwd>/.dutydeck/security/sessions/<会话>.json）：
 * 风险管控开启且发起人不在高危操作允许名单时才拦，管理员和未开风险管控的机器人不受影响。
 * 规则按文本匹配，换写法（脚本里拼路径、编码后读取）能绕过，所以它只是其中一层；发往飞书的文本另有脱敏。
 */

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const word = String.raw`[\w.@+-]`;

/** 文件路径规则：命中即拒绝。匹配前把家目录写成 ~。 */
const pathRules = [
  // Claude Code 的自动记忆在 projects/<项目>/memory/ 下，由 Agent 自己用文件工具读写，不拦。
  ['Claude Code 会话记录', new RegExp(String.raw`(?<![\w-])\.claude/(?:projects(?!/[^/\s'"]+/memory(?:/|(?![\w.-])))|sessions|transcripts|paste-cache|file-history|shell-snapshots|todos|history\.jsonl)(?![\w-])`)],
  ['Claude Code 登录信息', new RegExp(String.raw`(?<![\w-])\.claude/\.credentials\.json|(?<![\w-])\.claude\.json|~/\.claude/settings(?:\.local)?\.json`)],
  ['Codex 登录信息或会话记录', new RegExp(String.raw`(?<![\w-])\.codex/(?:auth\.json|sessions|archived_sessions|history\.jsonl|session_index\.jsonl|[\w.-]*\.sqlite(?:-wal|-shm)?)(?![\w-])`)],
  ['SSH 私钥', new RegExp(String.raw`(?<![\w-])\.ssh/(?!known_hosts(?:\.old)?(?![\w.-])|config(?![\w.-])|${word}+\.pub(?![\w.-]))${word}+|(?<![\w.-])id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?![\w.-])`)],
  ['私钥或证书文件', new RegExp(String.raw`(?<![\w.-])${word}+\.(?:pem|p12|pfx|ppk|jks|keystore)(?![\w-])|/${word}+\.key(?![\w-])`)],
  ['云服务或工具凭据', new RegExp(String.raw`(?<![\w-])\.aws/(?:credentials|sso/cache|cli/cache)|(?<![\w-])\.config/gcloud/(?:credentials\.db|access_tokens\.db|legacy_credentials|application_default_credentials\.json)|(?<![\w-])\.azure/(?:accessTokens\.json|msal_token_cache)|(?<![\w-])\.kube/config(?![\w-])|(?<![\w.-])kubeconfig(?![\w-])|(?<![\w-])\.docker/config\.json|(?<![\w-])\.config/gh/hosts\.yml|(?<![\w-])\.(?:gnupg|password-store)(?:/|(?![\w-]))|(?<![\w.-])\.(?:netrc|git-credentials|npmrc|pypirc|vault-token)(?![\w-])`)],
  ['凭据文件', new RegExp(String.raw`(?<![\w.-])(?:credentials?|secrets?|tokens?|auth|oauth[\w-]*)\.(?:json|ya?ml|toml|ini|txt|db)(?![\w-])`)],
  ['.env 文件', new RegExp(String.raw`(?<![\w.$-])\.env(?:\.(?!example(?![\w-])|sample(?![\w-])|template(?![\w-])|dist(?![\w-])|defaults?(?![\w-]))[\w-]+)*(?![\w.-])|/[\w-]+\.env(?![\w.-])`)],
  // 含密钥目录和本轮策略文件：删掉策略文件就能让这个 hook 放行，所以整个目录都不让碰。
  ['Dutydeck 数据目录', new RegExp(String.raw`(?<![\w-])\.dutydeck(?:/|(?![\w.-]))`)],
  ['进程环境变量', /\/proc\/[^/\s]+\/environ/],
];

/** 只对命令文本生效的规则：整体导出环境变量、打印凭据变量。 */
const commandRules = [
  ['全部环境变量', /(?:^|[;&|(`\n]|\$\()\s*(?:env|printenv|export\s+-p|declare\s+-x|set)\s*(?=$|[|;&>)`\n])/],
  // 只拦取值的写法；在代码里搜这些变量名是正常开发。
  ['凭据环境变量', /(?:\$\{?|\benviron(?:\.get\()?\[?\s*["']|\benv\.|\bgetenv\(\s*["'])(?:ANTHROPIC_(?:AUTH_TOKEN|API_KEY)|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY|CODEX_ACCESS_TOKEN|LARK_APP_SECRET|dutydeck_(?:relay|group_tools)_token)\b/i],
  ['凭据环境变量', /\bprintenv\s+\w*(?:TOKEN|SECRET|PASSW|KEY|AUTH)|\b(?:echo|printf|print)\b[^\n;|&]*\$\{?\w*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY)/i],
];

/** cd 进 Agent 数据目录后用相对路径读取：命令或会话目录提到 .claude / .codex，同时提到其中的敏感文件名。 */
const agentDirectory = /(?<![\w-])\.(?:claude|codex)(?:\/|(?![\w.-]))/;
const agentDataName = /(?<![\w./-])(?:auth\.json|\.credentials\.json|sessions|archived_sessions|projects|paste-cache|history\.jsonl|session_index\.jsonl)(?![\w-])/;

/** 由 hook 处理的工具：命令类看命令文本，文件类看路径参数。其余工具（待办、子 agent 提示等）是自然语言，不检查。 */
export const secretGuardToolMatcher = '^(?:Bash|Monitor|Read|NotebookRead|Write|Edit|MultiEdit|NotebookEdit|Grep|apply_patch)$';

function homes(home) {
  const list = [home];
  try { list.push(realpathSync(home)); } catch {}
  return [...new Set(list.filter(Boolean).map(item => item.replace(/\/+$/, '')))].sort((a, b) => b.length - a.length);
}

function normalize(text, home) {
  let value = text.replace(/\$\{HOME\}|\$HOME(?![\w])/g, '~');
  for (const item of homes(home)) value = value.split(item).join('~');
  return value;
}

function match(rules, text) {
  for (const [label, pattern] of rules) {
    const found = pattern.exec(text);
    if (found) return { label, match: found[0].trim().slice(0, 120) };
  }
  return undefined;
}

/** 一个文件路径是否属于受保护的凭据或会话记录。相对路径按 cwd 解析。 */
export function protectedPathFinding(path, { cwd = process.cwd(), home = process.env.HOME || homedir() } = {}) {
  if (typeof path !== 'string' || !path.trim()) return undefined;
  const expanded = path.trim().replace(/^~(?=\/|$)/, home);
  return match(pathRules, normalize(isAbsolute(expanded) ? expanded : resolve(cwd, expanded), home));
}

const strings = value => typeof value === 'string' ? [value]
  : Array.isArray(value) ? value.flatMap(strings)
    : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];

/** 一次工具调用是否触碰凭据或会话记录；返回命中的类别和片段，没有命中返回 undefined。 */
export function secretGuardFinding(event, { home = process.env.HOME || homedir() } = {}) {
  const tool = String(event?.tool_name ?? event?.toolName ?? '');
  const input = event?.tool_input ?? event?.toolInput ?? {};
  const cwd = typeof event?.cwd === 'string' && event.cwd ? event.cwd : process.cwd();
  const options = { cwd, home };
  if (tool === 'Bash' || tool === 'Monitor') {
    const command = normalize(strings(input.command ?? input.cmd).join(' '), home);
    const found = match(pathRules, command) ?? match(commandRules, command);
    if (found) return found;
    if ((agentDirectory.test(command) || agentDirectory.test(normalize(cwd, home))) && agentDataName.test(command)) {
      return { label: 'Agent 登录信息或会话记录', match: agentDataName.exec(command)[0] };
    }
    return undefined;
  }
  if (tool === 'apply_patch') {
    const paths = strings(input).flatMap(text => [...text.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map(item => item[1]));
    for (const path of paths) { const found = protectedPathFinding(path, options); if (found) return found; }
    return undefined;
  }
  for (const key of ['file_path', 'notebook_path', 'path', 'glob']) {
    const found = protectedPathFinding(input[key], options);
    if (found) return found;
  }
  return undefined;
}

export function secretGuardReason(finding) {
  return `Dutydeck 凭据保护：这一步会读取或改动${finding.label}（${finding.match}），已拦截，没有执行。`
    + '不要换别的方式读取、复制或输出它；需要用凭据时直接运行已登录的命令行工具，确实要看内容就请用户本人在终端处理。';
}

/**
 * hook 脚本的位置。源码树里就是本文件；打包进 dist/cli.js 后改用构建复制到 dist/agents/ 的那份。
 * 部署目录是 releases/<版本>/，经 releases/current 引用，旧版本目录被清理后长期会话的 hook 仍然可用。
 */
export function secretGuardScriptPath() {
  const self = fileURLToPath(import.meta.url);
  const path = basename(self) === 'secret-guard.mjs' ? self : join(dirname(self), 'agents', 'secret-guard.mjs');
  const release = /^(.*\/releases)\/[^/]+(\/.+)$/.exec(path);
  if (!release) return path;
  const current = join(release[1], 'current', release[2]);
  try { return realpathSync(current) === realpathSync(path) ? current : path; }
  catch { return path; }
}

const policyFile = (root, sessionId) => join(root, '.dutydeck', 'security', 'sessions', `${sessionId}.json`);

/**
 * 给 Agent CLI 配置的 hook 命令。先用 grep 看本轮策略里有没有未授权标记，没有就直接放行，管理员每次工具调用只多一次 grep；
 * 有标记才起 node 逐条检查，脚本跑不起来（如文件被删）时按拒绝处理，不静默放行。
 */
export function secretGuardHookCommand({ nodePath = process.execPath, policyRoot }) {
  const root = quote(policyRoot);
  return `grep -qs '"authorized":false' ${root}/.dutydeck/security/sessions/"$dutydeck_session_id".json || exit 0; `
    + `DUTYDECK_POLICY_ROOT=${root} ${quote(nodePath)} ${quote(secretGuardScriptPath())} || exit 2`;
}

/** 本轮是否要拦：风险管控开启（enabled）且发起人未获授权。读不到策略按不拦处理，和高危操作 hook 一致。 */
export function secretGuardActive({ root, sessionId }) {
  if (!sessionId) return false;
  try {
    const policy = JSON.parse(readFileSync(policyFile(root, sessionId), 'utf8'));
    return policy?.enabled === true && policy.authorized === false;
  } catch { return false; }
}

async function runHook() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  let event;
  try { event = JSON.parse(raw); }
  catch {
    process.stderr.write('Dutydeck 凭据保护无法解析这次工具调用，已拦截。');
    process.exit(2);
  }
  const root = process.env.DUTYDECK_POLICY_ROOT || event?.cwd || process.cwd();
  if (!secretGuardActive({ root, sessionId: process.env.dutydeck_session_id })) return;
  const finding = secretGuardFinding(event);
  if (!finding) return;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: secretGuardReason(finding) } }));
}

const entry = process.argv[1];
if (entry && basename(fileURLToPath(import.meta.url)) === 'secret-guard.mjs') {
  let main = false;
  try { main = realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
  if (main) await runHook();
}
