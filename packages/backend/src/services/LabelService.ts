/**
 * Labelers, the labels they apply, and a viewer's subscriptions to them.
 *
 * ## The wire format is the contract, not the storage shape
 *
 * Mongo stored `labelDefinitions` as an embedded array on the labeler and the
 * viewer's subscriptions as a raw id array on `UserSettings`. Postgres holds the
 * definitions in `labeler_label_definitions` (so `(labeler, slug)` — the way
 * every call site addresses one — is a real unique constraint rather than a
 * hope) and keeps the subscription list as a `text[]` read whole.
 *
 * Neither change may reach a client. `serializeLabeler` re-assembles the
 * embedded array and still emits `_id`, because the frontend reads
 * `String(l._id || l.id)` and the fediverse-facing rule is that a port changes
 * no response body. An absent optional is OMITTED rather than sent as `null` —
 * Mongoose's `undefined` disappeared from the JSON, and drizzle's `null` would
 * not.
 */

import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { getDb, type DatabaseOrTransaction } from '../db/postgres';
import {
  contentLabels,
  labelerLabelDefinitions,
  labelers,
  type LABEL_ACTIONS,
  type LABEL_SEVERITIES,
} from '../db/schema/moderation';
import { userSettings, userSettingsLabelActions } from '../db/schema/userProfile';
import { logger } from '../utils/logger';

export type LabelSeverity = (typeof LABEL_SEVERITIES)[number];
export type LabelDefaultAction = (typeof LABEL_ACTIONS)[number];

export interface LabelDefinition {
  slug: string;
  name: string;
  description?: string;
  severity: LabelSeverity;
  defaultAction: LabelDefaultAction;
}

