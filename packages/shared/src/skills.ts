export interface SkillReference {
  ref?: string;
  plugin?: string;
  version?: string;
  root?: string;
  resources?: Array<{ path: string; maxBytes: number }>;
  name: string;
  description: string;
  path: string;
  source: 'workspace' | 'user' | 'plugin';
}
