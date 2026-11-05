import { RuntimeError } from '@dutydeck/shared';

// Internal helpers shared by the foundation and group-policy repositories; not re-exported from the package index.
export function notFound(kind: string, id: string): RuntimeError {
  return new RuntimeError('FOUNDATION_NOT_FOUND', `${kind} ${id} was not found`, 404);
}

export function revisionConflict(kind: string, id: string, expectedRevision: number): RuntimeError {
  return new RuntimeError('FOUNDATION_REVISION_CONFLICT', `${kind} ${id} is no longer at revision ${expectedRevision}`, 409);
}

export function naturalKeyConflict(kind: string, identity: string): RuntimeError {
  return new RuntimeError('FOUNDATION_NATURAL_KEY_CONFLICT', `${kind} already exists for ${identity}`, 409);
}

export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && 'then' in value && typeof (value as { then?: unknown }).then === 'function';
}
