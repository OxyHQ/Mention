/**
 * Stickers from Oxy's shared catalogue (`@oxy.so/stickers`), drawn by Bloom's
 * `Sticker` above an empty state. The client is built once in `AppProviders`
 * from the app's `OxyServices`; this module only names the stickers Mention
 * uses, so changing one screen's sticker is one line here.
 *
 * Each value is a catalogue id: the art can be redrawn in Oxy without a Mention
 * release, and a published sticker never stops resolving. The emoji and pack in
 * each comment are what the sticker is, for whoever reads this without the
 * catalogue open.
 *
 * Errors and settings pages keep their icon on purpose: a cartoon reacting to
 * "could not load" or "no blocked accounts" reads wrong.
 */

/** 😢 bear-friends-forever — the sad bear on a swing. */
const SAD_BEAR = '01a0eada-7bc3-73de-a931-fcd4c202a4db';
/** 👀 blob-blah-blah (watching) */
const BLOB_WATCHING = '01a0eada-9cc9-7d48-98e1-d6ef59830aa7';
/** 🤷 blob-blah-blah (shrugging) */
const BLOB_SHRUGGING = '01a0eada-9343-7430-8062-8424ea19b842';
/** 😅 blob-blah-blah (oops) */
const BLOB_OOPS = '01a0eada-959f-721f-92e0-3ddfa8ae8e27';
/** 👀 fearless-bird (watching) */
const BIRD_WATCHING = '01a0eadb-3d1f-7a01-a475-209ffc7ff5d1';
/** 👋 match-ready (wave) */
const MATCH_WAVE = '01a0eadb-761a-7b2b-bcb2-beee24b2cd17';
/** 👍 springtime (thumbsup) */
const SPRING_THUMBSUP = '01a0eadb-c6a9-7c35-8433-c308f9a4ce03';
/** 👋 introvert-life (wave) */
const INTROVERT_WAVE = '01a0eadb-5dd8-70d1-b12b-5083a0c5b01a';
/** 🍵 escape-from-reality (siptea) */
const ESCAPE_SIPTEA = '01a0eadb-0917-74c4-be61-8fd534b4faea';
/** 💅 introvert-life (thriving) */
const INTROVERT_THRIVING = '01a0eadb-647d-7f9c-8033-ac5f38deb9f9';
/** 🧐 holiday-cats (focused) */
const CATS_FOCUSED = '01a0eadb-4fad-7ea1-8c49-62ceff396792';
/** 🥳 fearless-bird (partytime) */
const BIRD_PARTYTIME = '01a0eadb-3895-7264-97c4-f7aaf2d722ef';
/** 💻 escape-from-reality (laptop) */
const ESCAPE_LAPTOP = '01a0eadb-07c7-7315-94aa-6d8639943c21';
/** 😌 introvert-life (chilling) */
const INTROVERT_CHILLING = '01a0eadb-6e8f-727e-b102-914aa907f2a5';
/** 😌 blob-the-fish (satisfied) */
const FISH_SATISFIED = '01a0eada-a932-73cf-9cfe-503437a42a51';
/** 🙅 introvert-life (nope) */
const INTROVERT_NOPE = '01a0eadb-6875-730c-988d-e04211c6a430';

