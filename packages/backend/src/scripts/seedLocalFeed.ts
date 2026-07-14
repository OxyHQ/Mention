/**
 * Seed the LOCAL Mention home feed with hundreds of variable-height text posts.
 *
 * Purpose: give the running local backend a large, visually varied feed so the
 * web feed virtualization (document-scroll, bounded DOM, `measureElement`) can be
 * verified against HUNDREDS of variable-height rows.
 *
 * What it writes (idempotent — every seeded doc carries `seedTag` and prior seed
 * docs are removed on rerun):
 *   - ~30 Oxy-shaped user docs into `oxy-dev` (the DB the local Oxy API reads),
 *     so author hydration can resolve real `name.displayName` IF the running
 *     backend's `OXY_API_URL` points at a real Oxy API. When it does not, the
 *     Mention backend's `PostHydrationService` falls back to a placeholder author
 *     and the post is still returned — so the feed is populated either way.
 *   - 400 root posts into the running backend's DB (`mention-development` by
 *     default — see the dbName note below) with widely varying text lengths
 *     (one-liner → multi-paragraph), `createdAt` spread over 30 days,
 *     `visibility: 'public'`, `status: 'published'`, `type: 'text'`, no `boostOf`,
 *     `parentPostId: null` — so they are selected by BOTH the anonymous `for_you`
 *     (fetchPopular) and `explore` MTN feed queries.
 *
 * The DB URIs default to the same local DBs the running services use and can be
 * overridden via env (`MENTION_DB_URI`, `OXY_DB_URI`) without code edits.
 *
 * Usage:
 *   cd packages/backend && bun src/scripts/seedLocalFeed.ts
 */

import mongoose from 'mongoose';

/**
 * The Mention backend connects with `mongoose.connect(uri, { dbName })` where
 * `dbName = mention-${NODE_ENV || 'development'}` (see `src/utils/database.ts`).
 * That `dbName` OVERRIDES whatever database name is in the URI path, so the
 * running dev backend actually reads/writes `mention-development` even though its
 * `.env` URI ends in `/mention-dev`. The seed MUST target the same resolved
 * database name, so we mirror that logic exactly instead of trusting the URI
 * path. Override-able via `MENTION_DB_NAME` for non-default environments.
 */
const MENTION_DB_NAME = process.env.MENTION_DB_NAME
  || `mention-${process.env.NODE_ENV || 'development'}`;

/** Host portion of the connection (no db in path — we set the db via dbName). */
const MONGO_HOST_URI = process.env.MENTION_MONGO_HOST
  || 'mongodb://localhost:27017';
const OXY_DB_URI = process.env.OXY_DB_URI
  || 'mongodb://localhost:27017/oxy-dev';

/** Marker stamped on every seeded document so reruns are idempotent. */
const SEED_TAG = 'local-feed-seed';

/** How many root posts to create. The whole point is a long, varied feed. */
const POST_COUNT = 400;

/** Spread post `createdAt` across this many days for a realistic timeline. */
const TIMELINE_DAYS = 30;

interface SeedUser {
  username: string;
  first: string;
  last: string;
  color: string;
  bio: string;
}

