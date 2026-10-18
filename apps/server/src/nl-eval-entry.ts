/**
 * 评测包入口：scripts/nl-control-eval.mjs 启动时把它打包到 apps/server/node_modules/.cache/nl-eval/，
 * 供评测脚本和 dutydeck 桩引用线上实现。不进线上构建。
 */
import { Command, CommanderError } from 'commander';
import { addAgentCommands, agentCliErrorBody, AgentCliError } from './agent-cli.js';

export { buildEvalPrompt, type EvalPromptOptions } from './nl-eval-prompt.js';
export { addAgentCommands, agentCliErrorBody, AgentCliError, Command, CommanderError };
