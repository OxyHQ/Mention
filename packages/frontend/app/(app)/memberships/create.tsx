import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { displayNameOrHandle } from '@/utils/displayName';
import { useState } from 'react';
import { Text } from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { Screen, ScreenScrollView } from '@oxy.so/bloom/screen';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Button } from '@oxy.so/bloom/button';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useRouter } from '@/lib/navigation/router';
import { SignInRequired } from '@/components/common/SignInRequired';
import { membershipsService } from '@/services/membershipsService';
import { getErrorMessage } from '@/utils/apiError';

export default function CreateMembershipScreen() {
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const [owner, setOwner] = useState<string | null>(null);
  const accounts = useQuery({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.accounts.list(),
    enabled: canUsePrivateApi,
  });
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'unlisted'>('public');
  const mutation = useMutation({
    mutationFn: async () => {
      if (!user?.id) throw new Error('Sign in required');
      return membershipsService.create({
        ownerOxyUserId: owner ?? user.id,
        name: name.trim(),
        slug: slug.trim(),
        description: description.trim(),
        visibility,
      });
    },
    onSuccess: (community) => router.replace(`/memberships/${community.id}`),
  });
  const header = (
    <PageHeader title={t('memberships.create', 'Create community')} onBack={() => router.back()} />
  );
  if (!canUsePrivateApi)
    return (
      <Screen header={header}>
        <SignInRequired
          label={t('memberships.signIn', 'Sign in to join a community')}
          description={t(
            'memberships.privateHelp',
            'Only authorized members can read community posts and files.',
          )}
        />
      </Screen>
    );
  return (
    <Screen header={header}>
      <ScreenScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        <Text className="text-muted-foreground">
          {t(
            'memberships.createDescription',
            'Build a community with private discussions, articles and polls. Start free; your draft stays unpublished until you activate it.',
          )}
        </Text>
        <Text className="font-semibold text-foreground">
          {t('memberships.owner', 'Community owner')}
        </Text>
        <Button
          appearance={!owner || owner === user?.id ? 'solid' : 'outline'}
          onPress={() => setOwner(null)}
        >
          {t('memberships.myAccount', 'My account')}
        </Button>
        {accounts.data
          ?.filter(
            (account) =>
              account.accountId !== user?.id &&
              ['organization', 'project', 'channel'].includes(account.kind),
          )
          .map((account) => (
            <Button
              key={account.accountId}
              appearance={owner === account.accountId ? 'solid' : 'outline'}
              onPress={() => setOwner(account.accountId)}
            >
              {displayNameOrHandle(
                account.account.name?.displayName,
                account.account.username ?? '',
              )}
            </Button>
          ))}
        <TextField>
          <TextFieldInput
            label={t('memberships.name', 'Community name')}
            value={name}
            onChangeText={setName}
            maxLength={120}
          />
        </TextField>
        <TextField>
          <TextFieldInput
            label={t('memberships.slug', 'Community handle')}
            value={slug}
            onChangeText={setSlug}
            autoCapitalize="none"
            maxLength={80}
          />
        </TextField>
        <Textarea
          accessibilityLabel={t('memberships.description', 'Description')}
          placeholder={t('memberships.description', 'Description')}
          value={description}
          onChangeText={setDescription}
          maxLength={5000}
          rows={5}
        />
        <Text className="text-muted-foreground">
          {t(
            'memberships.visibilityHelp',
            'Community name and description can be shared publicly, independently of your profile privacy. Posts and files are only available to authorized members.',
          )}
        </Text>
        <Button
          appearance="outline"
          onPress={() => setVisibility(visibility === 'public' ? 'unlisted' : 'public')}
        >
          {visibility === 'public'
            ? t('memberships.public', 'Public community')
            : t('memberships.unlisted', 'Unlisted community')}
        </Button>
        {mutation.isError ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {getErrorMessage(
              mutation.error,
              t('memberships.failed', 'The action could not be completed.'),
            )}
          </Text>
        ) : null}
        <Button
          disabled={!name.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 3}
          loading={mutation.isPending}
          onPress={() => mutation.mutate()}
        >
          {t('memberships.createDraft', 'Create draft')}
        </Button>
      </ScreenScrollView>
    </Screen>
  );
}
