/**
 * Formatters that condense API responses into LLM-friendly text.
 * These are used in MCP tool responses so the model gets structured,
 * scannable output without excessive JSON noise.
 */

import { getNormalizedUserHandle } from "@oxyhq/core";

interface PostData {
  id?: string;
  _id?: string;
  // Canonical Oxy `User` shape emitted by `PostHydrationService` (Oxy owns
  // identity): render `name.displayName`, derive the handle via
  // `getNormalizedUserHandle`. No flat `name`/`handle` strings.
  user?: {
    id?: string;
    username?: string;
    name?: { displayName?: string };
    isFederated?: boolean;
    instance?: string;
    federation?: { domain?: string };
    verified?: boolean;
  };
  oxyUserId?: string;
  content?: {
    text?: string;
    media?: Array<{ id: string; type: string }>;
    pollId?: string;
    poll?: { question?: string; options?: string[] };
    sources?: Array<{ url: string; title?: string }>;
    location?: { address?: string; coordinates?: [number, number] };
    article?: { title?: string; excerpt?: string };
    event?: { name?: string; date?: string; location?: string };
    room?: { roomId?: string; title?: string; status?: string };
    podcast?: { syraPodcastId?: string; title?: string };
  };
  type?: string;
  visibility?: string;
  stats?: {
    likesCount?: number;
    boostsCount?: number;
    commentsCount?: number;
    viewsCount?: number;
  };
  engagement?: {
    likes?: number;
    boosts?: number;
    replies?: number;
  };
  hashtags?: string[];
  date?: string;
  createdAt?: string;
  isLiked?: boolean;
  isBoosted?: boolean;
  isSaved?: boolean;
  parentPostId?: string;
  boostOf?: string;
  quoteOf?: string;
  linkPreview?: {
    url?: string;
    title?: string;
    description?: string;
    image?: string;
    siteName?: string;
  } | null;
}

