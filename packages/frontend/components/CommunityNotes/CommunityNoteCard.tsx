import { tokens } from '@oxy.so/bloom/styles';
import { Pressable } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { RiLinkM } from '@oxy.so/bloom/icons/RiLinkM';
import { RiTeamLine } from '@oxy.so/bloom/icons/RiTeamLine';
import { RiThumbDownLine } from '@oxy.so/bloom/icons/RiThumbDownLine';
import { RiThumbUpLine } from '@oxy.so/bloom/icons/RiThumbUpLine';
import type { CommunityNoteRating, CommunityNoteSummary } from '@mention/shared-types';
import { openExternalLink } from '@/utils/openExternalLink';
import { readerKeys, useReaderFlag } from '@/stores/readerStateStore';

import { Embed, HStack, Icon, RawText, VStack, toElement } from '@oxy.so/bloom-language';

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
export function CommunityNoteCard({
  note,
  variant = 'post',
  onPressAbout,
  onRate,
}: CommunityNoteCardProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  // Held by the NOTE (`readerStateStore`), not the card: in a feed the card is
  // drawn by a recycled row, and a card-held boolean opened the next post's
  // note and folded this one shut after a scroll away and back.
  const [expanded, toggleExpanded] = useReaderFlag(readerKeys.communityNote(note.id));
  const isRate = variant === 'rate';
  // Measuring rendered lines is unreliable on web (`onTextLayout` does not
  // fire), so "long" is decided by length: past this a note needs 3+ lines at
  // the narrowest column the card renders in.
  const isLong = note.text.length > COLLAPSED_NOTE_CHARS;
  const collapsed = !isRate && !expanded && isLong;

  return toElement(
    VStack(
      isRate
        ? HStack(
            Icon(RiTeamLine).size('sm').foreground('muted'),
            RawText(
              note.status === 'needs_ratings'
                ? t('communityNotes.card.needsRatings', {
                    defaultValue: 'More people need to rate',
                  })
                : t('communityNotes.card.title', { defaultValue: 'Community note' }),
            )
              .foreground('foreground')
              .flex('1')
              .font('14')
              .weight('semibold'),
          )
            .align('center')
            .spacing('sm')
        : VStack(
            RawText(t('communityNotes.card.title', { defaultValue: 'Community note' }))
              .foreground('foreground')
              .font('14')
              .weight('bold'),
            RawText(
              t('communityNotes.card.byline', { defaultValue: 'Written by people on Mention' }),
            )
              .foreground('muted')
              .font('xs'),
          ),
      VStack(
        RawText(note.text)
          .foreground('foreground')
          .font('14')
          .leading('20px')
          .lines(collapsed ? 3 : undefined),
        collapsed
          ? RawText(t('communityNotes.card.more', { defaultValue: 'Show more' }))
              .foreground('primary')
              .font('14')
              .weight('semibold')
          : null,
      )
        .disabled(!collapsed)
        .onPress(toggleExpanded),
      Embed(
        isRate
          ? note.sourceUrls.map((url) => (
              <Pressable
                key={url}
                onPress={() => openExternalLink(url)}
                hitSlop={tokens.hitSlop.sm}
              >
                {toElement(RawText(displayUrl(url)).foreground('primary').font('14').lines(2))}
              </Pressable>
            ))
          : null,
      ),
      Embed(
        isRate
          ? note.viewerRating
            ? toElement(
                RawText(
                  note.viewerRating === 'helpful'
                    ? t('communityNotes.card.ratedHelpful', {
                        defaultValue: 'You rated this note helpful',
                      })
                    : t('communityNotes.card.ratedNotHelpful', {
                        defaultValue: 'You rated this note not helpful',
                      }),
                )
                  .foreground('muted')
                  .font('sm'),
              )
            : onRate
              ? toElement(
                  HStack(
                    HStack(
                      Icon(RiThumbDownLine).size('sm').foreground('foreground'),
                      RawText(t('communityNotes.card.notHelpful', { defaultValue: 'Not helpful' }))
                        .foreground('foreground')
                        .font('14')
                        .weight('semibold'),
                    )
                      .padding('vertical', 'sm')
                      .background('background')
                      .border('border', 'thin')
                      .corner('infinite')
                      .flex('1')
                      .align('center')
                      .justify('center')
                      .spacing('6')
                      .when('pressed', (v) => v.opacity('70'))
                      .onPress(() => onRate?.('not_helpful')),
                    HStack(
                      Icon(RiThumbUpLine).size('sm').foreground('foreground'),
                      RawText(t('communityNotes.card.helpful', { defaultValue: 'Helpful' }))
                        .foreground('foreground')
                        .font('14')
                        .weight('semibold'),
                    )
                      .padding('vertical', 'sm')
                      .background('background')
                      .border('border', 'thin')
                      .corner('infinite')
                      .flex('1')
                      .align('center')
                      .justify('center')
                      .spacing('6')
                      .when('pressed', (v) => v.opacity('70'))
                      .onPress(() => onRate?.('helpful')),
                  )
                    .margin('top', 'xs')
                    .spacing('sm'),
                )
              : null
          : toElement(
              HStack(
                note.sourceUrls.length > 0
                  ? HStack(
                      Icon(RiLinkM).size('14').foreground('foreground'),
                      RawText(
                        note.sourceUrls.length > 1
                          ? t('communityNotes.card.sourcesCount', {
                              defaultValue: 'Sources ({{count}})',
                              count: note.sourceUrls.length,
                            })
                          : t('communityNotes.card.source', { defaultValue: 'Source' }),
                      )
                        .foreground('foreground')
                        .font('sm')
                        .weight('semibold'),
                    )
                      .padding('horizontal', 'md')
                      .padding('vertical', '6')
                      .background('background')
                      .corner('infinite')
                      .align('center')
                      .spacing('xs')
                      .when('pressed', (v) => v.opacity('70'))
                      .onPress(() => openExternalLink(note.sourceUrls[0]))
                  : null,
                onPressAbout
                  ? HStack(
                      Icon(RiInformationLine).size('14').foreground('foreground'),
                      RawText(t('communityNotes.card.about', { defaultValue: 'About this note' }))
                        .foreground('foreground')
                        .font('sm')
                        .weight('semibold'),
                    )
                      .padding('horizontal', 'md')
                      .padding('vertical', '6')
                      .background('background')
                      .corner('infinite')
                      .align('center')
                      .spacing('xs')
                      .when('pressed', (v) => v.opacity('70'))
                      .onPress(onPressAbout)
                  : null,
              )
                .wrap()
                .spacing('sm'),
            ),
      ),
    )
      .padding('all', 'md')
      .background('mutedFill')
      .corner('lg')
      .spacing('sm'),
  );
}
