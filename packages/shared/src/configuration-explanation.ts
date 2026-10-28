/** Read-only observations; unknown history must never be reconstructed from current settings. */
export interface ConfigurationField {
  key: string;
  label: string;
  value?: string | number | boolean;
  status: 'recorded' | 'unset' | 'unknown' | 'unverified';
  source: string;
  reason?: string;
  revision?: number;
}
export interface ConfigurationSection {
  phase: 'saved' | 'session' | 'attempt' | 'tool_call' | 'native';
  title: string;
  note: string;
  fields: ConfigurationField[];
}
export interface ConfigurationExplanation {
  sessionId: string;
  observedAt: string;
  taskId?: string;
  attemptId?: string;
  tasks: Array<{ id: string; attempts: Array<{ id: string; number: number; state: string }> }>;
  sections: ConfigurationSection[];
}
