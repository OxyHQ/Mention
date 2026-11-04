/**
 * Formatters that condense API responses into LLM-friendly text.
 * These are used in MCP tool responses so the model gets structured,
 * scannable output without excessive JSON noise.
 */

import type { HydratedPost, PollDetail, PollResults } from '@mention/shared-types';
import { getNormalizedUserHandle } from '@oxy.so/core';

/**
 * A post as `PostHydrationService` serves it. Every field is optional because
 * tools hand the API's JSON straight through: a formatter prints what is there
 * and never throws on what is not.
 */
type PostView = Partial<HydratedPost>;

export function formatPost(post: PostView): string {
  const id = post.id || 'unknown';
  const handle = post.user ? getNormalizedUserHandle(post.user) : undefined;
  const author = post.user
    ? `@${handle || 'unknown'}${post.user.verified ? ' ✓' : ''} (${post.user.name?.displayName || ''})`
    : 'unknown author';

  // A bare boost has no body of its own: what it shares is the original.
  const original = post.originalPost;
  const text =
    post.content?.text ||
    (original
      ? `↻ Reposted [${original.id || 'unknown'}] @${original.user ? getNormalizedUserHandle(original.user) || 'unknown' : 'unknown'}: ${original.content?.text || '(no text)'}`
      : '(no text)');
  // Say when a post is NOT public, so a client never repeats a followers-only
  // or private post to an audience its author did not choose.
  const visibility = post.metadata?.visibility;
  const date = post.metadata?.createdAt || '';

  // A count the author hides arrives as `null`; it prints as 0, as before.
  const likesCount = post.engagement?.likes ?? 0;
  const boostsCount = post.engagement?.boosts ?? 0;
  const commentsCount = post.engagement?.replies ?? 0;

  // The author's Oxy id, because the tools that act on a person (get-profile,
  // mute-user, subscribe-to-user, poke-user) take the id, not the handle.
  const authorLine = post.user?.id ? `${author} · user id: ${post.user.id}` : author;

  const parts: string[] = [
    `[${id}] ${authorLine}`,
    ...(visibility && visibility !== 'public' ? [`Visibility: ${visibility} (not public)`] : []),
    text,
    `♥ ${likesCount}  ↻ ${boostsCount}  💬 ${commentsCount}`,
  ];

  const hashtags = post.metadata?.hashtags;
  if (hashtags && hashtags.length > 0) {
    parts.push(`Tags: ${hashtags.map((h) => `#${h}`).join(' ')}`);
  }

  if (post.content?.media && post.content.media.length > 0) {
    parts.push(`Media: ${post.content.media.map((m) => `${m.type}(${m.id})`).join(', ')}`);
  }

  for (const preview of post.documents ?? []) {
    const previewTitle = preview.title || preview.publisher || preview.canonicalUrl;
    parts.push(`Document: ${previewTitle}`);
    if (preview.description) {
      parts.push(`  ${preview.description}`);
    }
  }

  if (post.content?.sources && post.content.sources.length > 0) {
    parts.push(`Sources: ${post.content.sources.map((s) => s.title || s.url).join(', ')}`);
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
    parts.push(`Event: ${post.content.event.name} (${post.content.event.date ?? ''})`);
  }

  if (post.content?.room?.title) {
    parts.push(`Room: ${post.content.room.title}`);
  }

  if (post.lane?.id) parts.push(`Lane: ${post.lane.name ?? 'unnamed'} (id: ${post.lane.id})`);
  if (post.parentPostId) parts.push(`Reply to: ${post.parentPostId}`);
  if (post.quotedPost?.id) parts.push(`Quote of: ${post.quotedPost.id}`);

  const authorLines = formatAuthors(post);
  if (authorLines.length > 0) {
    parts.push(`Authors: ${authorLines.join(', ')}`);
  }

  if (post.viewerState?.collabInvitePending) {
    parts.push('Collab invite: pending (use accept-collab-invite or decline-collab-invite)');
  }

  if (date) parts.push(`Date: ${date}`);

  const flags: string[] = [];
  if (post.viewerState?.isLiked) flags.push('liked');
  if (post.viewerState?.isBoosted) flags.push('boosted');
  if (post.viewerState?.isSaved) flags.push('saved');
  if (flags.length > 0) parts.push(`You: ${flags.join(', ')}`);

  return parts.join('\n');
}

function formatAuthors(post: PostView): string[] {
  if (post.authors && post.authors.length > 0) {
    return post.authors.map((author) => {
      const handle = author.username ? `@${author.username}` : author.id || 'unknown';
      const role = author.role ?? 'author';
      const status = author.status ?? 'accepted';
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
  /** List timelines wrap each post as `{ id, type, data }`; other feeds do not. */
  items?: Array<{ data?: PostView } & PostView>;
  posts?: PostView[];
  hasMore?: boolean;
  nextCursor?: string;
  totalCount?: number;
}

export function formatFeed(response: FeedResponse): string {
  const posts: PostView[] = [];

  if (response.items) {
    for (const item of response.items) {
      posts.push(item.data || item);
    }
  } else if (response.posts) {
    posts.push(...response.posts);
  }

  if (posts.length === 0) {
    return 'No posts found.';
  }

  const lines = posts.map((p, i) => `--- Post ${i + 1} ---\n${formatPost(p)}`);

  const meta: string[] = [];
  if (response.hasMore) meta.push(`More available (cursor: ${response.nextCursor || '?'})`);
  if (response.totalCount !== undefined) meta.push(`Total: ${response.totalCount}`);

  if (meta.length > 0) {
    lines.push(`\n${meta.join(' | ')}`);
  }

  return lines.join('\n\n');
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
  const id = n._id || 'unknown';
  const actor = n.actorId_populated
    ? `@${n.actorId_populated.username || 'unknown'} (${n.actorId_populated.name || ''})`
    : 'someone';
  const type = n.type || 'unknown';
  const read = n.read ? 'read' : 'unread';
  const preview = n.preview ? `\n  "${n.preview}"` : '';
  const date = n.createdAt || '';
  // The post (or profile) it is about, so a client can open it or answer it.
  const about = n.entityId ? `\n  ${n.entityType || 'entity'}: ${n.entityId}` : '';

  return `[${id}] ${actor} — ${type} (${read})${preview}${about}${date ? `\n  ${date}` : ''}`;
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
  const id = list._id || 'unknown';
  const title = list.title || 'Untitled';
  const vis = list.isPublic ? 'public' : 'private';
  const members = list.memberOxyUserIds?.length || 0;
  const desc = list.description ? `\n  ${list.description}` : '';

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
  const id = detail._id || results.id || 'unknown';
  const question = poll.question || 'No question';
  const options = Array.isArray(detail.options)
    ? detail.options.map((option) => ({
        id: option._id,
        text: option.text,
        votes: option.voteCount,
      }))
    : Array.isArray(results.results)
      ? results.results.map((option) => ({
          id: option.id,
          text: option.text,
          votes: option.voteCount,
        }))
      : [];
  const total =
    typeof results.totalVotes === 'number'
      ? results.totalVotes
      : options.reduce((sum, option) => sum + (option.votes || 0), 0);

  const optionLines = options.map((option, i) => {
    const votes = option.votes || 0;
    const pct = total > 0 ? Math.round((votes / total) * 100) : 0;
    return `  ${i + 1}. ${option.text} — ${votes} votes (${pct}%) (option id: ${option.id})`;
  });

  const parts = [`[${id}] ${question}`, ...optionLines, `Total votes: ${total}`];
  if (poll.endsAt) parts.push(`${results.isEnded ? 'Ended' : 'Ends'}: ${poll.endsAt}`);
  if (detail.isMultipleChoice) parts.push('Multiple choice.');
  if (detail.viewerSelectedOptionIds && detail.viewerSelectedOptionIds.length > 0) {
    parts.push('You have voted.');
  }

  return parts.join('\n');
}
