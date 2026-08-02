import React, { useCallback, useMemo, useState } from 'react';
import { ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Avatar } from '@oxyhq/bloom/avatar';
import { SpinnerIcon } from '@oxyhq/bloom/loading';
import { Switch } from '@oxyhq/bloom/switch';
import { toast } from '@oxyhq/bloom/toast';
import { useTheme } from '@oxyhq/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { OxyAuthPrompt, useAuth } from '@oxyhq/services/ui/client';
import { createLogger } from '@oxyhq/core/logger';
import {
  CHANNEL_HANDLE_MAX_LENGTH,
  MAX_CHANNEL_DESCRIPTION_LENGTH,
  MAX_CHANNEL_MEMBERS,
  MAX_CHANNEL_TITLE_LENGTH,
  normalizeChannelHandle,
  type Channel,
  type ChannelMemberSummary,
} from '@mention/shared-types';
import { MEDIA_VARIANT_AVATAR } from '@mention/shared-types/post';

import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { useSafeBack } from '@/hooks/useSafeBack';
import { EmptyState } from '@/components/common/EmptyState';
import { BottomSheetContext } from '@/context/BottomSheetContext';
import { ConfirmBottomSheet } from '@/components/common/ConfirmBottomSheet';
import { channelsService } from '@/services/channelsService';
import { viewerQueryKeys } from '@/lib/viewerQueryKeys';
import { getErrorMessage } from '@/utils/apiError';
import { displayNameOrHandle } from '@/utils/displayName';
import { getNormalizedUserHandle } from '@oxyhq/core';

const channelSettingsLogger = createLogger('ChannelSettings');

/** One profile as the invite search reads it back from Oxy. */
interface InviteCandidate {
  id: string;
  username: string;
  displayName?: string;
  avatar?: string;
}

/**
 * The owner's screen: the channel's profile, who may publish to it, and the one
 * irreversible button.
 *
 * Everything here is owner-only on the SERVER (`canManageChannel`, 403), so this
 * screen never has to be the enforcement — it refuses early because showing a
 * form whose every write 403s is worse than saying so.
 */
export default function ChannelSettingsScreen() {
  const { handle } = useLocalSearchParams<{ handle: string }>();
  const routeHandle = String(handle ?? '');
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const { user, canUsePrivateApi, isAuthenticated, isAuthResolved, isPrivateApiPending } = useAuth();
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

  const readsReady = routeHandle.length > 0 && isAuthResolved && !isPrivateApiPending;

  const {
    data: channel,
    isLoading,
    isError,
    refetch,
  } = useQuery<Channel | null>({
    queryKey: viewerQueryKeys.channel(viewerId, routeHandle),
    queryFn: () => channelsService.get(routeHandle, { authenticated: canUsePrivateApi }),
    enabled: readsReady && canUsePrivateApi,
  });

  if (!isAuthenticated) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <OxyAuthPrompt
          label={t('channels.signInRequired', { defaultValue: 'Sign in to manage your channels' })}
          description={t('channels.signInRequiredDesc', {
            defaultValue: 'A channel is a shared destination people follow without following its authors.',
          })}
        />
      </ThemedView>
    );
  }

  if (isLoading || !readsReady) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <View className="flex-1 items-center justify-center">
          <SpinnerIcon size={28} className="text-primary" />
        </View>
      </ThemedView>
    );
  }

  if (isError || !channel) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <EmptyState
          title={t('channels.notFound', { defaultValue: 'Channel not found' })}
          icon={{ name: 'alert-circle-outline', size: 48 }}
          error={{
            title: t('channels.notFound', { defaultValue: 'Channel not found' }),
            message: t('common.tryAgain', { defaultValue: 'Try again' }),
            onRetry: async () => {
              await refetch();
            },
          }}
        />
      </ThemedView>
    );
  }

  if (channel.ownerOxyUserId !== viewerId) {
    return (
      <ThemedView className="flex-1">
        <Header options={headerOptions} hideBottomBorder disableSticky />
        <EmptyState
          title={t('channels.settings.ownerOnly', {
            defaultValue: 'Only the channel’s owner can manage it',
          })}
          icon={{ name: 'lock-closed-outline', size: 48 }}
        />
      </ThemedView>
    );
  }

  // Keyed on the channel so the form's local state is INITIALIZED from the loaded
  // values at mount rather than synced to them by an effect — a channel that
  // arrives later mounts a fresh form instead of racing the author's typing.
  return (
    <ThemedView className="flex-1">
      <Header options={headerOptions} hideBottomBorder disableSticky />
      <ChannelSettingsForm key={channel.id} channel={channel} routeHandle={routeHandle} />
    </ThemedView>
  );
}