/** A labeler exactly as it goes on the wire. */
export interface SerializedLabeler {
  _id: string;
  id: string;
  name: string;
  description?: string;
  creatorId: string;
  isOfficial: boolean;
  labelDefinitions: LabelDefinition[];
  subscriberCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** A content label exactly as it goes on the wire. */
export interface SerializedContentLabel {
  _id: string;
  id: string;
  /** Populated with the labeler's name, matching Mongoose's `.populate()`. */
  labelerId: { _id: string; id: string; name: string };
  targetType: 'post' | 'user';
  targetId: string;
  labelSlug: string;
  createdBy: string;
  reason?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLabelerData {
  name: string;
  description?: string;
  creatorId: string;
  isOfficial?: boolean;
  labelDefinitions?: LabelDefinition[];
}

export interface ApplyLabelData {
  labelerId: string;
  targetType: 'post' | 'user';
  targetId: string;
  labelSlug: string;
  createdBy: string;
  reason?: string;
}

export interface LabelActionPreference {
  labelerId: string;
  labelSlug: string;
  action: LabelDefaultAction;
}

/** Search results are bounded; a labeler directory is not a paginated surface. */
const LABELER_LIST_LIMIT = 200;

/**
 * Escape the characters `LIKE` treats as wildcards.
 *
 * The Mongo version built `new RegExp(escapeRegex(term), 'i')`, which is an
 * UNANCHORED substring match — hence the surrounding `%`. Escaping the regex
 * metacharacters here instead of the LIKE ones would leave `%` and `_` live and
 * turn a user's search string into a wildcard.
 */
function likeContains(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Drop a key entirely when the column held NULL, matching Mongoose's `undefined`. */
function optional<T>(value: T | null): { present: false } | { present: true; value: T } {
  return value === null ? { present: false } : { present: true, value };
}

function serializeLabeler(
  row: typeof labelers.$inferSelect,
  definitions: LabelDefinition[],
): SerializedLabeler {
  const description = optional(row.description);
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    ...(description.present ? { description: description.value } : {}),
    creatorId: row.creatorId,
    isOfficial: row.isOfficial,
    labelDefinitions: definitions,
    subscriberCount: row.subscriberCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function serializeDefinition(
  row: typeof labelerLabelDefinitions.$inferSelect,
): LabelDefinition {
  const description = optional(row.description);
  return {
    slug: row.slug,
    name: row.name,
    ...(description.present ? { description: description.value } : {}),
    severity: row.severity,
    defaultAction: row.defaultAction,
  };
}

/** Definitions for a set of labelers, in declared order, grouped by labeler. */
async function loadDefinitions(
  db: DatabaseOrTransaction,
  labelerIds: string[],
): Promise<Map<string, LabelDefinition[]>> {
  const grouped = new Map<string, LabelDefinition[]>();
  if (labelerIds.length === 0) return grouped;

  // `inArray`, never a hand-built `= any(${ids})`: a raw JS array interpolated
  // into `sql` binds as a ROW constructor, so `= any(...)` and `<> all(...)`
  // are both wrong — and wrong at runtime only.
  const rows = await db
    .select()
    .from(labelerLabelDefinitions)
    .where(inArray(labelerLabelDefinitions.labelerId, labelerIds))
    .orderBy(asc(labelerLabelDefinitions.position));

  for (const row of rows) {
    const bucket = grouped.get(row.labelerId);
    if (bucket) bucket.push(serializeDefinition(row));
    else grouped.set(row.labelerId, [serializeDefinition(row)]);
  }
  return grouped;
}

export class LabelService {
  /**
   * Create a labeler and its label definitions.
   *
   * One transaction: a labeler whose definitions failed to insert would accept
   * no labels at all (`applyLabel` validates the slug against them) while
   * looking perfectly healthy in a list.
   */
  static async createLabeler(data: CreateLabelerData): Promise<SerializedLabeler> {
    const definitions = data.labelDefinitions ?? [];

    const labeler = await getDb().transaction(async (tx) => {
      const [row] = await tx
        .insert(labelers)
        .values({
          name: data.name,
          description: data.description ?? null,
          creatorId: data.creatorId,
          isOfficial: data.isOfficial ?? false,
        })
        .returning();

      if (definitions.length > 0) {
        await tx.insert(labelerLabelDefinitions).values(
          definitions.map((definition, position) => ({
            labelerId: row.id,
            slug: definition.slug,
            name: definition.name,
            description: definition.description ?? null,
            severity: definition.severity,
            defaultAction: definition.defaultAction,
            // Explicit, because the embedded Mongo array was ordered and the
            // client renders them in that order.
            position,
          })),
        );
      }
      return row;
    });

    logger.info('[LabelService] Created labeler', {
      labelerId: labeler.id,
      creatorId: data.creatorId,
    });
    return serializeLabeler(labeler, definitions);
  }

  /** List labelers with optional search on name/description. */
  static async getLabelers(filters?: { search?: string }): Promise<SerializedLabeler[]> {
    const search = filters?.search?.trim();
    const rows = await getDb()
      .select()
      .from(labelers)
      .where(
        search
          ? or(
              ilike(labelers.name, likeContains(search)),
              ilike(labelers.description, likeContains(search)),
            )
          : undefined,
      )
      .orderBy(desc(labelers.subscriberCount), desc(labelers.createdAt))
      .limit(LABELER_LIST_LIMIT);

    const definitions = await loadDefinitions(
      getDb(),
      rows.map((row) => row.id),
    );
    return rows.map((row) => serializeLabeler(row, definitions.get(row.id) ?? []));
  }

  /**
   * One labeler, or `null`.
   *
   * No id-shape guard: the Mongoose version returned `null` for anything that
   * was not 24-char hex, which after the cutover would have hidden every labeler
   * created since. A `text` id that names no row already answers `null`.
   */
  static async getLabelerById(id: string): Promise<SerializedLabeler | null> {
    const [row] = await getDb().select().from(labelers).where(eq(labelers.id, id)).limit(1);
    if (!row) return null;
    const definitions = await loadDefinitions(getDb(), [row.id]);
    return serializeLabeler(row, definitions.get(row.id) ?? []);
  }

  /**
   * Subscribe a viewer to a labeler.
   *
   * The array append and the counter move together in one transaction, and the
   * append itself is conditional on the id being absent — so a double-click
   * increments `subscriberCount` exactly once, the same guarantee Mongo got from
   * `$addToSet` plus `modifiedCount`.
   */
  static async subscribeToLabeler(userId: string, labelerId: string): Promise<void> {
    await getDb().transaction(async (tx) => {
      const [labeler] = await tx
        .select({ id: labelers.id })
        .from(labelers)
        .where(eq(labelers.id, labelerId))
        .limit(1);
      if (!labeler) throw new Error('Labeler not found');

      const changed = await tx
        .insert(userSettings)
        .values({ oxyUserId: userId, privacySubscribedLabelers: [labelerId] })
        .onConflictDoUpdate({
          target: userSettings.oxyUserId,
          set: {
            privacySubscribedLabelers: sql`array_append(coalesce(${userSettings.privacySubscribedLabelers}, '{}'), ${labelerId})`,
            updatedAt: new Date(),
          },
          // Qualified: `user_settings` IS the target of this statement, so an
          // unqualified column here would still resolve — but naming the table
          // keeps it correct if this predicate ever moves into a subquery.
          setWhere: sql`not (${labelerId} = any(coalesce(${userSettings.privacySubscribedLabelers}, '{}')))`,
        })
        .returning({ id: userSettings.id });

      if (changed.length === 0) return;

      await tx
        .update(labelers)
        .set({ subscriberCount: sql`${labelers.subscriberCount} + 1` })
        .where(eq(labelers.id, labelerId));
      logger.info('[LabelService] User subscribed to labeler', { userId, labelerId });
    });
  }

  /** Unsubscribe a viewer from a labeler. */
  static async unsubscribeFromLabeler(userId: string, labelerId: string): Promise<void> {
    await getDb().transaction(async (tx) => {
      const removed = await tx
        .update(userSettings)
        .set({
          privacySubscribedLabelers: sql`array_remove(${userSettings.privacySubscribedLabelers}, ${labelerId})`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(userSettings.oxyUserId, userId),
            sql`${labelerId} = any(coalesce(${userSettings.privacySubscribedLabelers}, '{}'))`,
          ),
        )
        .returning({ id: userSettings.id });

      if (removed.length === 0) {
        logger.info('[LabelService] User was not subscribed to labeler', { userId, labelerId });
        return;
      }

      /**
       * `greatest(… - 1, 0)`, not a bare decrement. `labelers_subscriber_count_check`
       * forbids a negative count, so a legacy row whose counter had already drifted
       * below its real subscriber set would turn an unsubscribe into a 500. Mongo
       * would have gone to -1 silently; neither is right, and clamping is the one
       * that still removes the subscription.
       */
      await tx
        .update(labelers)
        .set({ subscriberCount: sql`greatest(${labelers.subscriberCount} - 1, 0)` })
        .where(eq(labelers.id, labelerId));
      logger.info('[LabelService] User unsubscribed from labeler', { userId, labelerId });
    });
  }

  /** Apply a label to a piece of content — validates the slug against the labeler. */
  static async applyLabel(data: ApplyLabelData): Promise<SerializedContentLabel> {
    const db = getDb();
    const [labeler] = await db
      .select()
      .from(labelers)
      .where(eq(labelers.id, data.labelerId))
      .limit(1);
    if (!labeler) throw new Error('Labeler not found');

    const [definition] = await db
      .select({ slug: labelerLabelDefinitions.slug })
      .from(labelerLabelDefinitions)
      .where(
        and(
          eq(labelerLabelDefinitions.labelerId, data.labelerId),
          eq(labelerLabelDefinitions.slug, data.labelSlug),
        ),
      )
      .limit(1);
    if (!definition) {
      throw new Error(`Label slug '${data.labelSlug}' does not exist in this labeler`);
    }

    const [label] = await db
      .insert(contentLabels)
      .values({
        labelerId: data.labelerId,
        targetType: data.targetType,
        targetId: data.targetId,
        labelSlug: data.labelSlug,
        createdBy: data.createdBy,
        reason: data.reason ?? null,
      })
      .returning();

    logger.info('[LabelService] Applied label', {
      labelId: label.id,
      labelerId: data.labelerId,
      targetType: data.targetType,
      targetId: data.targetId,
      labelSlug: data.labelSlug,
    });

    return serializeContentLabel(label, labeler.name);
  }

  /**
   * Remove a content label — only the original creator may remove it.
   *
   * The ownership check is inside the DELETE's own predicate rather than a read
   * followed by a write: the read-then-delete shape lets a concurrent removal
   * turn "not authorised" into a successful delete of a row that no longer
   * belongs to whoever was checked.
   */
  static async removeLabel(id: string, userId: string): Promise<boolean> {
    const db = getDb();
    const deleted = await db
      .delete(contentLabels)
      .where(and(eq(contentLabels.id, id), eq(contentLabels.createdBy, userId)))
      .returning({ id: contentLabels.id });

    if (deleted.length > 0) {
      logger.info('[LabelService] Removed label', { labelId: id, userId });
      return true;
    }

    // Nothing was deleted: say WHICH, so the route can answer 404 or 403.
    const [existing] = await db
      .select({ id: contentLabels.id })
      .from(contentLabels)
      .where(eq(contentLabels.id, id))
      .limit(1);
    throw new Error(existing ? 'Not authorised to remove this label' : 'Label not found');
  }

  /** Every label applied to one piece of content, with its labeler's name. */
  static async getLabelsForContent(
    targetType: 'post' | 'user',
    targetId: string,
  ): Promise<SerializedContentLabel[]> {
    const rows = await getDb()
      .select({ label: contentLabels, labelerName: labelers.name })
      .from(contentLabels)
      .innerJoin(labelers, eq(labelers.id, contentLabels.labelerId))
      .where(
        and(eq(contentLabels.targetType, targetType), eq(contentLabels.targetId, targetId)),
      );

    return rows.map((row) => serializeContentLabel(row.label, row.labelerName));
  }

  /**
   * The labeler ids this viewer subscribes to, unfiltered.
   *
   * Returned raw rather than resolved: the list endpoints only need it to set an
   * `isSubscribed` flag on labelers they already loaded, and filtering the ids by
   * shape here is exactly the bug that used to hide post-cutover labelers from
   * `getUserEffectiveLabels`.
   */
  static async getSubscribedLabelerIds(userId: string): Promise<string[]> {
    const [settings] = await getDb()
      .select({ subscribedLabelers: userSettings.privacySubscribedLabelers })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, userId))
      .limit(1);
    return settings?.subscribedLabelers ?? [];
  }

  /**
   * The viewer's subscribed labelers and their per-label action overrides.
   *
   * No id filter on the subscription list. The Mongoose version ran the array
   * through `ObjectId.isValid` before the lookup, so a labeler created after the
   * cutover — a uuid v7 — silently vanished from the viewer's effective label
   * set and their hide/warn/blur choices stopped applying to it, with nothing
   * logged. An id that names no labeler simply returns no row, which is what
   * the caller has to handle anyway (a labeler can be deleted).
   */
  static async getUserEffectiveLabels(userId: string): Promise<{
    labelers: SerializedLabeler[];
    labelActions: LabelActionPreference[];
  }> {
    const db = getDb();
    const [settings] = await db
      .select({
        id: userSettings.id,
        subscribedLabelers: userSettings.privacySubscribedLabelers,
      })
      .from(userSettings)
      .where(eq(userSettings.oxyUserId, userId))
      .limit(1);

    if (!settings) return { labelers: [], labelActions: [] };

    const labelActions = await db
      .select({
        labelerId: userSettingsLabelActions.labelerId,
        labelSlug: userSettingsLabelActions.labelSlug,
        action: userSettingsLabelActions.action,
      })
      .from(userSettingsLabelActions)
      .where(eq(userSettingsLabelActions.settingsId, settings.id));

    const subscribedIds = settings.subscribedLabelers ?? [];
    if (subscribedIds.length === 0) return { labelers: [], labelActions };

    const rows = await db
      .select()
      .from(labelers)
      .where(inArray(labelers.id, subscribedIds));
    const definitions = await loadDefinitions(
      db,
      rows.map((row) => row.id),
    );

    return {
      labelers: rows.map((row) => serializeLabeler(row, definitions.get(row.id) ?? [])),
      labelActions,
    };
  }

  /**
   * Replace the viewer's action overrides for the labelers named in `incoming`,
   * leaving every other labeler's overrides untouched.
   *
   * Mongo did this by reading the whole array, merging in memory and writing it
   * back — a lost update whenever two tabs saved at once. As rows, the merge is
   * a scoped delete plus an insert inside one transaction, so concurrent saves
   * for DIFFERENT labelers can no longer clobber each other.
   */
  static async setLabelActions(
    userId: string,
    incoming: LabelActionPreference[],
  ): Promise<void> {
    await getDb().transaction(async (tx) => {
      const [settings] = await tx
        .insert(userSettings)
        .values({ oxyUserId: userId })
        .onConflictDoUpdate({
          target: userSettings.oxyUserId,
          set: { updatedAt: new Date() },
        })
        .returning({ id: userSettings.id });

      const touchedLabelerIds = [...new Set(incoming.map((action) => action.labelerId))];
      if (touchedLabelerIds.length > 0) {
        await tx
          .delete(userSettingsLabelActions)
          .where(
            and(
              eq(userSettingsLabelActions.settingsId, settings.id),
              inArray(userSettingsLabelActions.labelerId, touchedLabelerIds),
            ),
          );
      }

      if (incoming.length === 0) return;

      /**
       * The unique key is `(settings, labeler, slug)`, and one request can name
       * the same slug twice; last one wins, matching the array merge this
       * replaced.
       */
      const deduped = new Map<string, LabelActionPreference>();
      for (const action of incoming) {
        deduped.set(`${action.labelerId} ${action.labelSlug}`, action);
      }

      await tx.insert(userSettingsLabelActions).values(
        [...deduped.values()].map((action) => ({
          settingsId: settings.id,
          labelerId: action.labelerId,
          labelSlug: action.labelSlug,
          action: action.action,
        })),
      );
    });
  }
}

function serializeContentLabel(
  row: typeof contentLabels.$inferSelect,
  labelerName: string,
): SerializedContentLabel {
  const reason = optional(row.reason);
  return {
    _id: row.id,
    id: row.id,
    labelerId: { _id: row.labelerId, id: row.labelerId, name: labelerName },
    targetType: row.targetType,
    targetId: row.targetId,
    labelSlug: row.labelSlug,
    createdBy: row.createdBy,
    ...(reason.present ? { reason: reason.value } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export default LabelService;
