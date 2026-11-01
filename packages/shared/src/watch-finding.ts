import { z } from 'zod';

export const watchFindingSchema = z.object({
  schemaVersion: z.literal(1),
  appId: z.string().min(1),
  fingerprint: z.string().min(1),
  kind: z.string().min(1),
  objectId: z.string().min(1),
  title: z.string().min(1),
  since: z.string().datetime(),
  location: z.string().min(1),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  episode: z.number().int().positive(),
  notifiedAt: z.string().datetime().optional(),
  notificationUnknownAt: z.string().datetime().optional(),
  recoveredAt: z.string().datetime().optional()
}).strict();