const SEED_USERS: SeedUser[] = [
  { username: 'sarahchen_dev', first: 'Sarah', last: 'Chen', color: 'blue', bio: 'Product designer. Coffee enthusiast.' },
  { username: 'marcusj_eng', first: 'Marcus', last: 'Johnson', color: 'green', bio: 'Full-stack dev. Building cool stuff.' },
  { username: 'emiliarossi_ux', first: 'Emilia', last: 'Rossi', color: 'purple', bio: 'UX researcher at a startup nobody has heard of yet.' },
  { username: 'jameskim_em', first: 'James', last: 'Kim', color: 'red', bio: 'Engineering manager. Opinions are my own.' },
  { username: 'priya_mobile', first: 'Priya', last: 'Sharma', color: 'orange', bio: 'Mobile dev. React Native lover.' },
  { username: 'alexwright_indie', first: 'Alex', last: 'Wright', color: 'blue', bio: 'Indie hacker. Shipping fast.' },
  { username: 'linawang_data', first: 'Lina', last: 'Wang', color: 'green', bio: 'Data scientist by day, photographer by night.' },
  { username: 'tomharris_be', first: 'Tom', last: 'Harris', color: 'purple', bio: 'Backend engineer. Distributed systems nerd.' },
  { username: 'sofiamorales_ds', first: 'Sofia', last: 'Morales', color: 'red', bio: 'Design systems. Typography. Accessibility.' },
  { username: 'danielpark_fe', first: 'Daniel', last: 'Park', color: 'orange', bio: 'Founding engineer. Previously at Big Tech.' },
  { username: 'rachelgreen_dr', first: 'Rachel', last: 'Green', color: 'blue', bio: 'DevRel. Conference speaker. Dog mom.' },
  { username: 'omarfaruq_oss', first: 'Omar', last: 'Faruq', color: 'green', bio: 'Open source contributor. Rust enthusiast.' },
  { username: 'nataliebrooks_pm', first: 'Natalie', last: 'Brooks', color: 'purple', bio: 'Product manager. Writing about tech and life.' },
  { username: 'ryanmiller_ios', first: 'Ryan', last: 'Miller', color: 'red', bio: 'iOS developer. SwiftUI convert.' },
  { username: 'aikotanaka_css', first: 'Aiko', last: 'Tanaka', color: 'orange', bio: 'Frontend engineer. CSS wizard.' },
  { username: 'leonardo_arch', first: 'Leonardo', last: 'Bianchi', color: 'blue', bio: 'Software architect. Diagrams over meetings.' },
  { username: 'fatima_sec', first: 'Fatima', last: 'Al-Sayed', color: 'green', bio: 'Security engineer. Threat modeling addict.' },
  { username: 'noah_devops', first: 'Noah', last: 'Andersen', color: 'purple', bio: 'Platform / DevOps. YAML whisperer.' },
  { username: 'meiling_ml', first: 'Mei', last: 'Ling', color: 'red', bio: 'ML engineer. Embeddings everywhere.' },
  { username: 'gabriel_game', first: 'Gabriel', last: 'Santos', color: 'orange', bio: 'Game dev. Shaders are poetry.' },
  { username: 'hannah_qa', first: 'Hannah', last: 'Walker', color: 'blue', bio: 'QA lead. If it can break, I will break it.' },
  { username: 'yusuf_db', first: 'Yusuf', last: 'Demir', color: 'green', bio: 'Database engineer. Indexes are my love language.' },
  { username: 'clara_a11y', first: 'Clara', last: 'Novak', color: 'purple', bio: 'Accessibility specialist. The web is for everyone.' },
  { username: 'isaac_cloud', first: 'Isaac', last: 'Mwangi', color: 'red', bio: 'Cloud architect. Multi-region or bust.' },
  { username: 'valentina_pm', first: 'Valentina', last: 'Lopez', color: 'orange', bio: 'Technical PM. Roadmaps and trade-offs.' },
  { username: 'kenji_perf', first: 'Kenji', last: 'Sato', color: 'blue', bio: 'Performance engineer. Every millisecond counts.' },
  { username: 'amara_design', first: 'Amara', last: 'Okafor', color: 'green', bio: 'Brand + product designer. Pixels with purpose.' },
  { username: 'lucas_web', first: 'Lucas', last: 'Moreau', color: 'purple', bio: 'Web platform tinkerer. Standards nerd.' },
  { username: 'sofie_growth', first: 'Sofie', last: 'Larsen', color: 'red', bio: 'Growth engineer. Experiments all the way down.' },
  { username: 'arjun_infra', first: 'Arjun', last: 'Mehta', color: 'orange', bio: 'Infra engineer. Pager-duty survivor.' },
];

/**
 * A spread of text bodies of WILDLY varying length so the rendered rows have
 * genuinely variable heights. Ordered loosely short → long; the seeder picks
 * across the whole range so the feed mixes one-liners with multi-paragraph
 * posts (the entire reason this seed exists: validating variable-height
 * virtualization).
 */
