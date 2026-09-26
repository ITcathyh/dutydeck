# Transcript schema fixtures

Captured by read-only inspection of local CLI transcripts on 2026-09-26:

- Claude Code: `~/.claude/projects/**/*.jsonl`, main-thread assistant text record.
- Codex: `~/.codex/sessions/**/*.jsonl`, `event_msg/task_complete` final answer.
- Traex: `~/.trae/cli/sessions/**/*.jsonl`, `event_msg/agent_message` with `phase: final_answer`.

These are minimal schema projections of actual records, not verbatim transcripts.
All user/provider text and identifiers are replaced; paths, timestamps, credentials,
usage, model identifiers and unrelated metadata are omitted. No model was invoked.
Tests enlarge the sanitized answer to exercise multi-chunk delivery without private data.