export function formatPost(post: PostData): string {
  const id = post.id || post._id || "unknown";
  const handle = post.user ? getNormalizedUserHandle(post.user) : undefined;
  const author = post.user
    ? `@${handle || "unknown"}${post.user.verified ? " ✓" : ""} (${post.user.name?.displayName || ""})`
    : post.oxyUserId || "unknown author";

  const text = post.content?.text || "(no text)";
  const date = post.date || post.createdAt || "";

  const rawStats = (post.stats || post.engagement || {}) as Record<string, number | undefined>;
  const likesCount = rawStats.likesCount ?? rawStats.likes ?? 0;
  const boostsCount = rawStats.boostsCount ?? rawStats.boosts ?? 0;
  const commentsCount = rawStats.commentsCount ?? rawStats.replies ?? 0;

  const parts: string[] = [
    `[${id}] ${author}`,
    text,
    `♥ ${likesCount}  ↻ ${boostsCount}  💬 ${commentsCount}`,
  ];

  if (post.hashtags && post.hashtags.length > 0) {
    parts.push(`Tags: ${post.hashtags.map((h) => `#${h}`).join(" ")}`);
  }

  if (post.content?.media && post.content.media.length > 0) {
    parts.push(`Media: ${post.content.media.map((m) => `${m.type}(${m.id})`).join(", ")}`);
  }

  if (post.linkPreview?.url) {
    const previewTitle = post.linkPreview.title || post.linkPreview.siteName || post.linkPreview.url;
    parts.push(`Link preview: ${previewTitle}`);
    if (post.linkPreview.description) {
      parts.push(`  ${post.linkPreview.description}`);
    }
  }

  if (post.content?.sources && post.content.sources.length > 0) {
    parts.push(`Sources: ${post.content.sources.map((s) => s.title || s.url).join(", ")}`);
  }

  if (post.content?.poll?.question) {
    parts.push(`Poll: ${post.content.poll.question}`);
  } else if (post.content?.pollId) {
    parts.push(`Poll: ${post.content.pollId}`);
  }

  if (post.content?.location?.address) {
    parts.push(`Location: ${post.content.location.address}`);
  }

  if (post.content?.article?.title) {
    parts.push(`Article: ${post.content.article.title}`);
  }

  if (post.content?.event?.name) {
    parts.push(`Event: ${post.content.event.name} (${post.content.event.date ?? ""})`);
  }

  if (post.content?.room?.title) {
    parts.push(`Room: ${post.content.room.title}`);
  }

  if (post.content?.podcast?.title) {
    parts.push(`Podcast: ${post.content.podcast.title}`);
  }

  if (post.parentPostId) parts.push(`Reply to: ${post.parentPostId}`);
  if (post.boostOf) parts.push(`Boost of: ${post.boostOf}`);
  if (post.quoteOf) parts.push(`Quote of: ${post.quoteOf}`);

  if (date) parts.push(`Date: ${date}`);
  if (post.visibility && post.visibility !== "public") parts.push(`Visibility: ${post.visibility}`);

  const flags: string[] = [];
  if (post.isLiked) flags.push("liked");
  if (post.isBoosted) flags.push("boosted");
  if (post.isSaved) flags.push("saved");
  if (flags.length > 0) parts.push(`You: ${flags.join(", ")}`);

  return parts.join("\n");
}

interface FeedResponse {
  items?: Array<{ data?: PostData } & PostData>;
  posts?: PostData[];
  hasMore?: boolean;
  nextCursor?: string;
  totalCount?: number;
}

export function formatFeed(response: FeedResponse): string {
  const posts: PostData[] = [];

  if (response.items) {
    for (const item of response.items) {
      posts.push(item.data || item);
    }
  } else if (response.posts) {
    posts.push(...response.posts);
  }

  if (posts.length === 0) {
    return "No posts found.";
  }

  const lines = posts.map((p, i) => `--- Post ${i + 1} ---\n${formatPost(p)}`);

  const meta: string[] = [];
  if (response.hasMore) meta.push(`More available (cursor: ${response.nextCursor || "?"})`);
  if (response.totalCount !== undefined) meta.push(`Total: ${response.totalCount}`);

  if (meta.length > 0) {
    lines.push(`\n${meta.join(" | ")}`);
  }

  return lines.join("\n\n");
}

interface NotificationData {
  _id?: string;
  type?: string;
  message?: string;
  read?: boolean;
  preview?: string;
  actorId_populated?: {
    username?: string;
    name?: string;
  };
  entityType?: string;
  entityId?: string;
  createdAt?: string;
}

export function formatNotification(n: NotificationData): string {
  const id = n._id || "unknown";
  const actor = n.actorId_populated
    ? `@${n.actorId_populated.username || "unknown"} (${n.actorId_populated.name || ""})`
    : "someone";
  const type = n.type || "unknown";
  const read = n.read ? "read" : "unread";
  const preview = n.preview ? `\n  "${n.preview}"` : "";
  const date = n.createdAt || "";

  return `[${id}] ${actor} — ${type} (${read})${preview}${date ? `\n  ${date}` : ""}`;
}

interface ListData {
  _id?: string;
  title?: string;
  description?: string;
  isPublic?: boolean;
  memberOxyUserIds?: string[];
  ownerOxyUserId?: string;
}

export function formatList(list: ListData): string {
  const id = list._id || "unknown";
  const title = list.title || "Untitled";
  const vis = list.isPublic ? "public" : "private";
  const members = list.memberOxyUserIds?.length || 0;
  const desc = list.description ? `\n  ${list.description}` : "";

  return `[${id}] ${title} (${vis}, ${members} members)${desc}`;
}

interface PollData {
  _id?: string;
  question?: string;
  options?: Array<{ text: string; votes?: number }>;
  totalVotes?: number;
  expiresAt?: string;
  hasVoted?: boolean;
}

export function formatPoll(poll: PollData): string {
  const id = poll._id || "unknown";
  const question = poll.question || "No question";
  const total = poll.totalVotes || 0;
  const expires = poll.expiresAt ? `Expires: ${poll.expiresAt}` : "";

  const optionLines = (poll.options || []).map((opt, i) => {
    const votes = opt.votes || 0;
    const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
    return `  ${i + 1}. ${opt.text} — ${votes} votes (${pct}%)`;
  });

  const parts = [`[${id}] ${question}`, ...optionLines, `Total votes: ${total}`];
  if (expires) parts.push(expires);
  if (poll.hasVoted) parts.push("You have voted.");

  return parts.join("\n");
}