const TEXT_BODIES: string[] = [
  'gm',
  'Ship it.',
  'tabs > spaces',
  'Deleted 3000 lines today. Best day this quarter.',
  'The fastest code is code that never runs.',
  'Just spent 3 hours debugging only to find a missing comma.',
  'Documentation is a love letter to your future self.',
  'My terminal has more tabs open than my browser, and honestly that tracks.',
  'Controversial opinion: most microservices should have just stayed functions in a single well-factored module.',
  'Pair programming is just socially acceptable backseat driving, and I mean that as the highest compliment.',
  'Code that works on the first try is the most suspicious code you will ever write. Trust nothing. Verify everything. Then verify it again because past-you was an optimist.',
  'Today I learned that the feature I spent an entire week building already existed in the standard library. The function name was right there. I just never read the docs. Humbling.',
  'A short thread on why your retros keep failing:\n\n1. Nobody writes anything down.\n2. The same three action items roll over every sprint.\n3. There is zero follow-through because no one owns the outcome.\n\nFix the ownership problem and the rest mostly solves itself.',
  'I have been thinking a lot about technical debt lately. Everyone treats it like a moral failing, but most of it is just decisions that were correct at the time and stopped being correct as the system grew. The trick is not avoiding debt entirely — that is impossible and would slow you to a crawl — it is being honest about where it lives, paying it down deliberately, and never pretending the interest is zero.',
  'The single most underrated engineering skill is writing a clear bug report. Not a fix. Not a clever workaround. Just a precise, reproducible description of what is broken, what you expected, and what actually happened. Half the time, writing it down well is what reveals the actual cause. The other half, it saves the next person hours. Either way you win.',
  'Long post incoming, grab a coffee.\n\nWe spent six months rewriting our core service from scratch. Here is what nobody tells you about big rewrites.\n\nFirst: the old system, the one everyone hated, encoded years of hard-won knowledge about edge cases you forgot existed. Every weird conditional was a scar from a real production incident. The rewrite, clean and beautiful, knew none of this. So week three of the new system in production felt exactly like week three of the old system five years ago. Same bugs. Same surprises. Different stack.\n\nSecond: "we will migrate incrementally" is a promise teams make and almost never keep. The strangler-fig pattern works on slides. In practice the last 10% of the old system is load-bearing in ways the org has completely forgotten, and it sits there, half-migrated, for another year.\n\nThird: the rewrite was still worth it. Not because the new code is prettier, but because the act of rewriting forced us to actually understand the domain again. The documentation we wrote along the way is now more valuable than the code itself.\n\nWould I do it again? Probably. Would I tell you it will be faster and cleaner and done by Q3? Absolutely not.',
  'Hot take: the best architecture decision is usually "not yet". Premature abstraction has killed more codebases than duplication ever will.',
  'Rubber duck debugging works because the duck never interrupts you to suggest its own pet refactor.',
  'My commit messages have become increasingly existential. Today\'s was just "why".',
  'Release on a Friday? In THIS economy? Absolutely not. The on-call rotation has feelings too.',
  'The difference between a junior and a senior developer is mostly how calmly they read a stack trace.',
  'Just discovered a bug that has been quietly living in production for six months. Nobody noticed. The bug, the feature, and the metric were all wrong in perfectly compensating ways. Beautiful, in a horrifying sort of way.',
  'Wrote a script to automate a five-minute task. It only took three hours. I regret nothing. The script will run twice, ever.',
  'Clean code is not about making code pretty. It is about making code honest about what it does and what it costs.',
  'There are two hard problems in computer science: cache invalidation, naming things, and off-by-one errors.',
  'The urge to rewrite everything from scratch is strongest exactly when you understand the system least.',
  'A reminder that "it works on my machine" is not a deployment strategy, no matter how confidently you say it in standup.',
  'Spent the morning tuning a query from 4 seconds to 40 milliseconds. The fix was a single compound index. I have never felt more powerful and more ashamed simultaneously.',
  'Every config file is a tiny programming language with no documentation, no type system, and a single furious user: you, at 2am.',
  'The real 10x engineer is the one who deletes the feature nobody used so the rest of us never have to maintain it.',
  'Today in code review I left the comment "why?" on a single line. It started a forty-message thread, a design doc, and ultimately a much better solution. Sometimes one word is the whole review.',
];

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** A date uniformly spread within the last `days` days. */
function spreadDate(index: number, total: number, days: number): Date {
  const now = Date.now();
  const windowMs = days * 24 * 60 * 60 * 1000;
  // Even spread by index, plus a little jitter so timestamps are not perfectly uniform.
  const base = now - Math.round((index / total) * windowMs);
  const jitter = rand(0, 6 * 60 * 60 * 1000); // up to 6h
  return new Date(Math.min(now, base + jitter));
}

/**
 * Build a Mention `posts` document matching the stored schema shape. Inserted
 * directly into the collection (bypassing Mongoose) so it only needs to match
 * the document shape, which it does.
 */
