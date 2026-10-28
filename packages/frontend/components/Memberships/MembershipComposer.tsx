import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import type { CreateMembershipContentRequest, MembershipTier } from '@mention/shared-types';
import { membershipsService } from '@/services/membershipsService';
import { getErrorMessage } from '@/utils/apiError';

export function MembershipComposer({
  communityId,
  manager,
  parentContentId,
  tiers,
  onCreated,
}: {
  communityId: string;
  manager: boolean;
  parentContentId?: string;
  tiers: MembershipTier[];
  onCreated: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [requiredTierIds, setRequiredTierIds] = useState<string[]>([]);
  const [kind, setKind] = useState<CreateMembershipContentRequest['kind']>('discussion');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [teaser, setTeaser] = useState('');
  const [options, setOptions] = useState('');
  const [attachments, setAttachments] = useState<{ id: string; mime: string; size: number }[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const labels = {
    discussion: t('memberships.discussion', 'Discussion'),
    post: t('memberships.post', 'Post'),
    article: t('memberships.article', 'Article'),
    poll: t('memberships.poll', 'Poll'),
  };
  const pollOptions = options
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  const publish = async () => {
    setPending(true);
    setError('');
    try {
      await membershipsService.createContent(communityId, {
        kind,
        ...(manager && !parentContentId ? { requiredTierIds } : {}),
        mediaIds: attachments.map((file) => file.id),
        body: body.trim(),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(manager && teaser.trim() && !parentContentId ? { teaser: teaser.trim() } : {}),
        ...(parentContentId ? { parentContentId } : {}),
        ...(kind === 'poll'
          ? {
              poll: { options: pollOptions, endsAt: new Date(Date.now() + 86400000).toISOString() },
            }
          : {}),
      });
      setAttachments([]);
      setBody('');
      setTitle('');
      setTeaser('');
      setOptions('');
      await onCreated();
    } catch (failure) {
      setError(
        getErrorMessage(failure, t('memberships.failed', 'The action could not be completed.')),
      );
    } finally {
      setPending(false);
    }
  };
  const attach = async () => {
    setPending(true);
    setError('');
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['image/*', 'video/*', 'audio/*'],
        multiple: false,
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      const file = asset.file ?? new File(asset.uri);
      if (file.size > 40 * 1024 * 1024) {
        setError(t('memberships.fileTooLarge', 'Files must be 40 MB or smaller.'));
        return;
      }
      const media = await membershipsService.upload(
        communityId,
        await file.arrayBuffer(),
        asset.mimeType ?? file.type,
      );
      setAttachments((current) => [...current, media]);
    } catch (failure) {
      setError(
        getErrorMessage(
          failure,
          t('memberships.uploadFailed', 'The private file could not be uploaded.'),
        ),
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <Card>
      <View className="p-4 gap-3">
        <Text className="font-semibold text-foreground">
          {parentContentId
            ? t('memberships.reply', 'Reply to this discussion')
            : t('memberships.write', 'Share with members')}
        </Text>
        {manager && !parentContentId ? (
          <View className="flex-row flex-wrap gap-2">
            {(['discussion', 'post', 'article', 'poll'] as const).map((value) => (
              <Button
                key={value}
                size="sm"
                appearance={kind === value ? 'solid' : 'outline'}
                onPress={() => setKind(value)}
              >
                {labels[value]}
              </Button>
            ))}
          </View>
        ) : null}
        {kind !== 'discussion' ? (
          <TextField>
            <TextFieldInput
              label={t('memberships.contentTitle', 'Title')}
              value={title}
              onChangeText={setTitle}
              maxLength={200}
            />
          </TextField>
        ) : null}
        <Textarea
          accessibilityLabel={t('memberships.body', 'Message for members')}
          value={body}
          onChangeText={setBody}
          maxLength={50000}
          rows={5}
        />
        {manager && !parentContentId ? (
          <Textarea
            accessibilityLabel={t('memberships.teaser', 'Optional public teaser')}
            placeholder={t('memberships.teaser', 'Optional public teaser')}
            value={teaser}
            onChangeText={setTeaser}
            maxLength={1000}
            rows={2}
          />
        ) : null}
        {kind === 'poll' ? (
          <>
            <Textarea
              accessibilityLabel={t('memberships.pollOptions', 'One option per line (2–10)')}
              value={options}
              onChangeText={setOptions}
              maxLength={2010}
              rows={4}
            />
            <Text className="text-muted-foreground">
              {t('memberships.pollDuration', 'Voting stays open for 24 hours.')}
            </Text>
          </>
        ) : null}
        {manager && !parentContentId ? (
          <View className="gap-2">
            <Text className="text-muted-foreground">
              {t('memberships.tiers', 'Membership tiers')}
            </Text>
            <Button
              appearance={requiredTierIds.length === 0 ? 'solid' : 'outline'}
              onPress={() => setRequiredTierIds([])}
            >
              {t('All')}
            </Button>
            {tiers.map((tier) => (
              <Button
                key={tier.id}
                appearance={requiredTierIds.includes(tier.id) ? 'solid' : 'outline'}
                onPress={() =>
                  setRequiredTierIds((current) =>
                    current.includes(tier.id)
                      ? current.filter((id) => id !== tier.id)
                      : [...current, tier.id],
                  )
                }
              >
                {tier.name}
              </Button>
            ))}
          </View>
        ) : null}
        {attachments.map((file, index) => (
          <View key={file.id} className="gap-2">
            <Text className="text-muted-foreground">
              {t('memberships.attached', 'Private attachment {{number}} ready', {
                number: index + 1,
              })}
            </Text>
            <Button
              appearance="plain"
              disabled={pending}
              onPress={() => {
                void (async () => {
                  setPending(true);
                  setError('');
                  try {
                    await membershipsService.discardUpload(communityId, file.id);
                    setAttachments((current) => current.filter((item) => item.id !== file.id));
                  } catch (failure) {
                    setError(
                      getErrorMessage(
                        failure,
                        t('memberships.failed', 'The action could not be completed.'),
                      ),
                    );
                  } finally {
                    setPending(false);
                  }
                })();
              }}
            >
              {t('memberships.removeAction', 'Remove')}
            </Button>
          </View>
        ))}
        <Button
          appearance="outline"
          disabled={pending || attachments.length >= 10}
          onPress={() => {
            void attach();
          }}
        >
          {t('memberships.attach', 'Attach a private file')}
        </Button>
        {error ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {error}
          </Text>
        ) : null}
        <Button
          loading={pending}
          disabled={
            !body.trim() ||
            (kind === 'poll' &&
              (pollOptions.length < 2 ||
                pollOptions.length > 10 ||
                pollOptions.some((value) => value.length > 200)))
          }
          onPress={() => {
            void publish();
          }}
        >
          {t('memberships.publishContent', 'Publish to members')}
        </Button>
      </View>
    </Card>
  );
}
