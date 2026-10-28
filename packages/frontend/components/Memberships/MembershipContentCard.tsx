import { useState } from 'react';
import { Text, View, Linking } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { Textarea } from '@oxy.so/bloom/textarea';
import type { MembershipContent, MembershipBenefit } from '@mention/shared-types';
import { membershipsService } from '@/services/membershipsService';
import { getErrorMessage } from '@/utils/apiError';
import { confirmDestructive } from '@/utils/alerts';

export function MembershipContentCard({
  content,
  viewerId,
  manager,
  benefits,
  onChange,
  onThread,
}: {
  content: MembershipContent;
  viewerId: string;
  manager: boolean;
  benefits: MembershipBenefit[];
  onChange: () => Promise<void>;
  onThread?: () => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<string | null>(null);
  const [reported, setReported] = useState(false);
  const action = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError('');
    try {
      await operation();
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
        {content.title ? (
          <Text className="text-lg font-semibold text-foreground">{content.title}</Text>
        ) : null}
        <Text selectable className="text-foreground">
          {content.body}
        </Text>
        {content.poll ? (
          <View className="gap-2">
            {content.poll.options.map((option) => (
              <Button
                key={option.id}
                appearance={content.poll?.selectedOptionId === option.id ? 'solid' : 'outline'}
                disabled={
                  pending ||
                  !benefits.includes('polls_vote') ||
                  Date.parse(content.poll?.endsAt ?? '') <= Date.now()
                }
                onPress={() => {
                  void action(() => membershipsService.vote(content.id, option.id));
                }}
              >
                {`${option.text} · ${option.votes}`}
              </Button>
            ))}
            <Text className="text-muted-foreground">
              {t('memberships.pollEnds', 'Closes {{date}}', {
                date: new Date(content.poll.endsAt).toLocaleString(),
              })}
            </Text>
          </View>
        ) : null}
        {content.media.map((media, index) => (
          <Button
            key={media.id}
            appearance="outline"
            disabled={pending || !benefits.includes('media_download')}
            onPress={() => {
              void action(async () => {
                const { url } = await membershipsService.download(content.id, media.id);
                // URL exists only for this gesture; never cache it on a row or in query storage.
                await Linking.openURL(url);
              });
            }}
          >
            {t('memberships.openAttachment', 'Open attachment {{number}}', { number: index + 1 })}
          </Button>
        ))}
        <View className="flex-row flex-wrap gap-2">
          {onThread ? (
            <Button size="sm" appearance="plain" onPress={onThread}>
              {t('memberships.discussion', 'Discussion')}
            </Button>
          ) : null}
          <Button
            size="sm"
            appearance="plain"
            disabled={pending || reported}
            onPress={() => setReport('')}
          >
            {reported ? t('memberships.reported', 'Reported') : t('memberships.report', 'Report')}
          </Button>
          {viewerId === content.authorOxyUserId || manager ? (
            <Button
              size="sm"
              appearance="plain"
              disabled={pending}
              onPress={() => {
                void action(async () => {
                  if (
                    await confirmDestructive(
                      t('memberships.remove', 'Remove content?'),
                      t(
                        'memberships.removeHelp',
                        'Members will no longer be able to open this content.',
                      ),
                      t('memberships.removeAction', 'Remove'),
                      t('common.cancel', 'Cancel'),
                    )
                  )
                    await membershipsService.removeContent(content.id);
                });
              }}
            >
              {t('memberships.removeAction', 'Remove')}
            </Button>
          ) : null}
          {manager && viewerId !== content.authorOxyUserId ? (
            <Button
              size="sm"
              appearance="plain"
              disabled={pending}
              onPress={() => {
                void action(async () => {
                  if (
                    await confirmDestructive(
                      t('memberships.revoke', 'Revoke membership?'),
                      t(
                        'memberships.revokeHelp',
                        'This member will lose access and cannot rejoin on their own.',
                      ),
                      t('memberships.revokeAction', 'Revoke membership'),
                      t('common.cancel', 'Cancel'),
                    )
                  )
                    await membershipsService.revoke(content.communityId, content.authorOxyUserId);
                });
              }}
            >
              {t('memberships.revokeAction', 'Revoke membership')}
            </Button>
          ) : null}
        </View>
        {report !== null ? (
          <View className="gap-2">
            <Textarea
              accessibilityLabel={t('memberships.reportReason', 'Reason for report')}
              value={report}
              onChangeText={setReport}
              maxLength={2000}
              rows={3}
            />
            <Button
              disabled={!report.trim() || pending}
              onPress={() => {
                void action(async () => {
                  await membershipsService.report(content.id, report);
                  setReport(null);
                  setReported(true);
                });
              }}
            >
              {t('memberships.sendReport', 'Send report')}
            </Button>
            <Button appearance="plain" onPress={() => setReport(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
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
