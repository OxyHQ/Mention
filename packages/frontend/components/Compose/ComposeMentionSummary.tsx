import React, { memo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useProfileLinkMentions } from '@/hooks/useProfileLinkMentions';
import { reconcileMentionData, type MentionData } from '@/utils/mentions';

interface ComposeMentionSummaryProps {
  /**
   * Every rendition the author wrote for THIS post — its primary body first, then
   * its language variants. All of them can name somebody, and the post's mentions
   * are their union, so the summary has to read all of them or it under-states
   * the post it describes.
   */
  texts: readonly string[];
  /** The post's mention registry, as the composer holds it. */
  mentions: readonly MentionData[];
}

/**
 * WHO THIS POST WILL MENTION, SAID OUT LOUD BEFORE IT IS SENT.
 *
 * A mention is not decoration: the id lands in `post.mentions`, which puts the
 * post in that person's mentions feed and notifies them. For a mention picked
 * from the picker the author can at least see the `@handle` they inserted. For a
 * mention that came from a PASTED PROFILE LINK there is nothing on screen at all
 * — the body shows a URL — so pasting a link would otherwise ring somebody's
 * phone with the author never having been told. This row is that telling.
 *
 * IT LISTS BOTH SOURCES, DELIBERATELY. Once the post is stored the two are the
 * same thing, and a row that named only the link-derived ones would read as the
 * post's whole recipient list to an author who had also picked somebody — saying
 * less than the truth in the one place whose entire job is to say the truth. So
 * the pasted link does not get a gadget of its own; it becomes one more name in
 * the post's recipient list, which is what it is about to be.
 *
 * IT NEVER REWRITES THE AUTHOR'S TEXT. The URL they typed stays exactly where
 * they typed it. Substituting an `@handle` under their cursor would be a second
 * surprise on top of the one this row exists to remove — and it would make the
 * composer DECIDE the mention rather than describe it, which belongs to the write
 * boundary alone.
 *
 * It says "mention", never "notify": above `MAX_MENTION_NOTIFICATIONS_PER_POST`
 * distinct mentions a post is a broadcast and notifies nobody, so "notify" would
 * be false for exactly the posts that name the most people.
 */
const ComposeMentionSummary = memo<ComposeMentionSummaryProps>(({ texts, mentions }) => {
  const { t } = useTranslation();

  // Only ids that still have a placeholder in one of the bodies. A handle the
  // author deleted is not a recipient, however recently it was picked.
  const picked = reconcileMentionData(texts, mentions);
  const mentionIds = picked.map((mention) => mention.userId);
  const { linkMentions, isResolving } = useProfileLinkMentions(texts, mentionIds);

  const byId = new Map<string, MentionData>();
  for (const mention of [...picked, ...linkMentions]) {
    if (!byId.has(mention.userId)) byId.set(mention.userId, mention);
  }
  const recipients = [...byId.values()];

  if (recipients.length === 0) {
    // Nothing is claimed while a link is still being resolved — the row appears
    // with a name in it or not at all, so it can never assert and then retract.
    return null;
  }

  return (
    <View style={styles.container}>
      <Text className="text-muted-foreground" style={styles.label}>
        {t('compose.mentions.willMention', {
          defaultValue: 'This post will mention',
        })}
      </Text>
      <View style={styles.handles}>
        {recipients.map((recipient) => (
          <Text
            key={recipient.userId}
            className="text-primary"
            style={styles.handle}
            numberOfLines={1}
          >
            @{recipient.username}
          </Text>
        ))}
        {isResolving ? (
          <Text className="text-muted-foreground" style={styles.label}>
            {t('compose.mentions.checkingLinks', { defaultValue: 'checking links…' })}
          </Text>
        ) : null}
      </View>
    </View>
  );
});

ComposeMentionSummary.displayName = 'ComposeMentionSummary';

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 6,
    rowGap: 2,
    paddingTop: 6,
  },
  label: {
    fontSize: 13,
  },
  handles: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: 6,
    rowGap: 2,
    flexShrink: 1,
  },
  handle: {
    fontSize: 13,
    fontWeight: '600',
  },
});

export default ComposeMentionSummary;