function makePostDoc(userId: string, text: string, createdAt: Date) {
  return {
    _id: new mongoose.Types.ObjectId(),
    oxyUserId: userId,
    type: 'text',
    content: { text, media: [], sources: [] },
    visibility: 'public',
    parentPostId: null,
    boostOf: null,
    isEdited: false,
    editHistory: [],
    language: 'en',
    tags: [],
    mentions: [],
    hashtags: [],
    replyPermission: ['anyone'],
    reviewReplies: false,
    quotesDisabled: false,
    status: 'published',
    stats: {
      likesCount: rand(0, 240),
      downvotesCount: 0,
      boostsCount: rand(0, 60),
      commentsCount: rand(0, 40),
      viewsCount: rand(20, 5000),
      sharesCount: 0,
    },
    metadata: {
      isSensitive: false,
      isPinned: false,
      isSaved: false,
      isLiked: false,
      isBoosted: false,
      isCommented: false,
      isFollowingAuthor: false,
      authorBlocked: false,
      authorMuted: false,
      hideEngagementCounts: false,
      likedBy: [] as string[],
      savedBy: [] as string[],
    },
    seedTag: SEED_TAG,
    createdAt,
    updatedAt: createdAt,
  };
}

/** Build an Oxy-shaped user document matching the `oxy-dev` users collection. */
function makeOxyUserDoc(user: SeedUser) {
  const userId = new mongoose.Types.ObjectId();
  return {
    _id: userId,
    username: user.username,
    email: `${user.username}@seed.local`,
    name: { first: user.first, last: user.last },
    avatar: `https://api.dicebear.com/9.x/dylan/svg?seed=${encodeURIComponent(user.username)}`,
    bio: user.bio,
    color: user.color,
    type: 'local',
    verified: rand(0, 3) === 0,
    language: 'en',
    seedTag: SEED_TAG,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

async function main(): Promise<void> {
  const mentionConn = await mongoose
    .createConnection(MONGO_HOST_URI, { dbName: MENTION_DB_NAME })
    .asPromise();
  const oxyConn = await mongoose.createConnection(OXY_DB_URI).asPromise();

  const mentionDb = mentionConn.db;
  const oxyDb = oxyConn.db;
  if (!mentionDb || !oxyDb) {
    throw new Error('Failed to acquire database handles from connections');
  }

  console.log(`Mention posts DB: ${MONGO_HOST_URI} (db: ${MENTION_DB_NAME})`);
  console.log(`Oxy users DB:     ${OXY_DB_URI}`);

  const postsCol = mentionDb.collection('posts');
  const usersCol = oxyDb.collection('users');

  // ── Idempotency: remove anything from a previous run of THIS seed ──
  const removedPosts = await postsCol.deleteMany({ seedTag: SEED_TAG });
  const removedUsers = await usersCol.deleteMany({ seedTag: SEED_TAG });
  console.log(`Cleaned previous seed: ${removedPosts.deletedCount} posts, ${removedUsers.deletedCount} users`);

  // ── Seed Oxy-shaped users (author identities) ──
  const userDocs = SEED_USERS.map(makeOxyUserDoc);
  await usersCol.insertMany(userDocs);
  const userIds = userDocs.map((u) => u._id.toString());
  console.log(`Inserted ${userDocs.length} Oxy users into oxy-dev`);

  // ── Seed root posts with widely varying text length ──
  const postDocs = [];
  for (let i = 0; i < POST_COUNT; i++) {
    const authorId = userIds[rand(0, userIds.length - 1)];
    // Pick a body across the FULL length range so heights vary row-to-row.
    const text = TEXT_BODIES[rand(0, TEXT_BODIES.length - 1)];
    const createdAt = spreadDate(i, POST_COUNT, TIMELINE_DAYS);
    postDocs.push(makePostDoc(authorId, text, createdAt));
  }
  await postsCol.insertMany(postDocs);
  console.log(`Inserted ${postDocs.length} root posts into ${MENTION_DB_NAME}`);

  // ── Summary ──
  const totalSeedPosts = await postsCol.countDocuments({ seedTag: SEED_TAG });
  const totalPosts = await postsCol.countDocuments({});
  console.log('\n--- Summary ---');
  console.log(`Seeded users:        ${userDocs.length}`);
  console.log(`Seeded posts:        ${totalSeedPosts}`);
  console.log(`Total posts in DB:   ${totalPosts}`);

  await mentionConn.close();
  await oxyConn.close();
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
