/**
 * Seed script to create fake users with real linked engagement data.
 * Creates actual like documents, repost posts, reply posts — not just stat numbers.
 *
 * Usage:
 *   cd packages/backend && bun src/scripts/seedFakeUsers.ts
 */

import mongoose from 'mongoose';

const OXY_DB_URI = 'mongodb://localhost:27017/oxy-dev';
const MENTION_DB_URI = 'mongodb://localhost:27017/mention-development';
const NATE_USER_ID = '69cec05bc6bb589189416335';

const FAKE_USERS = [
  { username: 'sarahchen', first: 'Sarah', last: 'Chen', color: 'blue', bio: 'Product designer. Coffee enthusiast.' },
  { username: 'marcusj', first: 'Marcus', last: 'Johnson', color: 'green', bio: 'Full-stack dev. Building cool stuff.' },
  { username: 'emiliarossi', first: 'Emilia', last: 'Rossi', color: 'purple', bio: 'UX researcher at a startup nobody has heard of yet.' },
  { username: 'jameskim', first: 'James', last: 'Kim', color: 'red', bio: 'Engineering manager. Opinions are my own.' },
  { username: 'priya_dev', first: 'Priya', last: 'Sharma', color: 'orange', bio: 'Mobile dev. React Native lover.' },
  { username: 'alexwright', first: 'Alex', last: 'Wright', color: 'blue', bio: 'Indie hacker. Shipping fast.' },
  { username: 'linawang', first: 'Lina', last: 'Wang', color: 'green', bio: 'Data scientist by day, photographer by night.' },
  { username: 'tomharris', first: 'Tom', last: 'Harris', color: 'purple', bio: 'Backend engineer. Distributed systems nerd.' },
  { username: 'sofiamorales', first: 'Sofia', last: 'Morales', color: 'red', bio: 'Design systems. Typography. Accessibility.' },
  { username: 'danielpark', first: 'Daniel', last: 'Park', color: 'orange', bio: 'Founding engineer. Previously at Big Tech.' },
  { username: 'rachelgreen', first: 'Rachel', last: 'Green', color: 'blue', bio: 'DevRel. Conference speaker. Dog mom.' },
  { username: 'omarfaruq', first: 'Omar', last: 'Faruq', color: 'green', bio: 'Open source contributor. Rust enthusiast.' },
  { username: 'nataliebrooks', first: 'Natalie', last: 'Brooks', color: 'purple', bio: 'Product manager. Writing about tech and life.' },
  { username: 'ryanmiller', first: 'Ryan', last: 'Miller', color: 'red', bio: 'iOS developer. SwiftUI convert.' },
  { username: 'aikotan', first: 'Aiko', last: 'Tanaka', color: 'orange', bio: 'Frontend engineer. CSS wizard.' },
];

const POST_TEXTS = [
  'Just pushed a massive refactor. Everything still works. I think.',
  'The best code review feedback I ever got was "why?"',
  'Controversial opinion: tabs > spaces. Fight me.',
  'Shipped a new feature today and nobody complained. Is this what success feels like?',
  'Pair programming is just socially acceptable backseat driving.',
  'My terminal has more tabs open than my browser.',
  'Code that works on the first try is the most suspicious code.',
  'Just discovered a bug that has been in production for 6 months. Nobody noticed.',
  'The real 10x engineer is the one who deletes code.',
  'Today I mass-deleted 3000 lines of dead code. Best day this quarter.',
  'If your standup lasts more than 5 minutes, it is a meeting.',
  'I love when the solution to a complex problem is deleting code.',
  'Documentation is a love letter to your future self.',
  'My IDE is basically a very fancy text editor that judges my code.',
  'Hot take: most microservices should just be functions.',
  'The fastest code is code that never runs.',
  'Just spent 3 hours debugging only to find a missing comma.',
  'Release Friday? In this economy?',
  'Sometimes the best architecture decision is "not yet".',
  'Wrote a script to automate a 5 minute task. Only took 3 hours.',
  'My commit messages are getting increasingly existential.',
  'The urge to rewrite everything from scratch is strong today.',
  'Just learned that the feature I spent a week building already exists in the stdlib.',
  'Rubber duck debugging works because the duck does not interrupt you.',
  'Decided to try a new framework. Now I have two problems.',
  'Clean code is not about making code pretty. It is about making code honest.',
  'The difference between a junior and senior dev is how they Google things.',
  'Today I mass-renamed a variable and broke 47 tests. Growth.',
  'Wrote a TODO comment 2 years ago. Today I finally resolved it by deleting the file.',
  'The real feature was the bugs we shipped along the way.',
];

