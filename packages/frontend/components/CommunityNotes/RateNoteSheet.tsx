import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CommunityNoteRating } from '@mention/shared-types';
import {
  COMMUNITY_NOTE_HELPFUL_REASONS,
  COMMUNITY_NOTE_NOT_HELPFUL_REASONS,
} from '@mention/shared-types/communityNotes';
import { NoteSheetHeader } from './NoteSheetHeader';

import {
  Button as LButton,
  Checkbox as LCheckbox,
  Embed,
  RawText,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

interface RateNoteSheetProps {
  rating: CommunityNoteRating;
  onSubmit: (reasons: string[]) => void;
  onClose: () => void;
}

/**
 * Second step of rating: WHY. The reasons are what makes a rating useful to
 * CrowdSource's scoring, so at least one is required. A rating is final.
 */
export function RateNoteSheet({ rating, onSubmit, onClose }: RateNoteSheetProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string[]>([]);
  const helpful = rating === 'helpful';
  const reasons: readonly string[] = helpful
    ? COMMUNITY_NOTE_HELPFUL_REASONS
    : COMMUNITY_NOTE_NOT_HELPFUL_REASONS;

  const labelFor = (reason: string) =>
    t(`communityNotes.rate.reason.${reason}`, {
      defaultValue: REASON_DEFAULTS[reason] ?? reason,
    });

  return toElement(
    VStack(
      Embed(<NoteSheetHeader onClose={onClose} />),
      VStack(
        RawText(
          helpful
            ? t('communityNotes.rate.helpfulTitle', {
                defaultValue: 'Why is the community note helpful?',
              })
            : t('communityNotes.rate.notHelpfulTitle', {
                defaultValue: 'Why is the community note not helpful?',
              }),
        )
          .foreground('foreground')
          .font('24')
          .weight('bold'),
        VStack(
          Embed(
            reasons.map((reason, index) => {
              const checked = selected.includes(reason);
              return toElement(
                VStack(
                  LCheckbox(
                    [
                      checked,
                      (next) =>
                        setSelected((current) =>
                          next ? [...current, reason] : current.filter((r) => r !== reason),
                        ),
                    ],
                    labelFor(reason),
                  ),
                )
                  .padding('horizontal', 'lg')
                  .padding('vertical', '14')
                  .when(index > 0, (v) => v.border('border', 'thin', 'top')),
                reason,
              );
            }),
          ),
        )
          .border('border', 'thin')
          .clipped()
          .corner('lg'),
        LButton(LText(t('communityNotes.rate.submit', { defaultValue: 'Rate' })))
          .style('solid')
          .tint('accent')
          .size('lg')
          .disabled(selected.length === 0)
          .onPress(() => onSubmit(selected)),
        RawText(
          t('communityNotes.rate.final', {
            defaultValue: "You won't be able to change or delete your rating.",
          }),
        )
          .foreground('muted')
          .textAlign('center')
          .font('sm'),
      )
        .padding('horizontal', 'xl')
        .spacing('xl'),
    )
      .padding('bottom', '2xl')
      .background('background'),
  );
}

const REASON_DEFAULTS: Record<string, string> = {
  full_explanation: 'Full explanation',
  relevant: 'Relevant to the post',
  reliable_source: 'Reliable source',
  neutral: 'Neutral or unbiased',
  easy_to_understand: 'Easy to understand',
  incorrect: 'Incorrect information',
  unreliable_source: 'Source is unreliable or missing',
  missing_key_points: 'Misses key points',
  opinion_or_biased: 'Opinion or biased language',
  hard_to_understand: 'Hard to understand',
  not_needed: "The post doesn't need a note",
  other: 'Something else',
};
