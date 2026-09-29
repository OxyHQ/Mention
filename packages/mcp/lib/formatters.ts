/**
 * Formatters that condense API responses into LLM-friendly text.
 * These are used in MCP tool responses so the model gets structured,
 * scannable output without excessive JSON noise.
 */

import type { PollDetail, PollResults } from "@mention/shared-types";
import { getNormalizedUserHandle } from "@oxy.so/core";

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
  lane?: { id?: string; name?: string };
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
  parentPostId?: string;
  boostOf?: string;
  quoteOf?: string;
  /** A boost's original, as hydration attaches it (null when it is gone). */
  originalPost?: PostData | null;
  /** Hydrated posts carry their audience here; `visibility` is the raw row's. */
  metadata?: { visibility?: string };
  authors?: Array<{
    id?: string;
    username?: string;
    name?: { displayName?: string };
    role?: string;
    status?: string;
    isFederated?: boolean;
  }>;
  authorship?: Array<{
    oxyUserId: string;
    role: string;
    status: string;
  }>;
  viewerState?: {
    collabInvitePending?: boolean;
    isCollaborator?: boolean;
    isOwner?: boolean;
    isLiked?: boolean;
    isBoosted?: boolean;
    isSaved?: boolean;
  };
  documents?: Array<{
    canonicalUrl: string;
    title?: string;
    description?: string;
    imageUrl?: string;
    publisher?: string;
  }>;
}

export function formatPost(post: PostData): string {
  const id = post.id || post._id || "unknown";
  const handle = post.user ? getNormalizedUserHandle(post.user) : undefined;
  const author = post.user
    ? `@${handle || "unknown"}${post.user.verified ? " ✓" : ""} (${post.user.name?.displayName || ""})`
    : post.oxyUserId || "unknown author";

  // A bare boost has no body of its own: what it shares is the original.
  const original = post.originalPost;
  const text = post.content?.text
    || (original ? `↻ Reposted [${original.id || original._id || "unknown"}] @${original.user ? getNormalizedUserHandle(original.user) || "unknown" : "unknown"}: ${original.content?.text || "(no text)"}` : "(no text)");
  // Say when a post is NOT public, so a client never repeats a followers-only
  // or private post to an audience its author did not choose.
  const visibility = post.metadata?.visibility ?? post.visibility;
  const date = post.date || post.createdAt || "";

  const rawStats = (post.stats || post.engagement || {}) as Record<string, number | undefined>;
  const likesCount = rawStats.likesCount ?? rawStats.likes ?? 0;
  const boostsCount = rawStats.boostsCount ?? rawStats.boosts ?? 0;
  const commentsCount = rawStats.commentsCount ?? rawStats.replies ?? 0;

  // The author's Oxy id, because the tools that act on a person (get-profile,
  // mute-user, subscribe-to-user, poke-user) take the id, not the handle.
  const authorLine = post.user?.id ? `${author} · user id: ${post.user.id}` : author;

  const parts: string[] = [
    `[${id}] ${authorLine}`,
    ...(visibility && visibility !== "public" ? [`Visibility: ${visibility} (not public)`] : []),
    text,
    `♥ ${likesCount}  ↻ ${boostsCount}  💬 ${commentsCount}`,
  ];

  if (post.hashtags && post.hashtags.length > 0) {
    parts.push(`Tags: ${post.hashtags.map((h) => `#${h}`).join(" ")}`);
  }

  if (post.content?.media && post.content.media.length > 0) {
    parts.push(`Media: ${post.content.media.map((m) => `${m.type}(${m.id})`).join(", ")}`);
  }

  for (const preview of post.documents ?? []) {
    const previewTitle = preview.title || preview.publisher || preview.canonicalUrl;
    parts.push(`Document: ${previewTitle}`);
    if (preview.description) {
      parts.push(`  ${preview.description}`);
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

  if (post.lane?.id) parts.push(`Lane: ${post.lane.name ?? "unnamed"} (id: ${post.lane.id})`);
  if (post.parentPostId) parts.push(`Reply to: ${post.parentPostId}`);
  if (post.boostOf) parts.push(`Boost of: ${post.boostOf}`);
  if (post.quoteOf) parts.push(`Quote of: ${post.quoteOf}`);

  const authorLines = formatAuthors(post);
  if (authorLines.length > 0) {
    parts.push(`Authors: ${authorLines.join(", ")}`);
  }

  if (post.viewerState?.collabInvitePending) {
    parts.push("Collab invite: pending (use accept-collab-invite or decline-collab-invite)");
  }

  if (date) parts.push(`Date: ${date}`);
  if (post.visibility && post.visibility !== "public") parts.push(`Visibility: ${post.visibility}`);

  const flags: string[] = [];
  if (post.viewerState?.isLiked) flags.push("liked");
  if (post.viewerState?.isBoosted) flags.push("boosted");
  if (post.viewerState?.isSaved) flags.push("saved");
  if (flags.length > 0) parts.push(`You: ${flags.join(", ")}`);

  return parts.join("\n");
}

function formatAuthors(post: PostData): string[] {
  if (post.authors && post.authors.length > 0) {
    return post.authors.map((author) => {
      const handle = author.username ? `@${author.username}` : author.id || "unknown";
      const role = author.role ?? "author";
      const status = author.status ?? "accepted";
      return `${handle} (${role}, ${status})`;
    });
  }

  if (post.authorship && post.authorship.length > 0) {
    return post.authorship.map((entry) => {
      return `${entry.oxyUserId} (${entry.role}, ${entry.status})`;
    });
  }

  return [];
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
  // The post (or profile) it is about, so a client can open it or answer it.
  const about = n.entityId ? `\n  ${n.entityType || "entity"}: ${n.entityId}` : "";

  return `[${id}] ${actor} — ${type} (${read})${preview}${about}${date ? `\n  ${date}` : ""}`;
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

type PollData = Partial<PollDetail> | Partial<PollResults>;

/**
 * One poll, from either wire shape: `GET /polls/:id` and the vote answer are a
 * {@link PollDetail} (`_id`, `options[]._id`), `GET /polls/:id/results` is a
 * {@link PollResults} (`id`, `results[].id`). Option ids are printed because
 * vote-poll takes one.
 */
export function formatPoll(poll: PollData): string {
  const detail = poll as Partial<PollDetail>;
  const results = poll as Partial<PollResults>;
  const id = detail._id || results.id || "unknown";
  const question = poll.question || "No question";
  const options = Array.isArray(detail.options)
    ? detail.options.map((option) => ({ id: option._id, text: option.text, votes: option.voteCount }))
    : Array.isArray(results.results)
      ? results.results.map((option) => ({ id: option.id, text: option.text, votes: option.voteCount }))
      : [];
  const total = typeof results.totalVotes === "number"
    ? results.totalVotes
    : options.reduce((sum, option) => sum + (option.votes || 0), 0);

  const optionLines = options.map((option, i) => {
    const votes = option.votes || 0;
    const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
    return `  ${i + 1}. ${option.text} — ${votes} votes (${pct}%) (option id: ${option.id})`;
  });

  const parts = [`[${id}] ${question}`, ...optionLines, `Total votes: ${total}`];
  if (poll.endsAt) parts.push(`${results.isEnded ? "Ended" : "Ends"}: ${poll.endsAt}`);
  if (detail.isMultipleChoice) parts.push("Multiple choice.");
  if (detail.viewerSelectedOptionIds && detail.viewerSelectedOptionIds.length > 0) {
    parts.push("You have voted.");
  }

  return parts.join("\n");
}
