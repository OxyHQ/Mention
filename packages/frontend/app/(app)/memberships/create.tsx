import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { displayNameOrHandle } from '@/utils/displayName';
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@oxy.so/services/ui/client';
import { useRouter } from '@/lib/navigation/router';
import { SignInRequired } from '@/components/common/SignInRequired';
import { membershipsService } from '@/services/membershipsService';
import { getErrorMessage } from '@/utils/apiError';

import {
  Button as LButton,
  Embed,
  Header,
  RawText,
  ScrollView,
  Text as LText,
  TextEditor,
  TextField as LTextField,
  toElement,
} from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

export default screen(function CreateMembershipScreen() {
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
  const header = toElement(
    Header(t('memberships.create', 'Create community'))
      .onBack(() => router.back())
      .inPage(),
  );
  if (!canUsePrivateApi)
    return Embed(
      <SignInRequired
        label={t('memberships.signIn', 'Sign in to join a community')}
        description={t(
          'memberships.privateHelp',
          'Only authorized members can read community posts and files.',
        )}
      />,
    ).header(Embed(header));
  return ScrollView(
    RawText(
      t(
        'memberships.createDescription',
        'Build a community with private discussions, articles and polls. Start free; your draft stays unpublished until you activate it.',
      ),
    ).foreground('muted'),
    RawText(t('memberships.owner', 'Community owner')).weight('semibold').foreground('foreground'),
    LButton(LText(t('memberships.myAccount', 'My account')))
      .style(!owner || owner === user?.id ? 'solid' : 'outline')
      .onPress(() => setOwner(null)),
    accounts.data
      ?.filter(
        (account) =>
          account.accountId !== user?.id &&
          ['organization', 'project', 'channel'].includes(account.kind),
      )
      .map((account) =>
        LButton(
          LText(
            displayNameOrHandle(account.account.name?.displayName, account.account.username ?? ''),
          ),
        )
          .style(owner === account.accountId ? 'solid' : 'outline')
          .onPress(() => setOwner(account.accountId))
          .id(account.accountId),
      ),
    LTextField([name, setName], t('memberships.name', 'Community name')).maxLength(120),
    LTextField([slug, setSlug], t('memberships.slug', 'Community handle'))
      .autocapitalize('none')
      .maxLength(80),
    TextEditor([description, setDescription])
      .label(t('memberships.description', 'Description'))
      .placeholder(t('memberships.description', 'Description'))
      .maxLength(5000)
      .rows(5),
    RawText(
      t(
        'memberships.visibilityHelp',
        'Community name and description can be shared publicly, independently of your profile privacy. Posts and files are only available to authorized members.',
      ),
    ).foreground('muted'),
    LButton(
      LText(
        visibility === 'public'
          ? t('memberships.public', 'Public community')
          : t('memberships.unlisted', 'Unlisted community'),
      ),
    )
      .style('outline')
      .onPress(() => setVisibility(visibility === 'public' ? 'unlisted' : 'public')),
    mutation.isError
      ? RawText(
          getErrorMessage(
            mutation.error,
            t('memberships.failed', 'The action could not be completed.'),
          ),
        )
          .foreground('destructive')
          .role('alert')
      : null,
    LButton(LText(t('memberships.createDraft', 'Create draft')))
      .disabled(!name.trim() || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length < 3)
      .loading(mutation.isPending)
      .onPress(() => mutation.mutate()),
  )
    .contentMargins('lg')
    .spacing('lg')
    .header(Embed(header));
});
