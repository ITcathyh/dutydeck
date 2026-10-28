import type { EventArtifactReference } from './event-content.js';

/** A disposable read projection. Its text is never a canonical event or execution receipt. */
export interface HistoryTurnSummary {
  id: string;
  taskId?: string;
  attemptId?: string;
  firstSequence: number;
  lastSequence: number;
  timestamp: string;
  status: string;
  prompt: { text: string; truncated: boolean };
  output: { text: string; truncated: boolean };
  toolCount: number;
  artifactReferences: EventArtifactReference[];
  artifactReferencesTruncated?: boolean;
}
export interface HistoryOutline {
  turns: HistoryTurnSummary[];
  highWaterMark: number;
  commandCatalog?: { sequence: number; commands: Array<{ name: string; description: string }>; truncated: boolean };
  /** Canonical events after this point belong to the still-active suffix. */
  liveAfter: number;
}