const REPLY_TEXTS = [
  'Great post! Totally agree.',
  'This is so true.',
  'Interesting perspective, thanks for sharing.',
  'I have been thinking the same thing lately.',
  'Love this take.',
  'Could not agree more.',
  'This made my day, thanks.',
  'Saving this for later.',
  'Exactly what I needed to hear today.',
  'Brilliant observation.',
  'Ha, this is too real.',
  'Same energy here.',
  'My team needs to see this.',
  'Underrated take right here.',
  'Facts.',
];

function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomDate(daysAgo: number): Date {
  const now = new Date();
  return new Date(now.getTime() - rand(0, daysAgo * 24 * 60 * 60 * 1000));
}

function pickRandom<T>(arr: T[], count: number): T[] {
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.min(count, arr.length));
}

function makePostDoc(userId: string, text: string, type: string, createdAt: Date, extra: Record<string, any> = {}) {
  return {
    _id: new mongoose.Types.ObjectId(),
    oxyUserId: userId,
    type,
    content: { text, media: [], sources: [] },
    visibility: 'public',
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
      likesCount: 0,
      downvotesCount: 0,
      repostsCount: 0,
      commentsCount: 0,
      viewsCount: rand(20, 800),
      sharesCount: 0,
    },
    metadata: {
      isSensitive: false,
      isPinned: false,
      isSaved: false,
      isLiked: false,
      isReposted: false,
      isCommented: false,
      isFollowingAuthor: false,
      authorBlocked: false,
      authorMuted: false,
      hideEngagementCounts: false,
      likedBy: [] as string[],
      savedBy: [],
    },
    extracted: { topics: [] },
    translations: [],
    createdAt,
    updatedAt: createdAt,
    ...extra,
  };
}

