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

/** A user-requested capture of current bytes, never proof of the event-time file contents. */
export interface ArtifactSnapshot {
  version: 1;
  id: string;
  sessionId: string;
  taskId: string;
  attemptId: string;
  eventId: string;
  sequence: number;
  partIndex: number;
  revision: string;
  size: number;
  sha256: string;
  capturedAt: string;
  mimeType: 'text/plain' | 'application/octet-stream';
  name: string;
}
export type ArtifactSnapshotReference = Pick<ArtifactSnapshot, 'taskId' | 'attemptId' | 'eventId' | 'sequence' | 'partIndex' | 'revision'>;
export interface ArtifactSnapshotPreview {
  snapshot: ArtifactSnapshot;
  text?: string;
  truncated: boolean;
}
