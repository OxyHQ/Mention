import { describe, expect, it } from 'vitest';
import type { StoredPostContent } from '@mention/shared-types';
import {
  postSafetyClassification,
  postSafetyMaterial,
  safetyVerdictSchema,
  type SafetyMaterialPost,
} from '../../services/contentClassification/safetyAssessment';

const content: StoredPostContent = {
  variants: [{ source: 'author', tag: 'en', text: 'We planted a tree in the garden.' }],
};
const post = { content, quoteOf: null, boostOf: null, parentPostId: null };
function approved(material: SafetyMaterialPost = post) {
  return {
    materialDigest: postSafetyMaterial(material).digest,
    rating: 'general' as const,
    assessmentVersion: 1,
  };
}

describe('revision-bound trusted safety evidence', () => {
  it('never grants general from an author false flag or a completed ranking classification', () => {
    expect(
      postSafetyClassification({
        ...post,
        metadata: { isSensitive: false },
        postClassification: { sensitive: false },
      }),
    ).toBe('unrated');
    expect(postSafetyClassification(post, approved())).toBe('general');
    expect(postSafetyClassification(post, { ...approved(), assessmentVersion: 999 })).toBe(
      'unrated',
    );
  });
  it('keeps every known sensitivity signal authoritative over a general assessment', () => {
    expect(postSafetyClassification({ ...post, hashtags: ['nsfw'] }, approved())).toBe('mature');
    expect(
      postSafetyClassification(
        { ...post, federation: { spoilerText: 'Graphic content' } },
        approved(),
      ),
    ).toBe('mature');
    expect(postSafetyClassification({ ...post, metadata: { isSensitive: true } }, approved())).toBe(
      'mature',
    );
  });
  it('invalidates stale evidence after text, media, language rendition or reference edits', () => {
    const changes: SafetyMaterialPost[] = [
      { ...post, content: { variants: [{ source: 'author', text: 'Changed body.' }] } },
      { ...post, content: { ...content, media: [{ id: 'new-file', type: 'image' }] } },
      {
        ...post,
        content: {
          variants: [
            ...(content.variants ?? []),
            { source: 'author', tag: 'es', text: 'Otro texto.' },
          ],
        },
      },
      { ...post, quoteOf: 'different-quote' },
      { ...post, parentPostId: 'different-parent' },
    ];
    for (const changed of changes)
      expect(postSafetyClassification(changed, approved())).toBe('unrated');
  });
  it('assesses complete bounded articles and poll choices without binding changing vote totals', () => {
    const withPoll = {
      ...post,
      content: {
        ...content,
        article: { title: 'Gardening', body: 'Plant a tree.' },
        poll: {
          question: 'Which tree?',
          options: ['Oak', 'Pine'],
          endTime: '2026-11-01',
          votes: {},
          userVotes: {},
        },
      },
    };
    const material = postSafetyMaterial(withPoll);
    expect(material.text).toContain('Plant a tree.');
    expect(material.text).toContain('Pine');
    expect(
      postSafetyMaterial({
        ...withPoll,
        content: {
          ...withPoll.content,
          poll: { ...withPoll.content.poll, votes: { '0': 3 }, userVotes: { person: '0' } },
        },
      }).digest,
    ).toBe(material.digest);
  });
  it('refuses unassessed links, media, incomplete resources and truncation', () => {
    const unassessed: StoredPostContent[] = [
      { variants: [{ source: 'author', text: 'https://example.com' }] },
      { variants: [{ source: 'author', text: '![caption](asset:123)' }] },
      { ...content, media: [{ id: 'video', type: 'video' }] },
      { ...content, pollId: 'poll-without-choices' },
      { ...content, article: { articleId: 'external-body', title: 'Headline' } },
      { variants: [{ source: 'author', text: 'x'.repeat(1001) }] },
    ];
    for (const value of unassessed) expect(postSafetyMaterial({ content: value }).text).toBeNull();
  });
  it('accepts only an explicit strict verdict and preserves uncertainty', () => {
    expect(safetyVerdictSchema.safeParse({ classification: 'safe' }).success).toBe(false);
    expect(
      safetyVerdictSchema.safeParse({ classification: 'general', ignorePolicy: true }).success,
    ).toBe(false);
    expect(postSafetyClassification(post, { ...approved(), rating: 'unrated' })).toBe('unrated');
  });
});
