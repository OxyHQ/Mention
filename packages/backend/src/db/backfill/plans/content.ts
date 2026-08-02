/**
 * The two singleton collections: `articles` and `post_recent_repliers`.
 *
 * They share a file because they share the only interesting property either has
 * — both hang off a post by a foreign key Mongo did not have — and differ in the
 * one way that matters to a plan: `articles` is one row per document, while
 * `post_recent_repliers` is a FLATTENING. Mongo holds one document per post with
 * a `repliers[]` array; Postgres holds one row per replier in the SAME table,
 * not a child table. The verifier counts what the transform emits rather than
 * assuming one row per document, so N-per-document needs no declaration — but it
 * does mean a row-count comparison between the two stores is meaningless for
 * this collection, and that is why the count the verifier trusts is the emitted
 * one.
 *
 * ## What goes wrong if these are wrong and no audit catches it
 *
 * **`articles`:** the body of a long-form post. A dropped or truncated `body`
 * loses writing a user cannot reproduce, and it fails SILENTLY at read time —
 * the post still renders, with its title and an empty body, because the article
 * is fetched separately from the post that names it. Nothing 500s. That is the
 * worst case here and it is why `body` is copied verbatim with no normalization
 * of any kind: there is no "harmless" transformation of someone's article.
 *
 * **`post_recent_repliers`:** a read-model projection ("who replied recently",
 * shown as faces on a post). Wrong content here is cosmetic and self-healing —
 * `PostRecentReplierService` rewrites it on the next reply, and
 * `EngagementProjectionReconciliationService` repairs it wholesale. So the worst
 * case is NOT wrong data; it is a `23505` aborting the run partway, because
 * Postgres adds `unique(post_id, oxy_user_id)` where Mongo had a plain array
 * that could list one user twice. The dedupe below exists for that, and the
 * asymmetry is the point: for `articles` the data matters and the constraint is
 * loose, and here it is the other way round.
 *
 * ## A duplicate WITHIN one array is not auditable, and is normalized instead
 *
 * `UniquenessAudit` `$group`s over DOCUMENTS — one group per document key — so
 * it can find two documents claiming one `postId` and cannot see one document
 * whose `repliers[]` names the same user twice. That is the same shape of hole
 * `plans/gates.ts` documents for its cross-column CHECK: a constraint this
 * framework has no kind for.
 *
 * Unlike the gates case there is a HARMLESS normalization available, so this
 * one does not throw. The array is a recency projection, so two entries for one
 * user mean the projection recorded them twice and the newest `repliedAt` is
 * what the live service would hold — keeping it and dropping the older loses
 * nothing a reader could observe. Aborting a whole run over a benign artefact
 * of a self-healing cache would be the worse trade.
 *
 * Count the instances before a run with:
 *   db.post_recent_repliers.aggregate([
 *     {$project: {n: {$size: '$repliers'},
 *                 u: {$size: {$setUnion: '$repliers.oxyUserId'}}}},
 *     {$match: {$expr: {$ne: ['$n', '$u']}}}, {$count: 'documents'}])
 */

import { articles } from '../../schema/articles';
import { postRecentRepliers } from '../../schema/postContent';
import type { CollectionPlan } from '../plan';
import { buildRow } from '../rowBuilder';
import { childRowId, id, ownId, reqDate, reqId, reqStr, str, subdocuments } from '../values';
import { timestamps } from './timestamps';

