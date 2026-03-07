# MongoDB Sharding Strategy

## Overview
Mention uses MongoDB for its primary data store. This document outlines the sharding strategy for horizontal scaling.

## Collections to Shard

### posts
- **Shard Key:** `{ oxyUserId: "hashed" }`
- **Rationale:** Distributes writes evenly across shards. User-scoped queries (user timeline, profile feeds) target single shards. Existing compound indexes on `(oxyUserId, createdAt)`, `(oxyUserId, visibility, createdAt)`, and the `following_feed_idx` on `(oxyUserId, visibility, parentPostId, repostOf, createdAt)` all lead with `oxyUserId`, so they remain fully targeted under this shard key.
- **Trade-off:** Range queries on `createdAt` alone (e.g., global explore feed) scatter across all shards. This is acceptable because explore feed queries already use the `explore_feed_base_idx` on `(visibility, createdAt)` and the scatter is bounded by the query's time window. Federated posts where `oxyUserId` is null will land on a single shard (hashed null); monitor that shard for hotspot risk if federated post volume grows significantly.
- **Unique index note:** The sparse unique index on `federation.activityId` does not include the shard key prefix. Before sharding, this index must be dropped and recreated as `{ oxyUserId: 1, 'federation.activityId': 1 }` with `{ unique: true, sparse: true }`, or enforced at the application layer instead.

### likes
- **Shard Key:** `{ postId: "hashed" }`
- **Rationale:** Keeps all likes for a given post co-located on one shard. Like-count queries and "did this user like this post" checks both filter by `postId` first (via the `{ userId, postId }` compound unique index), so they remain targeted.
- **Trade-off:** `postId` is a `mongoose.Types.ObjectId`. Hashed sharding on ObjectId works correctly — MongoDB hashes the BSON ObjectId value. Queries that filter only by `userId` (e.g., "all posts this user liked") will scatter across shards; these should be driven from the application by looking up saved post IDs first when possible.

### notifications
- **Shard Key:** `{ recipientId: "hashed" }`
- **Rationale:** All notification queries filter by `recipientId` first. The existing indexes `(recipientId, createdAt)` and `(recipientId, read, createdAt)` are both prefixed by `recipientId`, ensuring every notification read is a targeted, single-shard operation.
- **Trade-off:** The unique index on `(recipientId, actorId, type, entityId)` (used for duplicate prevention) already leads with `recipientId`, which is the shard key, so it requires no schema changes before sharding.

## Collections to Keep Unsharded
Low-volume collections that do not benefit from the overhead of sharding:
- `usersettings`, `customfeeds`, `houses`, `rooms`, `series`, `starterpacks`, `polls`, `trendings`, `reports`, `mutes`, `blocks`, `restricts`, `accountlists`
- `federatedactors`, `federatedfollows`, `federationdeliveryqueues`, `actorkeypairs` — federation volume is expected to remain modest; revisit if inbound federation traffic grows substantially
- `hashtags`, `analytics`, `userbehaviors`, `bookmarks`, `pokes`, `postsubscriptions`, `pushtokens`, `feedlikes`, `feedreviews`, `labelers`, `contentlabels`, `recordings`, `articles`, `lists`

## Enabling Sharding

```javascript
// Enable sharding on the database
sh.enableSharding("mention-production")

// Pre-sharding: fix the federation unique index on posts (must be done before sharding)
// Drop the existing sparse unique index on federation.activityId
db.posts.dropIndex("federation_activity_id_idx")
// Recreate with shard key prefix
db.posts.createIndex(
  { oxyUserId: 1, "federation.activityId": 1 },
  { unique: true, sparse: true, name: "federation_activity_id_idx" }
)

// Shard collections
sh.shardCollection("mention-production.posts", { oxyUserId: "hashed" })
sh.shardCollection("mention-production.likes", { postId: "hashed" })
sh.shardCollection("mention-production.notifications", { recipientId: "hashed" })
```

## Considerations
- Hashed sharding prevents write hotspots but range queries on the shard key scatter across all shards; all high-traffic queries already include the shard key field, keeping scatter limited to expected cases
- All queries should include the shard key for targeted operations; review any query that does not filter by `oxyUserId` / `postId` / `recipientId` respectively
- Unique indexes must include the shard key as a prefix — the notifications duplicate-prevention index already satisfies this, but the posts `federation.activityId` index requires the migration step above
- Read preference `secondaryPreferred` (already configured via `readPreference: 'secondaryPreferred'`) distributes reads across replica set members within each shard
- The `metadata.likedBy` and `metadata.savedBy` arrays embedded in `posts` grow unboundedly with engagement; consider a read-time population strategy rather than storing large arrays in the document if post documents approach the 16 MB BSON limit under sharding
- Migration: Use zone-aware (tag-aware) sharding for a zero-downtime rollout — assign all existing chunk ranges to a single zone backed by existing infrastructure, then add new shards to new zones and rebalance gradually

## Prerequisites
- MongoDB 5.0+ with replica sets configured on each shard
- Minimum 2 shards recommended for initial deployment (3 for production redundancy)
- Config server replica set (3-member CSRS)
- `mongos` router instances deployed behind a load balancer; application connection strings point to `mongos`, not individual `mongod` nodes
- Complete the `federation.activityId` index migration on `posts` before running `sh.shardCollection` on that collection
