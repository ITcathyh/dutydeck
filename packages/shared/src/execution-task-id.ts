import { createHash } from 'node:crypto';
import { canonicalExecutionJson, taskExecutionSchemas, taskRequestV1Schema, type TaskRequestV1 } from './index.js';

export function executionTaskId(namespace: TaskRequestV1['namespace'], sessionId: string, key: string): string {
  taskRequestV1Schema.shape.namespace.parse(namespace); taskExecutionSchemas.id.parse(sessionId); taskExecutionSchemas.id.parse(key);
  return `task_v1_${createHash('sha256').update(canonicalExecutionJson([namespace, sessionId, key])).digest('hex')}`;
}
