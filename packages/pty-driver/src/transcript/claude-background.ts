/** Native Claude task lifecycle metadata; tool-result prose is never a launch receipt. */
export class ClaudeBackgroundTasks {
  private readonly calls = new Map<string, { name: string; originInputId?: string }>();
  private readonly tasks = new Map<string, { id: string; toolUseId: string; kind: 'agent' | 'shell' | 'monitor'; originInputId?: string; state: string; expiresAt?: number }>();
  private inputId?: string;
  private notification = false;
  private ended = false;

  observe(entry: any): boolean {
    if (entry?.isSidechain === true) return false;
    const before = JSON.stringify(this.snapshot());
    const content = entry.message?.content;
    const notificationText = entry.type === 'queue-operation' && entry.operation === 'enqueue' ? entry.content
      : entry.attachment?.type === 'queued_command' && entry.attachment.commandMode === 'task-notification' ? entry.attachment.prompt
      : entry.turnOrigin === 'task_notification' || entry.origin?.kind === 'task-notification'
        ? typeof content === 'string' ? content : content?.filter?.((block: any) => block.type === 'text').map((block: any) => block.text).join('\n') : undefined;
    if (typeof notificationText === 'string' && notificationText.trimStart().startsWith('<task-notification>')) {
      const ids = [...notificationText.matchAll(/<task-id>([^<]+)<\/task-id>/g)].map(match => match[1]!.trim());
      if (entry.type === 'user') this.notification = ids.some(id => {
        const task = this.tasks.get(id);
        return task && (this.ended || task.originInputId !== this.inputId);
      });
      const state = /<status>(completed|failed|killed|stopped)<\/status>/.exec(notificationText)?.[1];
      const toolUseId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(notificationText)?.[1]?.trim();
      if (state) for (const id of ids) { const task = this.tasks.get(id); if (task && (!toolUseId || task.toolUseId === toolUseId)) task.state = state; }
    } else if (claudeInputText(entry) !== undefined && !entry.isMeta) {
      this.inputId = entry.uuid; this.notification = false; this.ended = false;
    }
    if (entry.type === 'assistant' && Array.isArray(content) && !this.notification) {
      for (const block of content) if (block.type === 'tool_use' && typeof block.id === 'string') this.calls.set(block.id, { name: block.name, originInputId: this.inputId });
      if (entry.message?.stop_reason === 'end_turn' && content.some((block: any) => block.type === 'text' && block.text?.trim())) this.ended = true;
    }
    if (entry.type === 'user' && Array.isArray(content)) {
      const result = entry.toolUseResult;
      for (const block of content) {
        const call = this.calls.get(block.tool_use_id);
        if (block.type !== 'tool_result' || block.is_error || !call || !result || typeof result !== 'object') continue;
        let task: { id: string; kind: 'agent' | 'shell' | 'monitor'; expiresAt?: number } | undefined;
        if (['Agent', 'Task'].includes(call.name) && result.isAsync === true && typeof result.agentId === 'string') task = { id: result.agentId, kind: 'agent' };
        else if (call.name === 'Bash' && typeof result.backgroundTaskId === 'string') task = { id: result.backgroundTaskId, kind: 'shell' };
        else if (call.name === 'Monitor' && typeof result.taskId === 'string' && typeof result.persistent === 'boolean' && Number.isFinite(result.timeoutMs)) {
          const at = Date.parse(entry.timestamp);
          task = { id: result.taskId, kind: 'monitor', ...(!result.persistent && result.timeoutMs > 0 && Number.isFinite(at) ? { expiresAt: at + result.timeoutMs } : {}) };
        } else if (call.name === 'TaskStop' && typeof result.task_id === 'string' && typeof result.task_type === 'string') {
          const stopped = this.tasks.get(result.task_id); if (stopped) stopped.state = 'stopped';
        }
        if (task?.id) this.tasks.set(task.id, { ...task, toolUseId: block.tool_use_id, originInputId: call.originInputId, state: 'running' });
        this.calls.delete(block.tool_use_id);
      }
    }
    // Metadata is bounded independently of session length; retain live tasks.
    if (this.tasks.size > 1000) for (const [id, task] of this.tasks) { if (task.state !== 'running') this.tasks.delete(id); if (this.tasks.size <= 1000) break; }
    while (this.calls.size > 1000) this.calls.delete(this.calls.keys().next().value!);
    return this.tasks.size > 0 && before !== JSON.stringify(this.snapshot());
  }
  snapshot() {
    const tasks = [...this.tasks.values()].map(task => task.state === 'running' && task.expiresAt !== undefined && task.expiresAt <= Date.now() ? { ...task, state: 'expired' } : { ...task });
    return { state: 'background_work', count: tasks.filter(task => task.state === 'running').length, mainTurnEnded: this.ended, tasks };
  }
  isNotificationContinuation(): boolean { return this.notification; }
  independent(): boolean { return this.ended && this.snapshot().count > 0; }
}
import { claudeInputText } from './input-receipt.js';

