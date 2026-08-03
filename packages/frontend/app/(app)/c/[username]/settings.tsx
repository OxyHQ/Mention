import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar } from '@oxyhq/bloom/avatar';
import { Item } from '@oxyhq/bloom/item';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { Switch } from '@oxyhq/bloom/switch';
import { toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services/ui/client';
import { createLogger } from '@oxyhq/core/logger';
import { getNormalizedUserHandle, type AccountNode } from '@oxyhq/core';
import {
  MAX_ACCOUNT_CATEGORIES,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  type AccountCategoryId,
} from '@oxyhq/contracts';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { EmptyState } from '@/components/common/EmptyState';
import { channelAccountService, type ChannelAccountSettings } from '@/services/channelAccountService';
import { noteIdentityChanged } from '@/lib/actorCache';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { getErrorMessage } from '@/utils/apiError';
import { useAccountCategoryLabel } from '@/hooks/useAccountCategoryLabel';
import {
  accountCategoriesEqual,
  isKnownAccountCategoryId,
  promoteAccountCategoryToPrimary,
  toggleAccountCategory,
} from '@/utils/accountCategories';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';

const channelSettingsLogger = createLogger('ChannelAccountSettings');

/** Same cap the create form applies to a new channel's title. */
const MAX_TITLE_LENGTH = 100;

/**
 * What an OPERATOR can change about a channel from inside Mention.
 *
 * Two groups, owned by two different systems, and the split is the point:
 *
 * - **Its profile** — name, bio and picture — is the ACCOUNT's, so it is written
 *   with the SDK's own `updateAccount` and Oxy alone decides who may. Mention
 *   does not store, mirror or validate any of it. The reason this screen has to
 *   offer it at all is that `/edit-profile` edits the SIGNED-IN user, and a
 *   channel can never be signed in as, so it is the one account whose profile
 *   has no other door.
 * - **Its byline** — whether a post names the person who wrote it — is the one
 *   thing Oxy has no concept of, so it is Mention's, and it goes through
 *   `PUT /profile/settings/:userId`.
 *
 * The handle and the people who may publish as the channel stay at Oxy: the
 * first shares the global username index and the second is the account graph's
 * membership model, and re-implementing either here would be a second surface
 * for the same state.
 *
 * The screen refuses early rather than showing a form whose every write 403s:
 * the account list already says whether the caller operates this channel, so
 * asking is free.
 */
export default function ChannelAccountSettingsScreen() {
  const { username } = useLocalSearchParams<{ username: string }>();
  const routeHandle = String(username ?? '');
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { user, oxyServices, canUsePrivateApi, isAuthenticated, isAuthResolved, isPrivateApiPending } =
    useAuth();
  const viewerId = user?.id;

  const headerOptions = useMemo(
    () => ({
      title: t('channels.settings.title', { defaultValue: 'Channel settings' }),
      leftComponents: [
        <IconButton variant="icon" key="back" onPress={() => safeBack()}>
          <BackArrowIcon size={20} className="text-foreground" />
        </IconButton>,
      ],
    }),
    [t, safeBack],
  );

  // Waits for the cold boot to settle rather than firing while the session is
  // still resolving: an anonymous answer would report "not an operator" for an
  // operator, with nothing to refetch it.
  const readsReady = routeHandle.length > 0 && isAuthResolved && !isPrivateApiPending;

  const { data: accounts = [], isPending: accountsPending } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(viewerId),
    queryFn: () => oxyServices.listAccounts(),
    enabled: readsReady && canUsePrivateApi,
  });

  // Matched on the canonical handle rather than on the raw segment, so the one
  // spelling rule the rest of the app uses decides here too.
  const channel = useMemo(
    () =>
      accounts.find(
        (account) =>
          account.kind === 'channel' && getNormalizedUserHandle(account.account) === routeHandle,
      ),
    [accounts, routeHandle],
  );

  if (!isAuthenticated) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <OxyAuthPrompt
          label={t('channels.signInRequired', { defaultValue: 'Sign in to manage your channels' })}
          description={t('channels.signInRequiredDesc', {
            defaultValue: 'A channel is an account people follow without following the people who write for it.',
          })}
        />
      </ThemedView>
    );
  }

  if (!readsReady || accountsPending) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <View className="flex-1 items-center justify-center">
          <SpinnerIcon size={28} className="text-primary" />
        </View>
      </ThemedView>
    );
  }

  if (!channel) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <EmptyState
          title={t('channels.settings.operatorOnly', {
            defaultValue: 'Only an operator can manage this channel',
          })}
          icon={{ name: 'lock-closed-outline', size: 48 }}
        />
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      <Header options={headerOptions} hideBottomBorder disableSticky />
      <ChannelAccountSettingsForm channel={channel} />
    </ThemedView>
  );
}