async function main() {
  const oxyConn = await mongoose.createConnection(OXY_DB_URI).asPromise();
  const mentionConn = await mongoose.createConnection(MENTION_DB_URI).asPromise();
  console.log('Connected to both databases');

  const usersCol = oxyConn.db!.collection('users');
  const followsCol = oxyConn.db!.collection('follows');
  const postsCol = mentionConn.db!.collection('posts');
  const likesCol = mentionConn.db!.collection('likes');
  const bookmarksCol = mentionConn.db!.collection('bookmarks');

  // ── Clean up previous seed ──────────────────────────────────
  const existingUsernames = FAKE_USERS.map(u => u.username);
  const existingUsers = await usersCol.find({ username: { $in: existingUsernames } }).toArray();
  const existingIds = existingUsers.map(u => u._id.toString());

  if (existingIds.length > 0) {
    await usersCol.deleteMany({ username: { $in: existingUsernames } });
    await postsCol.deleteMany({ oxyUserId: { $in: [...existingIds, NATE_USER_ID] } });
    await likesCol.deleteMany({}).catch(() => {});
    await bookmarksCol.deleteMany({}).catch(() => {});
    await followsCol.deleteMany({ $or: [{ followerId: NATE_USER_ID }, { followingId: NATE_USER_ID }] }).catch(() => {});
    console.log(`Cleaned up ${existingIds.length} seed users + related data`);
  } else {
    // Still clean nate's seeded posts
    await postsCol.deleteMany({ oxyUserId: NATE_USER_ID });
  }

  // ── Create users ────────────────────────────────────────────
  console.log('\nCreating users...');
  const createdUserIds: string[] = [];

  for (const u of FAKE_USERS) {
    const userId = new mongoose.Types.ObjectId();
    const avatarUrl = `https://api.dicebear.com/9.x/dylan/svg?seed=${encodeURIComponent(u.username)}`;

    await usersCol.insertOne({
      _id: userId,
      username: u.username,
      email: `${u.username}@example.com`,
      password: '$argon2id$v=19$m=19456,t=2,p=1$fake$fakehashnotreal',
      refreshToken: null,
      twoFactorAuth: { enabled: false, backupCodes: [] },
      verified: rand(0, 3) === 0,
      language: 'en',
      following: [NATE_USER_ID],
      followers: [],
      privacySettings: {
        isPrivateAccount: false, hideOnlineStatus: false, hideLastSeen: false,
        profileVisibility: true, loginAlerts: true, blockScreenshots: false,
        login: true, biometricLogin: false, showActivity: true, allowTagging: true,
        allowMentions: true, hideReadReceipts: false, allowDirectMessages: true,
        dataSharing: true, locationSharing: false, analyticsSharing: true,
        sensitiveContent: false, autoFilter: true, muteKeywords: false,
      },
      _count: { followers: rand(10, 2000), following: rand(50, 500) },
      links: [], accountExpiresAfterInactivityDays: null, emailSignature: '',
      autoReply: { enabled: false, subject: '', body: '', startDate: null, endDate: null },
      type: 'local', authMethods: [], color: u.color, locations: [], linksMetadata: [],
      bio: u.bio,
      avatar: avatarUrl,
      name: { first: u.first, last: u.last },
      createdAt: randomDate(180),
      updatedAt: new Date(),
    });

    createdUserIds.push(userId.toString());
    console.log(`  @${u.username} (${u.first} ${u.last})`);
  }

  // ── Create follow relationships ─────────────────────────────
  // All fake users follow nate, nate follows all fake users
  const followDocs: any[] = [];
  for (const id of createdUserIds) {
    followDocs.push(
      { followerId: id, followingId: NATE_USER_ID, createdAt: randomDate(90), updatedAt: new Date() },
      { followerId: NATE_USER_ID, followingId: id, createdAt: randomDate(90), updatedAt: new Date() },
    );
  }
  // Some fake users follow each other
  for (let i = 0; i < createdUserIds.length; i++) {
    const followCount = rand(2, 5);
    const targets = pickRandom(createdUserIds.filter((_, j) => j !== i), followCount);
    for (const t of targets) {
      followDocs.push({ followerId: createdUserIds[i], followingId: t, createdAt: randomDate(60), updatedAt: new Date() });
    }
  }
  await followsCol.insertMany(followDocs, { ordered: false }).catch(() => {});
  await usersCol.updateOne(
    { _id: new mongoose.Types.ObjectId(NATE_USER_ID) },
    {
      $addToSet: { following: { $each: createdUserIds }, followers: { $each: createdUserIds } },
      $set: { '_count.followers': createdUserIds.length, '_count.following': createdUserIds.length },
    },
  );
  console.log(`\nCreated ${followDocs.length} follow relationships`);

  // ── Create posts ────────────────────────────────────────────
  console.log('\nCreating posts...');
  const allUserIds = [NATE_USER_ID, ...createdUserIds];
  const allPosts: any[] = [];

  // Nate's posts (spread over 90 days, some high-performing)
  for (let i = 0; i < 25; i++) {
    const types = ['text', 'text', 'text', 'image', 'image', 'video', 'poll'] as const;
    const post = makePostDoc(
      NATE_USER_ID,
      POST_TEXTS[i % POST_TEXTS.length],
      types[rand(0, types.length - 1)],
      randomDate(90),
    );
    // High-performer posts get more base views
    if (i < 5) post.stats.viewsCount = rand(500, 5000);
    allPosts.push(post);
  }

  // Fake users' posts (3-6 each)
  for (const userId of createdUserIds) {
    const count = rand(3, 6);
    for (let j = 0; j < count; j++) {
      const types = ['text', 'text', 'text', 'image'] as const;
      allPosts.push(makePostDoc(
        userId,
        POST_TEXTS[rand(0, POST_TEXTS.length - 1)],
        types[rand(0, types.length - 1)],
        randomDate(60),
      ));
    }
  }

  // Insert all root posts first
  await postsCol.insertMany(allPosts);
  console.log(`  ${allPosts.length} root posts`);

  // ── Create real likes ───────────────────────────────────────
  console.log('\nCreating likes...');
  const likeDocs: any[] = [];
  for (const post of allPosts) {
    const likerCount = rand(1, 10);
    const likers = pickRandom(allUserIds.filter(id => id !== post.oxyUserId), likerCount);
    for (const likerId of likers) {
      likeDocs.push({
        userId: likerId,
        postId: post._id,
        value: 1,
        createdAt: new Date(post.createdAt.getTime() + rand(1, 72) * 3600000),
        updatedAt: new Date(),
      });
    }
    // Update post stats and metadata.likedBy
    post.stats.likesCount = likers.length;
    post.metadata.likedBy = likers;
  }
  await likesCol.insertMany(likeDocs, { ordered: false }).catch(() => {});
  console.log(`  ${likeDocs.length} likes`);

  // ── Create real replies (as posts with parentPostId) ────────
  console.log('Creating replies...');
  const replyDocs: any[] = [];
  for (const post of allPosts) {
    // ~60% of posts get replies
    if (Math.random() > 0.6) continue;
    const replyCount = rand(1, 5);
    const repliers = pickRandom(allUserIds.filter(id => id !== post.oxyUserId), replyCount);
    for (const replierId of repliers) {
      const replyDate = new Date(post.createdAt.getTime() + rand(1, 48) * 3600000);
      replyDocs.push(makePostDoc(
        replierId,
        REPLY_TEXTS[rand(0, REPLY_TEXTS.length - 1)],
        'text',
        replyDate,
        { parentPostId: post._id.toString() },
      ));
    }
    post.stats.commentsCount = repliers.length;
  }
  if (replyDocs.length > 0) {
    await postsCol.insertMany(replyDocs);
  }
  console.log(`  ${replyDocs.length} replies`);

  // ── Create real reposts (posts with repostOf) ───────────────
  console.log('Creating reposts...');
  const repostDocs: any[] = [];
  for (const post of allPosts) {
    // ~30% of posts get reposted
    if (Math.random() > 0.3) continue;
    const repostCount = rand(1, 3);
    const reposters = pickRandom(allUserIds.filter(id => id !== post.oxyUserId), repostCount);
    for (const reposterId of reposters) {
      const repostDate = new Date(post.createdAt.getTime() + rand(1, 72) * 3600000);
      repostDocs.push(makePostDoc(
        reposterId,
        '',
        'repost',
        repostDate,
        { repostOf: post._id.toString() },
      ));
    }
    post.stats.repostsCount = reposters.length;
  }
  if (repostDocs.length > 0) {
    await postsCol.insertMany(repostDocs);
  }
  console.log(`  ${repostDocs.length} reposts`);

  // ── Create real bookmarks ───────────────────────────────────
  console.log('Creating bookmarks...');
  const bookmarkDocs: any[] = [];
  // Nate bookmarks some posts
  const nateFavs = pickRandom(allPosts.filter(p => p.oxyUserId !== NATE_USER_ID), rand(5, 12));
  for (const post of nateFavs) {
    bookmarkDocs.push({
      userId: NATE_USER_ID,
      postId: post._id,
      folder: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  // Some fake users bookmark nate's posts
  const natePosts = allPosts.filter(p => p.oxyUserId === NATE_USER_ID);
  for (const post of natePosts) {
    if (Math.random() > 0.5) continue;
    const savers = pickRandom(createdUserIds, rand(1, 4));
    for (const saverId of savers) {
      bookmarkDocs.push({
        userId: saverId,
        postId: post._id,
        folder: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
  }
  if (bookmarkDocs.length > 0) {
    await bookmarksCol.insertMany(bookmarkDocs, { ordered: false }).catch(() => {});
  }
  console.log(`  ${bookmarkDocs.length} bookmarks`);

  // ── Update post stats to match real data ────────────────────
  console.log('\nSyncing post stats...');
  const bulkOps = allPosts.map(post => ({
    updateOne: {
      filter: { _id: post._id },
      update: {
        $set: {
          'stats.likesCount': post.stats.likesCount,
          'stats.commentsCount': post.stats.commentsCount,
          'stats.repostsCount': post.stats.repostsCount,
          'metadata.likedBy': post.metadata.likedBy,
        },
      },
    },
  }));
  await postsCol.bulkWrite(bulkOps);

  // ── Summary ─────────────────────────────────────────────────
  const totalPosts = await postsCol.countDocuments();
  const totalLikes = await likesCol.countDocuments();
  const totalBookmarks = await bookmarksCol.countDocuments();

  console.log('\n--- Summary ---');
  console.log(`Users created: ${FAKE_USERS.length}`);
  console.log(`Root posts: ${allPosts.length}`);
  console.log(`Replies: ${replyDocs.length}`);
  console.log(`Reposts: ${repostDocs.length}`);
  console.log(`Total posts in DB: ${totalPosts}`);
  console.log(`Likes: ${totalLikes}`);
  console.log(`Bookmarks: ${totalBookmarks}`);
  console.log(`Follow relationships: ${followDocs.length}`);

  await oxyConn.close();
  await mentionConn.close();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
