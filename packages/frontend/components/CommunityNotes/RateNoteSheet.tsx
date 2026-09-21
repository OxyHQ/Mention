import React, { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { Checkbox } from '@oxy.so/bloom/checkbox';
import type { CommunityNoteRating } from '@mention/shared-types';
import {
  COMMUNITY_NOTE_HELPFUL_REASONS,
  COMMUNITY_NOTE_NOT_HELPFUL_REASONS,
} from '@mention/shared-types/communityNotes';
import { NoteSheetHeader } from './NoteSheetHeader';

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
  const reasons: readonly string[] = helpful ? COMMUNITY_NOTE_HELPFUL_REASONS : COMMUNITY_NOTE_NOT_HELPFUL_REASONS;

  const labelFor = (reason: string) =>
    t(`communityNotes.rate.reason.${reason}`, {
      defaultValue: REASON_DEFAULTS[reason] ?? reason,
    });

  return (
    <View className="bg-background pb-6">
      <NoteSheetHeader onClose={onClose} />
      <View className="gap-5 px-5">
        <Text className="text-foreground text-[24px] font-bold">
          {helpful
            ? t('communityNotes.rate.helpfulTitle', { defaultValue: 'Why is the community note helpful?' })
            : t('communityNotes.rate.notHelpfulTitle', { defaultValue: 'Why is the community note not helpful?' })}
        </Text>
        <View className="border-border overflow-hidden rounded-2xl border">
          {reasons.map((reason, index) => {
            const checked = selected.includes(reason);
            return (
              <View key={reason} className={index > 0 ? 'border-border border-t px-4 py-3.5' : 'px-4 py-3.5'}>
                <Checkbox
                  label={labelFor(reason)}
                  checked={checked}
                  onCheckedChange={(next) =>
                    setSelected((current) => (next ? [...current, reason] : current.filter((r) => r !== reason)))
                  }
                />
              </View>
            );
          })}
        </View>
        <Button appearance="solid" tone="accent" size="large" disabled={selected.length === 0} onPress={() => onSubmit(selected)}>
          {t('communityNotes.rate.submit', { defaultValue: 'Rate' })}
        </Button>
        <Text className="text-muted-foreground text-center text-[13px]">
          {t('communityNotes.rate.final', { defaultValue: "You won't be able to change or delete your rating." })}
        </Text>
      </View>
    </View>
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
