import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  MEMBERSHIP_BENEFITS,
  type MembershipTier,
  type MembershipBenefit,
} from '@mention/shared-types/membership';
import { membershipsService } from '@/services/membershipsService';
import { getErrorMessage } from '@/utils/apiError';

import {
  Button as LButton,
  Card as LCard,
  HStack,
  RawText,
  Text as LText,
  TextEditor,
  TextField as LTextField,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';

export function MembershipTierEditor({
  communityId,
  tier,
  onChange,
}: {
  communityId: string;
  tier?: MembershipTier;
  onChange: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(tier?.name ?? '');
  const [description, setDescription] = useState(tier?.description ?? '');
  const [benefits, setBenefits] = useState<MembershipBenefit[]>(tier?.benefits ?? ['content_read']);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const labels: Record<MembershipBenefit, string> = {
    content_read: t('memberships.benefitRead', 'Read member content'),
    discussion_write: t('memberships.benefitDiscuss', 'Participate in discussions'),
    polls_vote: t('memberships.benefitVote', 'Vote in polls'),
    media_download: t('memberships.benefitDownload', 'Download private files'),
  };
  const save = async (status?: MembershipTier['status']) => {
    setPending(true);
    setError('');
    try {
      if (tier)
        await membershipsService.updateTier(communityId, tier.id, {
          name: name.trim(),
          description: description.trim(),
          benefits,
          ...(status ? { status } : {}),
        });
      else {
        await membershipsService.createTier(communityId, {
          name: name.trim(),
          description: description.trim(),
          kind: 'paid',
          benefits,
        });
        setName('');
        setDescription('');
      }
      await onChange();
    } catch (failure) {
      setError(
        getErrorMessage(failure, t('memberships.failed', 'The action could not be completed.')),
      );
    } finally {
      setPending(false);
    }
  };
  return toElement(
    LCard(
      VStack(
        RawText(tier ? tier.name : t('memberships.draftTier', 'Plan a paid tier'))
          .weight('semibold')
          .foreground('foreground'),
        LTextField([name, setName], t('memberships.tierName', 'Tier name')).maxLength(120),
        TextEditor([description, setDescription])
          .label(t('memberships.description', 'Description'))
          .maxLength(5000)
          .rows(3),
        MEMBERSHIP_BENEFITS.map((benefit) =>
          LButton(LText(labels[benefit]))
            .size('sm')
            .style(benefits.includes(benefit) ? 'solid' : 'outline')
            .onPress(() =>
              setBenefits((current) =>
                current.includes(benefit)
                  ? current.filter((value) => value !== benefit)
                  : [...current, benefit],
              ),
            )
            .id(benefit),
        ),
        !tier || tier.kind === 'paid'
          ? RawText(
              t(
                'memberships.paidDraftOnly',
                'Saved as a draft. Payment terms and billing must be configured before a paid tier can accept members.',
              ),
            ).foreground('muted')
          : null,
        LButton(LText(t('common.save', 'Save')))
          .disabled(!name.trim() || !benefits.length)
          .loading(pending)
          .onPress(() => {
            void save();
          }),
        tier
          ? HStack(
              tier.kind === 'free' && tier.status !== 'active'
                ? LButton(LText(t('memberships.activate', 'Activate')))
                    .style('outline')
                    .disabled(pending)
                    .onPress(() => {
                      void save('active');
                    })
                : null,
              tier.status !== 'retired'
                ? LButton(LText(t('memberships.retire', 'Stop new memberships')))
                    .style('outline')
                    .disabled(pending)
                    .onPress(() => {
                      void save('retired');
                    })
                : null,
            ).spacing('sm')
          : null,
        error ? RawText(error).foreground('destructive').role('alert') : null,
      )
        .padding('all', 'lg')
        .spacing('md'),
    ),
  );
}
