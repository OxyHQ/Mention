import { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import {
  MEMBERSHIP_BENEFITS,
  type MembershipTier,
  type MembershipBenefit,
} from '@mention/shared-types/membership';
import { membershipsService } from '@/services/membershipsService';
import { getErrorMessage } from '@/utils/apiError';

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
  return (
    <Card>
      <View className="p-4 gap-3">
        <Text className="font-semibold text-foreground">
          {tier ? tier.name : t('memberships.draftTier', 'Plan a paid tier')}
        </Text>
        <TextField>
          <TextFieldInput
            label={t('memberships.tierName', 'Tier name')}
            value={name}
            onChangeText={setName}
            maxLength={120}
          />
        </TextField>
        <Textarea
          accessibilityLabel={t('memberships.description', 'Description')}
          value={description}
          onChangeText={setDescription}
          maxLength={5000}
          rows={3}
        />
        {MEMBERSHIP_BENEFITS.map((benefit) => (
          <Button
            key={benefit}
            size="sm"
            appearance={benefits.includes(benefit) ? 'solid' : 'outline'}
            onPress={() =>
              setBenefits((current) =>
                current.includes(benefit)
                  ? current.filter((value) => value !== benefit)
                  : [...current, benefit],
              )
            }
          >
            {labels[benefit]}
          </Button>
        ))}
        {!tier || tier.kind === 'paid' ? (
          <Text className="text-muted-foreground">
            {t(
              'memberships.paidDraftOnly',
              'Saved as a draft. Payment terms and billing must be configured before a paid tier can accept members.',
            )}
          </Text>
        ) : null}
        <Button
          disabled={!name.trim() || !benefits.length}
          loading={pending}
          onPress={() => {
            void save();
          }}
        >
          {t('common.save', 'Save')}
        </Button>
        {tier ? (
          <View className="flex-row gap-2">
            {tier.kind === 'free' && tier.status !== 'active' ? (
              <Button
                appearance="outline"
                disabled={pending}
                onPress={() => {
                  void save('active');
                }}
              >
                {t('memberships.activate', 'Activate')}
              </Button>
            ) : null}
            {tier.status !== 'retired' ? (
              <Button
                appearance="outline"
                disabled={pending}
                onPress={() => {
                  void save('retired');
                }}
              >
                {t('memberships.retire', 'Stop new memberships')}
              </Button>
            ) : null}
          </View>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {error}
          </Text>
        ) : null}
      </View>
    </Card>
  );
}
