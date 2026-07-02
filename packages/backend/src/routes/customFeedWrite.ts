/**
 * Pure request-payload builders for the custom-feed write routes (POST / PUT).
 *
 * These translate a whitelisted request body into the exact fields to persist,
 * validating the composable `definition` against the module registry. They NEVER
 * read the owner id from the body (the route sets it from the session) and NEVER
 * spread `req.body` — only the known fields are copied, so a client cannot
 * mass-assign `subscriberCount`, `ownerOxyUserId`, ratings, etc.
 *
 * Kept pure (no Express, no Mongo) so the whitelist + validation are unit-testable
 * without a server or database; the route handlers do only auth + persistence.
 */

import type { StoredFeedDefinition } from '../models/CustomFeed';
import { validateDefinition } from '../mtn/feed/definitions/validateDefinition';
import type { FeedModuleRegistry } from '../mtn/feed/engine/FeedModuleRegistry';

const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_ICON_LENGTH = 64;

export interface CustomFeedWriteOptions {
  /** Registry to validate the definition against; defaults to the shared singleton. */
  registry?: FeedModuleRegistry;
}

/** The persisted fields a create builds. */
export interface CustomFeedCreatePayload {
  title: string;
  description?: string;
  isPublic: boolean;
  icon?: string;
  definition: StoredFeedDefinition;
}

/** The persisted fields an update patches (only provided keys are present). */
export interface CustomFeedUpdatePatch {
  title?: string;
  description?: string;
  isPublic?: boolean;
  icon?: string;
  definition?: StoredFeedDefinition;
}

export type BuildResult<T> = { ok: true; payload: T } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Resolve the public flag from a `visibility` string or an `isPublic` boolean. */
function resolveIsPublic(body: Record<string, unknown>): boolean | undefined {
  if (typeof body.visibility === 'string') {
    if (body.visibility === 'public') return true;
    if (body.visibility === 'private') return false;
  }
  if (typeof body.isPublic === 'boolean') return body.isPublic;
  return undefined;
}

/** Validate + trim a title string. */
function normalizeTitle(value: unknown): string | { error: string } {
  if (typeof value !== 'string') return { error: 'Title is required' };
  const trimmed = value.trim();
  if (trimmed.length === 0) return { error: 'Title is required' };
  if (trimmed.length > MAX_TITLE_LENGTH) return { error: `Title must be ${MAX_TITLE_LENGTH} characters or less` };
  return trimmed;
}

function normalizeDescription(value: unknown): string | { error: string } {
  if (typeof value !== 'string') return { error: 'Description must be a string' };
  const trimmed = value.trim();
  if (trimmed.length > MAX_DESCRIPTION_LENGTH) return { error: `Description must be ${MAX_DESCRIPTION_LENGTH} characters or less` };
  return trimmed;
}

function normalizeIcon(value: unknown): string | { error: string } {
  if (typeof value !== 'string') return { error: 'Icon must be a string' };
  const trimmed = value.trim();
  if (trimmed.length > MAX_ICON_LENGTH) return { error: `Icon must be ${MAX_ICON_LENGTH} characters or less` };
  return trimmed;
}

/** Build the create payload (title + definition required). */
export function buildCustomFeedCreatePayload(
  body: unknown,
  opts: CustomFeedWriteOptions = {},
): BuildResult<CustomFeedCreatePayload> {
  if (!isPlainObject(body)) return { ok: false, error: 'Request body must be an object' };

  const title = normalizeTitle(body.title);
  if (typeof title !== 'string') return { ok: false, error: title.error };

  const validation = validateDefinition(body.definition, { registry: opts.registry });
  if (!validation.valid) return { ok: false, error: validation.error };

  const payload: CustomFeedCreatePayload = {
    title,
    isPublic: resolveIsPublic(body) ?? false,
    definition: validation.definition,
  };

  if (body.description !== undefined && body.description !== null) {
    const description = normalizeDescription(body.description);
    if (typeof description !== 'string') return { ok: false, error: description.error };
    if (description.length > 0) payload.description = description;
  }

  if (body.icon !== undefined && body.icon !== null) {
    const icon = normalizeIcon(body.icon);
    if (typeof icon !== 'string') return { ok: false, error: icon.error };
    if (icon.length > 0) payload.icon = icon;
  }

  return { ok: true, payload };
}

/** Build the update patch (all fields optional; definition validated when present). */
export function buildCustomFeedUpdatePatch(
  body: unknown,
  opts: CustomFeedWriteOptions = {},
): BuildResult<CustomFeedUpdatePatch> {
  if (!isPlainObject(body)) return { ok: false, error: 'Request body must be an object' };

  const patch: CustomFeedUpdatePatch = {};

  if (body.title !== undefined) {
    const title = normalizeTitle(body.title);
    if (typeof title !== 'string') return { ok: false, error: title.error };
    patch.title = title;
  }

  if (body.description !== undefined) {
    if (body.description === null || body.description === '') {
      patch.description = '';
    } else {
      const description = normalizeDescription(body.description);
      if (typeof description !== 'string') return { ok: false, error: description.error };
      patch.description = description;
    }
  }

  const isPublic = resolveIsPublic(body);
  if (isPublic !== undefined) patch.isPublic = isPublic;

  if (body.icon !== undefined) {
    if (body.icon === null || body.icon === '') {
      patch.icon = '';
    } else {
      const icon = normalizeIcon(body.icon);
      if (typeof icon !== 'string') return { ok: false, error: icon.error };
      patch.icon = icon;
    }
  }

  if (body.definition !== undefined) {
    const validation = validateDefinition(body.definition, { registry: opts.registry });
    if (!validation.valid) return { ok: false, error: validation.error };
    patch.definition = validation.definition;
  }

  return { ok: true, payload: patch };
}
