#!/usr/bin/env node
/**
 * Machine verification script for Session Insight real-native fixtures.
 *
 * Verifies that:
 *  1. All fixture files are valid JSON per line.
 *  2. No credentials, tokens, or private home paths leak into fixtures.
 *  3. (When raw source paths are supplied via CLI flags):
 *     - Verifies numerical usage values, timestamps, and exit codes.
 *     - Verifies actual models (message.model, payload.model, meta model).
 *     - Verifies root identity (sessionId, agentId, isSidechain, uuid, parentUuid, message.id, callId, meta id).
 *
 * Usage:
 *   node verify-fidelity.mjs
 *   node verify-fidelity.mjs --codex-raw <path> --traex-raw <path> --claude-main-raw <path> --claude-sub-raw <path>
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIXTURES = {
  codex: path.join(__dirname, 'codex.jsonl'),
  traex: path.join(__dirname, 'traex.jsonl'),
  claudeMain: path.join(__dirname, 'claude-main.jsonl'),
  claudeSubagent: path.join(__dirname, 'claude-subagent.jsonl'),
};

const FORBIDDEN_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/,
  /ghp_[a-zA-Z0-9]{20,}/,
  /bearer\s+[a-zA-Z0-9_\-\.]{20,}/i,
  /\/data00\/home\//i,
  /\/home\/[a-zA-Z0-9_\-\.]+\.edu/i,
];

function auditFixtureFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n');
  const sha256 = crypto.createHash('sha256').update(content, 'utf8').digest('hex');

  lines.forEach((line, idx) => {
    try {
      JSON.parse(line);
    } catch (err) {
      throw new Error(`Invalid JSON in ${filePath}:${idx + 1}: ${err.message}`);
    }
  });

  for (const reg of FORBIDDEN_PATTERNS) {
    if (reg.test(content)) {
      throw new Error(`Matched forbidden pattern ${reg} in ${filePath}`);
    }
  }

  return { lines: lines.length, bytes: Buffer.byteLength(content, 'utf8'), sha256 };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = {};
  for (let i = 0; i < args.length; i += 2) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
    }
  }
  return flags;
}

function verifyCodexFidelity(rawPath) {
  const rawLines = fs.readFileSync(rawPath, 'utf8').trim().split('\n');
  const fixLines = fs.readFileSync(FIXTURES.codex, 'utf8').trim().split('\n');
  if (rawLines.length !== fixLines.length) {
    throw new Error(`Codex line count mismatch: raw ${rawLines.length} vs fixture ${fixLines.length}`);
  }
  let verifiedUsageCount = 0;
  rawLines.forEach((rawL, idx) => {
    const rawObj = JSON.parse(rawL);
    const fixObj = JSON.parse(fixLines[idx]);
    if (rawObj.timestamp !== fixObj.timestamp) {
      throw new Error(`Codex L${idx + 1} timestamp mismatch`);
    }
    // Meta identity and model check
    if (rawObj.type === 'session_meta') {
      if (rawObj.payload.id !== fixObj.payload.id) {
        throw new Error(`Codex meta id mismatch: ${rawObj.payload.id} vs ${fixObj.payload.id}`);
      }
      if (rawObj.payload.model !== fixObj.payload.model) {
        throw new Error(`Codex model mismatch: ${rawObj.payload.model} vs ${fixObj.payload.model}`);
      }
    }
    // Token usage check
    if (rawObj.payload?.type === 'token_count') {
      const rUsage = JSON.stringify(rawObj.payload.info);
      const fUsage = JSON.stringify(fixObj.payload.info);
      if (rUsage !== fUsage) {
        throw new Error(`Codex L${idx + 1} token_count mismatch`);
      }
      verifiedUsageCount++;
    }
    // Tool call ID and exit code check
    if (rawObj.payload?.type === 'item_completed' && rawObj.payload.item?.type === 'CommandExecution') {
      if (rawObj.payload.item.id !== fixObj.payload.item.id) {
        throw new Error(`Codex L${idx + 1} tool call id mismatch`);
      }
      if (rawObj.payload.item.exit_code !== fixObj.payload.item.exit_code) {
        throw new Error(`Codex L${idx + 1} exit_code mismatch`);
      }
    }
  });
  console.log(`[PASS] Codex fidelity verified: model, session id, callIds, exit codes, and ${verifiedUsageCount} usage checkpoints matching exactly.`);
}

function verifyTraexFidelity(rawPath) {
  const rawLines = fs.readFileSync(rawPath, 'utf8').trim().split('\n');
  const fixLines = fs.readFileSync(FIXTURES.traex, 'utf8').trim().split('\n');
  if (rawLines.length !== fixLines.length) {
    throw new Error(`TraeX line count mismatch: raw ${rawLines.length} vs fixture ${fixLines.length}`);
  }
  let verifiedUsageCount = 0;
  rawLines.forEach((rawL, idx) => {
    const rawObj = JSON.parse(rawL);
    const fixObj = JSON.parse(fixLines[idx]);
    if (rawObj.timestamp !== fixObj.timestamp) {
      throw new Error(`TraeX L${idx + 1} timestamp mismatch`);
    }
    // Meta identity and model check
    if (rawObj.type === 'session_meta') {
      if (rawObj.payload.id !== fixObj.payload.id) {
        throw new Error(`TraeX meta id mismatch: ${rawObj.payload.id} vs ${fixObj.payload.id}`);
      }
      if (rawObj.payload.model !== fixObj.payload.model) {
        throw new Error(`TraeX model mismatch: ${rawObj.payload.model} vs ${fixObj.payload.model}`);
      }
    }
    // Token usage check
    if (rawObj.payload?.type === 'token_count') {
      const rUsage = JSON.stringify(rawObj.payload.info);
      const fUsage = JSON.stringify(fixObj.payload.info);
      if (rUsage !== fUsage) {
        throw new Error(`TraeX L${idx + 1} token_count mismatch`);
      }
      verifiedUsageCount++;
    }
    // Tool call ID and exit code check
    if (rawObj.payload?.type === 'item_completed' && (rawObj.payload.item?.type === 'CommandExecution' || rawObj.payload.item?.item_type === 'CommandExecution')) {
      if (rawObj.payload.item.id !== fixObj.payload.item.id) {
        throw new Error(`TraeX L${idx + 1} tool call id mismatch`);
      }
      if (rawObj.payload.item.exit_code !== fixObj.payload.item.exit_code) {
        throw new Error(`TraeX L${idx + 1} exit_code mismatch`);
      }
    }
  });
  console.log(`[PASS] TraeX fidelity verified: model, session id, callIds, exit codes, and ${verifiedUsageCount} usage checkpoints matching exactly.`);
}

function verifyClaudeMainFidelity(rawPath) {
  const rawLines = fs.readFileSync(rawPath, 'utf8').trim().split('\n');
  const fixLines = fs.readFileSync(FIXTURES.claudeMain, 'utf8').trim().split('\n');
  const nonAttachmentRaw = rawLines
    .map((l, i) => ({ rawLine: i + 1, obj: JSON.parse(l) }))
    .filter(e => !['queue-operation', 'attachment', 'atis-latch', 'last-prompt', 'cost-state'].includes(e.obj.type));
  if (nonAttachmentRaw.length !== fixLines.length) {
    throw new Error(`Claude Main mapped count mismatch: raw filtered ${nonAttachmentRaw.length} vs fixture ${fixLines.length}`);
  }
  let verifiedUsageCount = 0;
  nonAttachmentRaw.forEach((entry, idx) => {
    const fixObj = JSON.parse(fixLines[idx]);
    if (entry.obj.timestamp !== fixObj.timestamp) {
      throw new Error(`Claude Main L${idx + 1} timestamp mismatch`);
    }
    if (entry.obj.sessionId !== fixObj.sessionId) {
      throw new Error(`Claude Main L${idx + 1} sessionId mismatch: ${entry.obj.sessionId} vs ${fixObj.sessionId}`);
    }
    if (entry.obj.isSidechain !== fixObj.isSidechain) {
      throw new Error(`Claude Main L${idx + 1} isSidechain mismatch`);
    }
    if (entry.obj.uuid !== fixObj.uuid) {
      throw new Error(`Claude Main L${idx + 1} uuid mismatch`);
    }
    if (entry.obj.parentUuid !== fixObj.parentUuid) {
      throw new Error(`Claude Main L${idx + 1} parentUuid mismatch`);
    }
    if (entry.obj.message?.id !== fixObj.message?.id) {
      throw new Error(`Claude Main L${idx + 1} message.id mismatch`);
    }
    if (entry.obj.message?.model !== fixObj.message?.model) {
      throw new Error(`Claude Main L${idx + 1} model mismatch: ${entry.obj.message?.model} vs ${fixObj.message?.model}`);
    }
    if (entry.obj.message?.usage) {
      const rUsage = JSON.stringify(entry.obj.message.usage);
      const fUsage = JSON.stringify(fixObj.message.usage);
      if (rUsage !== fUsage) {
        throw new Error(`Claude Main L${idx + 1} usage mismatch`);
      }
      verifiedUsageCount++;
    }
  });
  console.log(`[PASS] Claude Main fidelity verified: sessionId, isSidechain, uuid/parentUuid, message.id, model, and ${verifiedUsageCount} usage checkpoints matching exactly.`);
}

function verifyClaudeSubagentFidelity(rawPath) {
  const rawLines = fs.readFileSync(rawPath, 'utf8').trim().split('\n');
  const fixLines = fs.readFileSync(FIXTURES.claudeSubagent, 'utf8').trim().split('\n');
  const nonAttachmentRaw = rawLines
    .map((l, i) => ({ rawLine: i + 1, obj: JSON.parse(l) }))
    .filter(e => e.obj.type !== 'attachment');
  if (nonAttachmentRaw.length !== fixLines.length) {
    throw new Error(`Claude Subagent mapped count mismatch: raw filtered ${nonAttachmentRaw.length} vs fixture ${fixLines.length}`);
  }
  let verifiedUsageCount = 0;
  nonAttachmentRaw.forEach((entry, idx) => {
    const fixObj = JSON.parse(fixLines[idx]);
    if (entry.obj.timestamp !== fixObj.timestamp) {
      throw new Error(`Claude Subagent L${idx + 1} timestamp mismatch`);
    }
    if (entry.obj.sessionId !== fixObj.sessionId) {
      throw new Error(`Claude Subagent L${idx + 1} sessionId mismatch: ${entry.obj.sessionId} vs ${fixObj.sessionId}`);
    }
    if (entry.obj.agentId !== fixObj.agentId) {
      throw new Error(`Claude Subagent L${idx + 1} agentId mismatch: ${entry.obj.agentId} vs ${fixObj.agentId}`);
    }
    if (entry.obj.isSidechain !== fixObj.isSidechain) {
      throw new Error(`Claude Subagent L${idx + 1} isSidechain mismatch`);
    }
    if (entry.obj.uuid !== fixObj.uuid) {
      throw new Error(`Claude Subagent L${idx + 1} uuid mismatch`);
    }
    if (entry.obj.parentUuid !== fixObj.parentUuid) {
      throw new Error(`Claude Subagent L${idx + 1} parentUuid mismatch`);
    }
    if (entry.obj.message?.id !== fixObj.message?.id) {
      throw new Error(`Claude Subagent L${idx + 1} message.id mismatch`);
    }
    if (entry.obj.message?.model !== fixObj.message?.model) {
      throw new Error(`Claude Subagent L${idx + 1} model mismatch: ${entry.obj.message?.model} vs ${fixObj.message?.model}`);
    }
    if (entry.obj.message?.usage) {
      const rUsage = JSON.stringify(entry.obj.message.usage);
      const fUsage = JSON.stringify(fixObj.message.usage);
      if (rUsage !== fUsage) {
        throw new Error(`Claude Subagent L${idx + 1} usage mismatch`);
      }
      verifiedUsageCount++;
    }
  });
  console.log(`[PASS] Claude Subagent fidelity verified: sessionId, agentId, isSidechain, uuid/parentUuid, message.id, model, and ${verifiedUsageCount} usage checkpoints matching exactly.`);
}

function main() {
  console.log('Auditing real-native fixtures integrity & canary...');
  const stats = {};
  for (const [key, p] of Object.entries(FIXTURES)) {
    stats[key] = auditFixtureFile(p);
    console.log(`  ${key}: ${stats[key].lines} lines, ${stats[key].bytes} bytes, sha256: ${stats[key].sha256}`);
  }
  console.log('[PASS] All fixtures passed JSON validation and canary pattern checks.');

  const flags = parseArgs();
  if (flags['codex-raw']) verifyCodexFidelity(flags['codex-raw']);
  if (flags['traex-raw']) verifyTraexFidelity(flags['traex-raw']);
  if (flags['claude-main-raw']) verifyClaudeMainFidelity(flags['claude-main-raw']);
  if (flags['claude-sub-raw']) verifyClaudeSubagentFidelity(flags['claude-sub-raw']);

  if (!flags['codex-raw'] && !flags['traex-raw'] && !flags['claude-main-raw'] && !flags['claude-sub-raw']) {
    console.log('\n(Notice: to verify raw source fidelity, supply raw file paths via:');
    console.log('  node verify-fidelity.mjs --codex-raw <path> --traex-raw <path> --claude-main-raw <path> --claude-sub-raw <path>)');
  }
}

main();