function ChannelAccountSettingsForm({ channel }: { channel: AccountNode }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const { user, oxyServices, showBottomSheet } = useAuth();
  const categoryLabel = useAccountCategoryLabel();
  const viewerId = user?.id;
  const accountId = channel.accountId;
  const account = channel.account;

  // The channel's own profile. Seeded from the account graph and NOT re-synced
  // from it afterwards: while this form is open it is the only writer, so a sync
  // could only ever overwrite what the operator is in the middle of typing. The
  // stored values are still read on every render — for the dirty check below —
  // so a save lands and the button settles without anything mirroring state.
  const [displayName, setDisplayName] = useState(account.name?.displayName ?? '');
  const [bio, setBio] = useState(account.bio ?? '');
  const [avatar, setAvatar] = useState(account.avatar ?? '');
  // Seeded VERBATIM, including any id this build cannot name. Dropping an
  // unrecognised one on load would delete — on the next save, silently — a
  // category the owner set from a newer client.
  const [categories, setCategories] = useState<AccountCategoryId[]>(
    account.accountCategories ?? [],
  );
  const [categoryPickerOpen, setCategoryPickerOpen] = useState(false);

  const trimmedName = displayName.trim();
  const trimmedBio = bio.trim();
  const categoriesChanged = !accountCategoriesEqual(categories, account.accountCategories ?? []);
  const profileChanged =
    trimmedName !== (account.name?.displayName ?? '').trim() ||
    trimmedBio !== (account.bio ?? '').trim() ||
    avatar !== (account.avatar ?? '') ||
    categoriesChanged;
  // An empty display name is refused rather than sent: at Oxy an empty
  // `displayName` CLEARS the explicit name and falls back to a composed
  // first/last, which a channel does not have — so saving one would leave the
  // account with no name at all.
  const canSaveProfile = profileChanged && trimmedName.length > 0;

  const settingsQueryKey = viewerQueryKeys.channelAccountSettings(viewerId, accountId);
  const { data: settings, isPending } = useQuery<ChannelAccountSettings>({
    queryKey: settingsQueryKey,
    queryFn: () => channelAccountService.getSettings(accountId),
  });

  const signPostsMutation = useMutation<ChannelAccountSettings, unknown, boolean>({
    mutationFn: (signPosts) => channelAccountService.setSignPosts(accountId, signPosts),
    // Written straight into this screen's own cache: the server already
    // answered, and a refetch would repaint the screen for one boolean.
    onSuccess: (applied) => queryClient.setQueryData(settingsQueryKey, applied),
    onError: (error) => {
      const fallback = t('channels.settings.saveFailed', {
        defaultValue: 'Failed to update the channel',
      });
      channelSettingsLogger.error(fallback, error, { accountId });
      toast(getErrorMessage(error, fallback), { type: 'error' });
    },
  });

  const handleSignPostsChange = useCallback(
    (value: boolean) => signPostsMutation.mutate(value),
    [signPostsMutation],
  );

  const profileMutation = useMutation<AccountNode, unknown, void>({
    mutationFn: () =>
      oxyServices.updateAccount(accountId, {
        name: { displayName: trimmedName },
        // `null` is Oxy's documented clear for both; an empty string would store
        // one rather than remove it.
        bio: trimmedBio.length > 0 ? trimmedBio : null,
        avatar: avatar.length > 0 ? avatar : null,
        // Sent whole and IN ORDER, because that is the only shape Oxy accepts:
        // there is no add/remove verb, and element 0 is what records the
        // primary. `[]` is the documented clear — unlike `bio` and `avatar`,
        // this field is not nullable, since the empty case already has one
        // spelling and a second could only ever disagree with it.
        accountCategories: categories,
      }),
    onSuccess: (updated) => {
      // A channel's name and picture are held by more caches than this screen
      // can see — the SDK's user cache behind its page, the operated-accounts
      // list behind the composer's publish-as picker, and a copy embedded in
      // every post the channel has ever published. `noteIdentityChanged` is the
      // single authority that reaches all of them; writing any one of them from
      // here is how the others get forgotten.
      noteIdentityChanged(
        {
          id: updated.account.id,
          username: updated.account.username,
          name: updated.account.name,
          avatar: updated.account.avatar,
        },
        viewerId,
      );
      toast.success(
        t('channels.settings.profileSaved', { defaultValue: 'Channel updated' }),
      );
    },
    onError: (error) => {
      const fallback = t('channels.settings.profileSaveFailed', {
        defaultValue: 'Failed to update the channel profile',
      });
      channelSettingsLogger.error(fallback, error, { accountId });
      toast(getErrorMessage(error, fallback), { type: 'error' });
    },
  });

  const openAvatarPicker = useCallback(() => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: false,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
        // A channel's picture is public-facing: an anonymous <img> on its page
        // cannot send a bearer token, so a private asset never renders. The
        // picker defaults to `private` and would otherwise DEMOTE an already
        // public picture on re-pick.
        defaultVisibility: 'public',
        afterSelect: 'back',
        onSelect: (file: { id: string; contentType?: string }) => {
          if (!file?.contentType?.startsWith?.('image/')) return;
          setAvatar(file.id);
        },
      },
    });
  }, [showBottomSheet]);

  const handleSaveProfile = useCallback(() => profileMutation.mutate(), [profileMutation]);

  // Both take the previous list rather than closing over `categories`, so the
  // handlers stay identity-stable and can never apply an edit to a stale one.
  const handleToggleCategory = useCallback(
    (id: AccountCategoryId) =>
      setCategories((current) => toggleAccountCategory(current, id, MAX_ACCOUNT_CATEGORIES)),
    [],
  );

  // "Make primary" IS a re-ordering — the primary is the first element and
  // nothing else records it — so this is the whole mechanism, not a shortcut
  // for one. There is deliberately no drag handle: a list of at most four
  // needs a verb, not a gesture, and a gesture would be the ONLY way to set
  // the one field that decides what a reader sees under the channel's name.
  const handlePromoteCategory = useCallback(
    (id: AccountCategoryId) =>
      setCategories((current) => promoteAccountCategoryToPrimary(current, id)),
    [],
  );

  if (isPending) {
    return (
      <View className="flex-1 items-center justify-center">
        <SpinnerIcon size={28} className="text-primary" />
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="py-2"
      showsVerticalScrollIndicator={false}>
      {/* Written with the SAME controls the create-a-channel form uses, so the
          two screens read as one flow rather than two dialects of the same
          three fields. Not a `SettingsListGroup`: nothing here is a row to tap,
          and a group of inputs pretending to be settings rows would put the
          save action somewhere no row can hold it. */}
      <View className="px-4 pt-2 pb-4 gap-3">
        <Text className="text-foreground text-lg font-bold">
          {t('channels.settings.profile', { defaultValue: 'Channel profile' })}
        </Text>

        <View className="flex-row items-center gap-4">
          <Avatar source={avatar || undefined} size={64} variant={MEDIA_VARIANT_AVATAR} />
          <Pressable
            onPress={openAvatarPicker}
            accessibilityRole="button"
            className="bg-secondary rounded-full px-4 py-2">
            <Text className="text-foreground text-[14px] font-semibold">
              {t('channels.settings.changePicture', { defaultValue: 'Change picture' })}
            </Text>
          </Pressable>
        </View>

        <TextInput
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={MAX_TITLE_LENGTH}
          placeholder={t('channels.titlePlaceholder', { defaultValue: 'Channel name' })}
          accessibilityLabel={t('channels.titleLabel', { defaultValue: 'Channel name' })}
          className="bg-secondary text-foreground rounded-2xl px-4 py-3 text-[15px]"
        />

        <TextInput
          value={bio}
          onChangeText={setBio}
          multiline
          textAlignVertical="top"
          placeholder={t('channels.settings.bioPlaceholder', {
            defaultValue: 'What this channel is about',
          })}
          accessibilityLabel={t('channels.settings.bioLabel', {
            defaultValue: 'Channel description',
          })}
          className="bg-secondary text-foreground rounded-2xl px-4 py-3 text-[15px] min-h-[96px]"
        />

        <Item
          onPress={canSaveProfile && !profileMutation.isPending ? handleSaveProfile : undefined}
          disabled={!canSaveProfile || profileMutation.isPending}
          title={
            profileMutation.isPending
              ? t('channels.settings.saving', { defaultValue: 'Saving…' })
              : t('channels.settings.saveProfile', { defaultValue: 'Save changes' })
          }
        />
      </View>

      {/* Categories — what the channel IS. A settings GROUP rather than part of
          the input block above, because every line here is a row to tap.
          The order is the model: element 0 is the primary and there is no
          separate field recording it, so the list is shown in its stored order
          and "Make primary" moves a row to the front. */}
      <SettingsListGroup
        title={t('channels.settings.categories', { defaultValue: 'Categories' })}
        footer={t('channels.settings.categoriesFooter', {
          max: MAX_ACCOUNT_CATEGORIES,
          defaultValue:
            'The first category is the channel’s primary — the only one shown on its profile. The rest appear on its about page. Choose up to {{max}}.',
        })}>
        {categories.map((id, index) => {
          const known = isKnownAccountCategoryId(id);
          // An id from a newer vocabulary keeps its ROW — it counts against the
          // cap at Oxy, so hiding it would leave the owner unable to add a
          // fourth with no visible reason — but it is never printed raw.
          const label = known
            ? categoryLabel(id)
            : t('channels.settings.categoryUnavailable', {
                defaultValue: 'Not available in this version',
              });
          return (
            <SettingsListItem
              key={id}
              icon={
                <Ionicons
                  name={index === 0 ? 'star' : 'pricetags-outline'}
                  size={20}
                  color={index === 0 ? colors.primary : colors.textSecondary}
                />
              }
              title={label}
              value={
                index === 0
                  ? t('accountCategories.primary', { defaultValue: 'Primary' })
                  : undefined
              }
              showChevron={false}
              rightElement={
                <View className="flex-row items-center gap-2">
                  {index > 0 && (
                    <Pressable
                      onPress={() => handlePromoteCategory(id)}
                      accessibilityRole="button"
                      className="bg-secondary rounded-full px-3 py-1.5">
                      <Text className="text-foreground text-[13px] font-semibold">
                        {t('channels.settings.makePrimary', { defaultValue: 'Make primary' })}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => handleToggleCategory(id)}
                    accessibilityRole="button"
                    accessibilityLabel={t('channels.settings.removeCategory', {
                      category: label,
                      defaultValue: `Remove ${label}`,
                    })}
                    className="p-1">
                    <Ionicons name="close" size={18} color={colors.textSecondary} />
                  </Pressable>
                </View>
              }
            />
          );
        })}

        <SettingsListItem
          icon={<Ionicons name="add" size={20} color={colors.textSecondary} />}
          title={t('channels.settings.addCategory', { defaultValue: 'Add a category' })}
          description={
            categories.length >= MAX_ACCOUNT_CATEGORIES
              ? t('channels.settings.categoriesAtCap', {
                  defaultValue: 'Remove one to choose a different category.',
                })
              : undefined
          }
          disabled={categories.length >= MAX_ACCOUNT_CATEGORIES}
          showChevron={false}
          rightElement={
            <Ionicons
              name={categoryPickerOpen ? 'chevron-up' : 'chevron-down'}
              size={18}
              color={colors.textSecondary}
            />
          }
          onPress={
            categories.length >= MAX_ACCOUNT_CATEGORIES
              ? undefined
              : () => setCategoryPickerOpen((open) => !open)
          }
        />
      </SettingsListGroup>

      {/* Collapsed by default: the vocabulary is 46 entries, which is a screen
          of its own between the profile fields and the byline switch. Only
          SELECTABLE ids are offered — a withdrawn one stays readable on an
          account that already carries it, but must never be newly added, and
          Oxy refuses that write anyway. */}
      {categoryPickerOpen && (
        <SettingsListGroup>
          {SELECTABLE_ACCOUNT_CATEGORY_IDS.map((id) => {
            const selected = categories.includes(id);
            const atCap = categories.length >= MAX_ACCOUNT_CATEGORIES;
            return (
              <SettingsListItem
                key={id}
                title={categoryLabel(id)}
                showChevron={false}
                disabled={!selected && atCap}
                rightElement={
                  selected ? (
                    <Ionicons name="checkmark" size={20} color={colors.primary} />
                  ) : undefined
                }
                onPress={!selected && atCap ? undefined : () => handleToggleCategory(id)}
              />
            );
          })}
        </SettingsListGroup>
      )}

      <SettingsListGroup
        title={t('channels.settings.byline', { defaultValue: 'Byline' })}
        footer={t('channels.settings.signPostsFooter', {
          defaultValue:
            'The channel signs its own posts. With this on, the person who wrote one is named alongside it — with it off, they never leave the server at all.',
        })}>
        <SettingsListItem
          icon={<Ionicons name="person-outline" size={20} color={colors.textSecondary} />}
          title={t('channels.settings.signPosts', { defaultValue: 'Name the writer' })}
          showChevron={false}
          rightElement={
            <Switch
              value={settings?.signPosts === true}
              onValueChange={handleSignPostsChange}
              disabled={signPostsMutation.isPending}
            />
          }
        />
      </SettingsListGroup>

      {/* Not a settings group: there is no row here to tap. It names the two
          things this screen deliberately does NOT own, so their absence reads as
          a decision rather than as something that went missing. */}
      <Text className="text-muted-foreground text-[13px] px-4 py-3">
        {t('channels.settings.identityFooter', {
          defaultValue:
            'The channel’s handle and the people who may publish as it belong to the account itself — change them where you manage your Oxy accounts.',
        })}
      </Text>
    </ScrollView>
  );
}
