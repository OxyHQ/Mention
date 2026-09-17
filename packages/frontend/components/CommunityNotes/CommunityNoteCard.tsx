import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiInformationLine, RiLinkM, RiTeamLine, RiThumbDownLine, RiThumbUpLine } from '@oxy.so/bloom/icons';
import type { CommunityNoteRating, CommunityNoteSummary } from '@mention/shared-types';
import { openExternalLink } from '@/utils/openExternalLink';
import { HIT_SLOP_SM } from '@/styles/hitSlop';

interface CommunityNoteCardProps {
  note: CommunityNoteSummary;
  /**
   * `post`: the note as every reader sees it under a post — collapsed body,
   * Sources and "About this note".
   * `rate`: the note as a rater sees it — full body, its sources as links, and
   * the Helpful / Not helpful choice.
   */
  variant?: 'post' | 'rate';
  onPressAbout?: () => void;
  onRate?: (rating: CommunityNoteRating) => void;
}

/** Past this many characters a note collapses to three lines under a post. */
const COLLAPSED_NOTE_CHARS = 140;

/** A source URL as the note prints it: host and path, no scheme or `www.`. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, '');
}

/**
 * A community note — reader-written context under a post (see
 * `@mention/shared-types` `communityNotes.ts`; CrowdSource owns the note).
 *
 * It never names who wrote it: the byline is the community, by design.
 */
export function CommunityNoteCard({ note, variant = 'post', onPressAbout, onRate }: CommunityNoteCardProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  const isRate = variant === 'rate';
  // Measuring rendered lines is unreliable on web (`onTextLayout` does not
  // fire), so "long" is decided by length: past this a note needs 3+ lines at
  // the narrowest column the card renders in.
  const isLong = note.text.length > COLLAPSED_NOTE_CHARS;
  const collapsed = !isRate && !expanded && isLong;

  return (
    <View className="bg-muted gap-2 rounded-2xl p-3">
      {isRate ? (
        <View className="flex-row items-center gap-2">
          <RiTeamLine width={16} height={16} fill={colors.textSecondary} />
          <Text className="text-foreground flex-1 text-[14px] font-semibold">
            {note.status === 'needs_ratings'
              ? t('communityNotes.card.needsRatings', { defaultValue: 'More people need to rate' })
              : t('communityNotes.card.title', { defaultValue: 'Community note' })}
          </Text>
        </View>
      ) : (
        <View>
          <Text className="text-foreground text-[14px] font-bold">
            {t('communityNotes.card.title', { defaultValue: 'Community note' })}
          </Text>
          <Text className="text-muted-foreground text-[12px]">
            {t('communityNotes.card.byline', { defaultValue: 'Written by people on Mention' })}
          </Text>
        </View>
      )}

      <Pressable disabled={!collapsed} onPress={() => setExpanded(true)}>
        <Text className="text-foreground text-[14px] leading-5" numberOfLines={collapsed ? 3 : undefined}>
          {note.text}
        </Text>
        {collapsed ? (
          <Text className="text-primary text-[14px] font-semibold">
            {t('communityNotes.card.more', { defaultValue: 'Show more' })}
          </Text>
        ) : null}
      </Pressable>

      {isRate
        ? note.sourceUrls.map((url) => (
            <Pressable key={url} onPress={() => openExternalLink(url)} hitSlop={HIT_SLOP_SM}>
              <Text className="text-primary text-[14px]" numberOfLines={2}>
                {displayUrl(url)}
              </Text>
            </Pressable>
          ))
        : null}

      {isRate ? (
        note.viewerRating ? (
          <Text className="text-muted-foreground text-[13px]">
            {note.viewerRating === 'helpful'
              ? t('communityNotes.card.ratedHelpful', { defaultValue: 'You rated this note helpful' })
              : t('communityNotes.card.ratedNotHelpful', { defaultValue: 'You rated this note not helpful' })}
          </Text>
        ) : onRate ? (
          <View className="mt-1 flex-row gap-2">
            <Pressable
              onPress={() => onRate?.('not_helpful')}
              className="border-border bg-background flex-1 flex-row items-center justify-center gap-1.5 rounded-full border py-2 active:opacity-70"
            >
              <RiThumbDownLine width={16} height={16} fill={colors.text} />
              <Text className="text-foreground text-[14px] font-semibold">
                {t('communityNotes.card.notHelpful', { defaultValue: 'Not helpful' })}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => onRate?.('helpful')}
              className="border-border bg-background flex-1 flex-row items-center justify-center gap-1.5 rounded-full border py-2 active:opacity-70"
            >
              <RiThumbUpLine width={16} height={16} fill={colors.text} />
              <Text className="text-foreground text-[14px] font-semibold">
                {t('communityNotes.card.helpful', { defaultValue: 'Helpful' })}
              </Text>
            </Pressable>
          </View>
        ) : null
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {note.sourceUrls.length > 0 ? (
            <Pressable
              onPress={() => openExternalLink(note.sourceUrls[0])}
              className="bg-background flex-row items-center gap-1 rounded-full px-3 py-1.5 active:opacity-70"
            >
              <RiLinkM width={14} height={14} fill={colors.text} />
              <Text className="text-foreground text-[13px] font-semibold">
                {note.sourceUrls.length > 1
                  ? t('communityNotes.card.sourcesCount', { defaultValue: 'Sources ({{count}})', count: note.sourceUrls.length })
                  : t('communityNotes.card.source', { defaultValue: 'Source' })}
              </Text>
            </Pressable>
          ) : null}
          {onPressAbout ? (
            <Pressable
              onPress={onPressAbout}
              className="bg-background flex-row items-center gap-1 rounded-full px-3 py-1.5 active:opacity-70"
            >
              <RiInformationLine width={14} height={14} fill={colors.text} />
              <Text className="text-foreground text-[13px] font-semibold">
                {t('communityNotes.card.about', { defaultValue: 'About this note' })}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}