/** `articles` → `articles`. */
const articlesPlan: CollectionPlan = {
  collection: 'articles',
  table: articles,
  transform: (doc, emit) => {
    // NOT named `id`: that shadows the `id` VALUE helper imported above, and the
    // shadow is silent — `id(doc, 'postId')` then calls a string and fails with
    // "Type 'String' has no call signatures" only because TypeScript catches it.
    const articleId = ownId(doc);
    emit(
      articles,
      buildRow(
        articles,
        {
          id: articleId,
          // NULLABLE, and a real foreign key where Mongo had a bare indexed
          // string. The Mongoose field is not `required` because a draft article
          // can exist before its post, so NULL is a legitimate state rather than
          // a defect — but a NON-null value naming a post that no longer exists
          // is one, and the referential audit reports those by id. It is
          // deliberately not resolved here: whether a dangling article is
          // dropped or detached is a decision about real data nobody has looked
          // at yet.
          // `id` rather than `str`, and the difference is a `23503`: this is a
          // real foreign key, and Mongo's field is a bare indexed String that
          // can hold an EMPTY one. `str` would pass `''` through to the
          // constraint, which references no post and fails the insert partway
          // through a run; `id` treats an empty string as absent, which is what
          // it means. It also accepts a stored ObjectId, which `str` refuses.
          postId: id(doc, 'postId'),
          createdBy: reqStr(doc, 'createdBy'),
          // Copied verbatim. `title` is `maxlength: 280` in Mongoose and the
          // column is unbounded `text`, so nothing can be refused on length; and
          // `body` is the user's writing, where the only safe transformation is
          // none. Mongoose's `trim: true` ran on WRITE, so stored values are
          // already trimmed — re-trimming here would be this migration editing
          // prose on the way past.
          title: str(doc, 'title'),
          body: str(doc, 'body'),
          ...timestamps(doc),
        },
        articleId
      )
    );
  },
};

/** `post_recent_repliers` → `post_recent_repliers`, one row per replier. */
const postRecentRepliersPlan: CollectionPlan = {
  collection: 'post_recent_repliers',
  table: postRecentRepliers,
  uniquenessAudits: [
    // Two DOCUMENTS claiming one post. Mongo already declares this unique
    // (`post_recent_repliers_post_id_unique`), so a finding here means the index
    // is missing or was built non-unique in production — worth knowing before a
    // run rather than as a `23505` partway through it.
    { index: 'post_recent_repliers_post_id_oxy_user_id_key', key: [{ path: 'postId', normalize: 'exact' }] },
  ],
  transform: (doc, emit) => {
    const parentId = ownId(doc);
    // `reqId`, not `reqStr`: the model declares `String`, but the value is a
    // stringified `posts._id` and a legacy document that stored the ObjectId
    // itself would make `reqStr` throw on data the target holds perfectly well.
    // `reqId` accepts either shape and preserves both verbatim.
    const postId = reqId(doc, 'postId');

    // Last entry per user wins. `subdocuments` yields array order, and the array
    // is append-ordered by the projection service, so a later position is the
    // more recent record — but position is not trusted for the VALUE: the kept
    // entry is chosen by comparing the stored `repliedAt`, so an array that was
    // rewritten out of order still yields the newest reply time.
    const newestByUser = new Map<string, { entry: Record<string, unknown>; position: number; repliedAt: Date }>();
    for (const [entry, position] of subdocuments(doc, 'repliers')) {
      const oxyUserId = reqStr(entry, 'oxyUserId');
      // NOT NULL with no default, so an absent value cannot fall through to a
      // database default the way a timestamp column would — `reqDate` throws and
      // the runner names the document. That is the intended loudness: a replier
      // with no reply time has nothing to order the projection by.
      const repliedAt = reqDate(entry, 'repliedAt');
      const existing = newestByUser.get(oxyUserId);
      if (existing === undefined || repliedAt > existing.repliedAt) {
        newestByUser.set(oxyUserId, { entry, position, repliedAt });
      }
    }

    for (const [oxyUserId, { entry, position, repliedAt }] of newestByUser) {
      emit(
        postRecentRepliers,
        buildRow(
          postRecentRepliers,
          {
            // Derived, because the subschema sets `_id: false` and these rows
            // therefore have no id of their own to preserve. It is a pure
            // function of the source, so a re-run conflicts with the row it
            // already wrote — though what actually makes an interrupted copy
            // converge is `post_recent_repliers_post_id_oxy_user_id_key`, the
            // NATURAL key, which `ON CONFLICT DO NOTHING` hits first.
            id: childRowId(entry, parentId, 'repliers', position),
            postId,
            oxyUserId,
            repliedAt,
            // From the PARENT document: the entries carry no timestamps of their
            // own (`_id: false`, two fields), so the projection's own
            // created/updated stamps are the only ones that exist.
            ...timestamps(doc),
          },
          parentId
        )
      );
    }
  },
};

/** Every singleton content plan. */
export const CONTENT_PLANS: readonly CollectionPlan[] = [articlesPlan, postRecentRepliersPlan];