function ChannelSettingsForm({
  channel,
  routeHandle,
}: {
  channel: Channel;
  routeHandle: string;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const queryClient = useQueryClient();
  const { user, oxyServices, canUsePrivateApi } = useAuth();
  const viewerId = user?.id;
  const bottomSheet = React.useContext(BottomSheetContext);

  const [title, setTitle] = useState(channel.title);
  const [handleInput, setHandleInput] = useState(channel.handle);
  const [description, setDescription] = useState(channel.description ?? '');
  const [searchTerm, setSearchTerm] = useState('');
  const [submittedTerm, setSubmittedTerm] = useState('');

  const membersQueryKey = viewerQueryKeys.channelMembers(viewerId, routeHandle);
  const { data: members = [], isPending: membersPending } = useQuery<ChannelMemberSummary[]>({
    queryKey: membersQueryKey,
    queryFn: () => channelsService.listMembers(routeHandle, { authenticated: canUsePrivateApi }),
    enabled: canUsePrivateApi,
  });

  const reportFailure = useCallback(
    (error: unknown, fallback: string) => {
      channelSettingsLogger.error(fallback, error, { channel: routeHandle });
      toast(getErrorMessage(error, fallback), { type: 'error' });
    },
    [routeHandle],
  );

  /**
   * ONE invalidation for the whole channel namespace after any write.
   *
   * A rename changes the key this page is cached under (it is keyed by the URL
   * spelling), membership changes both the member list and `/channels/mine`, and
   * `signPosts` changes how every existing post of this channel renders. Patching
   * each of those by hand is three chances to miss one.
   */
  const refreshChannel = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: viewerQueryKeys.channelsRoot(viewerId) });
  }, [queryClient, viewerId]);

  const updateMutation = useMutation<Channel, unknown, { title?: string; handle?: string; description?: string; signPosts?: boolean }>({
    mutationFn: (body) => channelsService.update(channel.id, body),
    onSuccess: (updated) => {
      refreshChannel();
      toast(t('channels.settings.saved', { defaultValue: 'Channel updated' }), { type: 'success' });
      // A rename moves the channel's URL, and this screen's own path carries the
      // old spelling — replace it rather than leaving a back-stack entry that
      // now 404s.
      if (updated.handle !== routeHandle) {
        router.replace(`/c/${updated.handle}/settings`);
      }
    },
    onError: (error) =>
      reportFailure(error, t('channels.settings.saveFailed', { defaultValue: 'Failed to update the channel' })),
  });

  const inviteMutation = useMutation<void, unknown, InviteCandidate>({
    mutationFn: (candidate) => channelsService.invite(channel.id, candidate.id),
    onSuccess: (_result, candidate) => {
      setSearchTerm('');
      setSubmittedTerm('');
      refreshChannel();
      toast(
        t('channels.settings.invited', {
          user: candidate.username,
          defaultValue: 'Invitation sent to @{{user}}',
        }),
        { type: 'success' },
      );
    },
    onError: (error) =>
      reportFailure(error, t('channels.settings.inviteFailed', { defaultValue: 'Failed to send the invitation' })),
  });

  const removeMutation = useMutation<void, unknown, string>({
    mutationFn: (memberOxyUserId) => channelsService.removeMember(channel.id, memberOxyUserId),
    onSuccess: () => {
      refreshChannel();
      toast(t('channels.settings.removed', { defaultValue: 'Publisher removed' }), { type: 'success' });
    },
    onError: (error) =>
      reportFailure(error, t('channels.settings.removeFailed', { defaultValue: 'Failed to remove that publisher' })),
  });

  const deleteMutation = useMutation<void, unknown, void>({
    mutationFn: () => channelsService.remove(channel.id),
    onSuccess: () => {
      refreshChannel();
      toast(t('channels.settings.deleted', { defaultValue: 'Channel deleted' }), { type: 'success' });
      router.replace('/channels');
    },
    onError: (error) =>
      reportFailure(error, t('channels.settings.deleteFailed', { defaultValue: 'Failed to delete the channel' })),
  });

  const { data: candidates = [], isFetching: searching } = useQuery<InviteCandidate[]>({
    queryKey: viewerQueryKeys.channelInviteSearch(viewerId, submittedTerm),
    enabled: canUsePrivateApi && submittedTerm.length > 0,
    queryFn: async () => {
      const { data: profiles } = await oxyServices.searchProfiles(submittedTerm, { limit: 10 });
      return (profiles ?? []).flatMap((profile: {
        id?: string;
        _id?: string;
        username?: string;
        handle?: string;
        name?: { displayName?: string };
        avatar?: string | null;
      }) => {
        const id = profile.id ?? profile._id ?? '';
        const username = profile.username ?? profile.handle ?? '';
        if (!id || !username) return [];
        return [{
          id,
          username,
          displayName: profile.name?.displayName,
          avatar: profile.avatar ?? undefined,
        }];
      });
    },
  });

  // Ids that already have a live relationship with the channel. An invite for one
  // of them is a 409, so the row says so instead of offering a button that fails.
  const engagedIds = useMemo(
    () =>
      new Set(
        members
          .filter((member) => member.status === 'accepted' || member.status === 'pending')
          .map((member) => member.user.id),
      ),
    [members],
  );

  const atMemberCap = channel.memberCount >= MAX_CHANNEL_MEMBERS;

  const normalizedHandle = normalizeChannelHandle(handleInput);
  const handleIsLegal = normalizedHandle !== null;
  const trimmedTitle = title.trim();
  const isDirty =
    trimmedTitle !== channel.title ||
    normalizedHandle !== channel.handle ||
    description.trim() !== (channel.description ?? '');
  const canSave = isDirty && handleIsLegal && trimmedTitle.length > 0 && !updateMutation.isPending;

  const handleSave = useCallback(() => {
    if (!canSave || normalizedHandle === null) return;
    updateMutation.mutate({
      title: trimmedTitle,
      handle: normalizedHandle,
      description: description.trim(),
    });
  }, [canSave, normalizedHandle, trimmedTitle, description, updateMutation]);

  const handleDelete = useCallback(() => {
    bottomSheet.setBottomSheetContent(
      <ConfirmBottomSheet
        title={t('channels.settings.delete', { defaultValue: 'Delete channel' })}
        message={t('channels.settings.deleteConfirm', {
          channel: channel.title,
          defaultValue:
            'Delete «{{channel}}»? Its posts are released back to the people who wrote them — they stop being channel posts and appear on their authors’ own profiles. The handle becomes free for anyone to take.',
        })}
        confirmText={t('channels.settings.delete', { defaultValue: 'Delete channel' })}
        cancelText={t('common.cancel', { defaultValue: 'Cancel' })}
        destructive
        onConfirm={() => deleteMutation.mutate()}
        onCancel={() => bottomSheet.openBottomSheet(false)}
      />,
    );
    bottomSheet.openBottomSheet(true);
  }, [bottomSheet, t, channel.title, deleteMutation]);

  const handleRemove = useCallback(
    (member: ChannelMemberSummary) => {
      const memberName = displayNameOrHandle(
        member.user.name?.displayName,
        `@${getNormalizedUserHandle(member.user) ?? ''}`,
      );
      bottomSheet.setBottomSheetContent(
        <ConfirmBottomSheet
          title={t('channels.settings.removeMember', { defaultValue: 'Remove publisher' })}
          message={t('channels.settings.removeConfirm', {
            user: memberName,
            defaultValue:
              'Remove {{user}}? They stop being able to publish here. Everything they already published stays in the channel.',
          })}
          confirmText={t('channels.settings.removeMember', { defaultValue: 'Remove publisher' })}
          cancelText={t('common.cancel', { defaultValue: 'Cancel' })}
          destructive
          onConfirm={() => removeMutation.mutate(member.user.id)}
          onCancel={() => bottomSheet.openBottomSheet(false)}
        />,
      );
      bottomSheet.openBottomSheet(true);
    },
    [bottomSheet, t, removeMutation],
  );

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="py-2"
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled">
      <SettingsListGroup title={t('channels.settings.profile', { defaultValue: 'Channel profile' })}>
        <View className="px-4 py-3 gap-3">
          <View className="gap-1">
            <Text className="text-[13px] text-muted-foreground">
              {t('channels.settings.titleLabel', { defaultValue: 'Name' })}
            </Text>
            <TextInput
              className="text-[15px] text-foreground border border-border rounded-xl px-3 py-2.5"
              value={title}
              onChangeText={setTitle}
              maxLength={MAX_CHANNEL_TITLE_LENGTH}
              placeholder={t('channels.settings.titlePlaceholder', { defaultValue: 'Channel name' })}
              placeholderTextColor={colors.textSecondary}
              editable={!updateMutation.isPending}
            />
          </View>

          <View className="gap-1">
            <Text className="text-[13px] text-muted-foreground">
              {t('channels.settings.handleLabel', { defaultValue: 'Handle' })}
            </Text>
            <TextInput
              className="text-[15px] text-foreground border border-border rounded-xl px-3 py-2.5"
              value={handleInput}
              onChangeText={setHandleInput}
              maxLength={CHANNEL_HANDLE_MAX_LENGTH}
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={t('channels.settings.handlePlaceholder', { defaultValue: 'handle' })}
              placeholderTextColor={colors.textSecondary}
              editable={!updateMutation.isPending}
            />
            <Text className="text-[12px] text-muted-foreground">
              {handleIsLegal
                ? t('channels.settings.handleHint', {
                    handle: normalizedHandle,
                    defaultValue: 'The channel will live at /c/{{handle}}. Renaming breaks existing links.',
                  })
                : t('channels.settings.handleInvalid', {
                    defaultValue: '3–30 characters of a–z, 0–9 or _, and not a reserved word.',
                  })}
            </Text>
          </View>

          <View className="gap-1">
            <Text className="text-[13px] text-muted-foreground">
              {t('channels.settings.descriptionLabel', { defaultValue: 'Description' })}
            </Text>
            <TextInput
              className="text-[15px] text-foreground border border-border rounded-xl px-3 py-2.5"
              value={description}
              onChangeText={setDescription}
              maxLength={MAX_CHANNEL_DESCRIPTION_LENGTH}
              multiline
              placeholder={t('channels.settings.descriptionPlaceholder', {
                defaultValue: 'What this channel publishes',
              })}
              placeholderTextColor={colors.textSecondary}
              editable={!updateMutation.isPending}
            />
          </View>

          <TouchableOpacity
            onPress={handleSave}
            disabled={!canSave}
            activeOpacity={0.8}
            accessibilityRole="button"
            className={`items-center justify-center rounded-full py-2.5 ${canSave ? 'bg-primary' : 'bg-border'}`}>
            {updateMutation.isPending ? (
              <SpinnerIcon size={16} className="text-primary-foreground" />
            ) : (
              <Text className="text-primary-foreground text-[13px] font-bold">
                {t('common.save', { defaultValue: 'Save' })}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </SettingsListGroup>

      <SettingsListGroup
        title={t('channels.settings.byline', { defaultValue: 'Byline' })}
        footer={t('channels.settings.signPostsFooter', {
          defaultValue:
            'The channel always signs its posts. With this on, the person who wrote one is named alongside it — with it off, they never leave the server at all.',
        })}>
        <SettingsListItem
          icon={<Ionicons name="person-outline" size={20} color={colors.textSecondary} />}
          title={t('channels.settings.signPosts', { defaultValue: 'Name the writer' })}
          showChevron={false}
          rightElement={
            <Switch
              value={channel.signPosts}
              onValueChange={(value) => updateMutation.mutate({ signPosts: value })}
            />
          }
        />
      </SettingsListGroup>

      <SettingsListGroup
        title={t('channels.settings.publishers', { defaultValue: 'Publishers' })}
        footer={
          atMemberCap
            ? t('channels.settings.atCap', {
                count: MAX_CHANNEL_MEMBERS,
                defaultValue: 'A channel can have at most {{count}} publishers.',
              })
            : undefined
        }>
        <View className="px-4 py-3 flex-row items-center gap-3">
          <Ionicons name="search" size={18} color={colors.textSecondary} />
          <TextInput
            className="flex-1 text-[15px] text-foreground"
            value={searchTerm}
            onChangeText={setSearchTerm}
            onSubmitEditing={() => setSubmittedTerm(searchTerm.trim())}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('channels.settings.searchPlaceholder', {
              defaultValue: 'Find someone to invite',
            })}
            placeholderTextColor={colors.textSecondary}
            editable={!atMemberCap}
          />
          {searching ? <SpinnerIcon size={16} className="text-primary" /> : null}
        </View>

        {candidates.map((candidate) => {
          const alreadyEngaged = engagedIds.has(candidate.id);
          return (
            <View
              key={candidate.id}
              className="px-4 py-2.5 flex-row items-center gap-3 border-t border-border">
              <Avatar source={candidate.avatar} size={32} variant={MEDIA_VARIANT_AVATAR} />
              <View className="flex-1">
                <Text className="text-foreground text-[15px] font-semibold" numberOfLines={1}>
                  {displayNameOrHandle(candidate.displayName, `@${candidate.username}`)}
                </Text>
                <Text className="text-muted-foreground text-[13px]" numberOfLines={1}>
                  {`@${candidate.username}`}
                </Text>
              </View>
              {alreadyEngaged ? (
                <Text className="text-muted-foreground text-[13px]">
                  {t('channels.settings.alreadyInvited', { defaultValue: 'Already invited' })}
                </Text>
              ) : (
                <TouchableOpacity
                  onPress={() => inviteMutation.mutate(candidate)}
                  disabled={inviteMutation.isPending || atMemberCap}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  className="rounded-full bg-primary px-3.5 py-[7px]">
                  <Text className="text-primary-foreground text-[13px] font-bold">
                    {t('channels.settings.invite', { defaultValue: 'Invite' })}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          );
        })}

        {membersPending ? (
          <View className="py-6 items-center">
            <SpinnerIcon size={20} className="text-primary" />
          </View>
        ) : (
          members
            .filter((member) => member.status === 'accepted' || member.status === 'pending')
            .map((member) => (
              <SettingsListItem
                key={member.user.id}
                icon={<Avatar source={member.user.avatar} size={28} variant={MEDIA_VARIANT_AVATAR} />}
                title={displayNameOrHandle(
                  member.user.name?.displayName,
                  `@${getNormalizedUserHandle(member.user) ?? ''}`,
                )}
                description={
                  member.role === 'owner'
                    ? t('channels.roleOwner', { defaultValue: 'Owner' })
                    : member.status === 'pending'
                      ? t('channels.settings.statusPending', { defaultValue: 'Invitation pending' })
                      : t('channels.rolePublisher', { defaultValue: 'Publisher' })
                }
                showChevron={false}
                rightElement={
                  member.role === 'owner' ? undefined : (
                    <TouchableOpacity
                      onPress={() => handleRemove(member)}
                      disabled={removeMutation.isPending}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={t('channels.settings.removeMember', {
                        defaultValue: 'Remove publisher',
                      })}>
                      <Ionicons name="close-circle-outline" size={22} color={colors.error} />
                    </TouchableOpacity>
                  )
                }
              />
            ))
        )}
      </SettingsListGroup>

      <SettingsListGroup>
        <SettingsListItem
          icon={<Ionicons name="trash-outline" size={20} color={colors.error} />}
          title={t('channels.settings.delete', { defaultValue: 'Delete channel' })}
          destructive
          showChevron={false}
          disabled={deleteMutation.isPending}
          onPress={handleDelete}
        />
      </SettingsListGroup>
    </ScrollView>
  );
}