export const EMPTY_STATE_STICKERS = {
  // Feeds
  feedFollowing: SAD_BEAR,
  feedForYou: BIRD_WATCHING,
  feedExplore: BLOB_WATCHING,
  /** 🤔 school-days (hmm) */
  feedHashtag: '01a0eadb-b018-704f-8a1f-57ada3bfebae',
  feedCustom: BLOB_SHRUGGING,

  // A profile's tabs, and a profile that is not there
  profilePosts: SAD_BEAR,
  profileReplies: SAD_BEAR,
  profileMedia: BIRD_WATCHING,
  /** 🎶 cat-duo (vibing) */
  profileVideos: '01a0eada-bed5-7bb5-9c1d-3c1e1a42db6c',
  /** ❤️ xoxo (heart) */
  profileLikes: '01a0eadc-0d94-7ac1-a3e9-99be20ec22fc',
  /** 🙌 blob-blah-blah (handsup) */
  profileBoosts: '01a0eada-9fcb-7945-9975-7b1af011bc8b',
  profileMentions: SPRING_THUMBSUP,
  profileNotFound: BLOB_OOPS,

  // A post
  threadNoReplies: SAD_BEAR,
  /** 😶 school-days (empty face) */
  postNoEngagement: '01a0eadb-aa19-72ae-b13d-e779180a89ca',

  // /@username/followers and its tabs
  connectionsFollowers: MATCH_WAVE,
  connectionsFollowing: INTROVERT_WAVE,
  /** 😢 taste-buds (sad) */
  connectionsRecommendations: '01a0eadb-e325-742f-83de-1fba7d6c7e58',
  /** 🤨 springtime (suspicious) */
  connectionsInCommon: '01a0eadb-cbf2-7cc8-853f-549380c9051e',

  // Notifications, per tab
  notificationsAll: SPRING_THUMBSUP,
  /** 👍 introvert-life (thumbsup) */
  notificationsMentions: '01a0eadb-6a0d-79bf-94a1-bd7c81a7507e',
  notificationsFollows: INTROVERT_WAVE,
  /** 😍 xoxo (lovestruck) */
  notificationsLikes: '01a0eadc-1933-71e2-9a43-5e9957b8f388',
  notificationsPosts: ESCAPE_SIPTEA,
  /** 😉 taste-buds (wink) */
  notificationsPokes: '01a0eadb-dd2c-74d2-a208-621d1a4bb540',

  // Search
  searchIdle: BLOB_WATCHING,
  searchNoResults: BLOB_SHRUGGING,

  // Collections
  saved: ESCAPE_SIPTEA,
  lists: CATS_FOCUSED,
  starterPacks: BIRD_PARTYTIME,
  /** 🏃 blob-blah-blah (omw) */
  lanes: '01a0eada-9e38-7428-89a9-bcac44aad7ba',

  // Discovery
  feedStore: INTROVERT_THRIVING,
  trending: BLOB_WATCHING,
  /** 🌙 dance-to-the-beat (goodnight) */
  liveRooms: '01a0eada-f96e-7fd5-9486-c36b4dc05288',
  feedNotFound: BLOB_OOPS,
  /** 😕 taste-buds (confused) — the 404 page. */
  notFound: '01a0eadb-ee07-7b6f-a868-3fea8fc02476',

  // A profile's other tabs, and a channel's writers
  profileFeeds: INTROVERT_THRIVING,
  profileJobs: ESCAPE_LAPTOP,
  profileStarterPacks: BIRD_PARTYTIME,
  profileLists: CATS_FOCUSED,
  /** 💡 blob-the-fish (inspired) */
  channelWriters: '01a0eada-abf1-7759-bcf4-610c070fcff5',

  // Inside a list, a custom feed's page, and the videos tab
  listPosts: BLOB_SHRUGGING,
  listMembers: MATCH_WAVE,
  feedPageEmpty: BLOB_SHRUGGING,
  videosTab: '01a0eada-bed5-7bb5-9c1d-3c1e1a42db6c',

  // Writing
  /** 😴 vacation (sleepy) */
  drafts: '01a0eadb-f89c-76ae-a954-0bed0cf5be1c',
  /** 🙂 vacation (waiting) */
  scheduledPosts: '01a0eadb-feca-7ade-85fb-979d7ab575eb',
  postCorrections: SPRING_THUMBSUP,

  // Jobs
  jobsSearch: BLOB_SHRUGGING,
  jobsMine: ESCAPE_LAPTOP,
  jobApplications: ESCAPE_LAPTOP,

  // Community and moderation
  /** 🧐 match-ready (judgemental) */
  communityNotes: '01a0eadb-8559-7417-95d7-15b7ec796f2c',
  labelers: BLOB_SHRUGGING,
  trendGraph: BLOB_WATCHING,
  transparency: SPRING_THUMBSUP,

  // Settings and restricted screens: calm characters, nothing is wrong here
  blockedAccounts: INTROVERT_CHILLING,
  restrictedAccounts: INTROVERT_CHILLING,
  mutedWords: FISH_SATISFIED,
  mutedLanes: FISH_SATISFIED,
  /** 🤞 harvest-season (fingerscrossed) */
  subscriptions: '01a0eadb-4b0d-780a-97eb-f7ca286c7908',
  operatorOnly: INTROVERT_NOPE,

  // Something went wrong: every error state gets one, by default (see
  // `components/common/EmptyState.tsx`)
  /** 😵‍💫 school-days (dizzy) — could not load, something went wrong. */
  loadError: '01a0eadb-a89b-7b15-b07e-779c938c26c3',
  /** 😞 escape-from-reality (defeated) — no connection. */
  offline: '01a0eadb-146d-7d9e-99ec-e96a6c9dd671',
} as const;

export type EmptyStateStickerName = keyof typeof EMPTY_STATE_STICKERS;
