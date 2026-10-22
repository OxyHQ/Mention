import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Avatar } from '@oxy.so/bloom/avatar';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiArrowDownSLine } from '@oxy.so/bloom/icons/RiArrowDownSLine';
import { RiArrowUpSLine } from '@oxy.so/bloom/icons/RiArrowUpSLine';
import { RiCheckLine } from '@oxy.so/bloom/icons/RiCheckLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiShapesLine } from '@oxy.so/bloom/icons/RiShapesLine';
import { RiStarFill } from '@oxy.so/bloom/icons/RiStarFill';
import { Item } from '@oxy.so/bloom/item';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { Textarea } from '@oxy.so/bloom/textarea';
import { toast } from '@oxy.so/bloom/toast';
import { useTheme } from '@oxy.so/bloom/theme';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { OxyAuthPrompt, useAuth } from '@oxy.so/services/ui/client';
import { clearedFieldsFromAccountUpdate } from '@oxy.so/services/ui/client';
import { createLogger } from '@oxy.so/core/logger';
import {
  accountNameMaxLength,
  getNormalizedUserHandle,
  type AccountNode,
  type UpdateAccountInput,
} from '@oxy.so/core';
import {
  MAX_ACCOUNT_CATEGORIES,
  SELECTABLE_ACCOUNT_CATEGORY_IDS,
  type AccountCategoryId,
} from '@oxy.so/contracts';

import { useSafeBack } from '@/hooks/useSafeBack';
import { EmptyState } from '@/components/common/EmptyState';
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
import { ChannelBylineSettings } from './ChannelBylineSettings';
import { CommunityModerationSettings } from './CommunityModerationSettings';
import {
  type OperatedAccountKind,
  type OperatedAccountSettingsCopy,
  useOperatedAccountSettingsCopy,
} from './operatedAccountSettingsCopy';
import { canDeleteOperatedAccount, useOperatedAccountDeletion } from './useOperatedAccountDeletion';

const settingsLogger = createLogger('OperatedAccountSettings');

interface OperatedAccountSettingsScreenProps {
  kind: OperatedAccountKind;
  /** The account's handle, read by the route from its own segment. */
  handle: string;
}

/**
 * What an OPERATOR can change about a member-operated account — a channel at
 * `/c/<handle>/settings`, a community at `/@<handle>/settings` — from inside
 * Mention. ONE screen for both kinds: they are the same kind of Oxy account with
 * the same profile, so only the sections where they genuinely differ branch.
 *
 * - **Its profile** — name, description, picture and categories — is the
 *   ACCOUNT's, written with the SDK's own `accounts.update`; Oxy alone decides
 *   who may. `/edit-profile` edits the SIGNED-IN user, and neither kind can ever
 *   be signed in as, so this is the one door their profile has.
 * - **What only one kind has**: a channel's byline (Mention's setting, since Oxy
 *   has no concept of it) and a community's moderation (Oxy's members sheet and
 *   Mention's bans).
 * - **Ending it**, for a member Oxy granted `account:delete` — a channel takes
 *   its published posts with it, a community leaves its members' posts theirs.
 *
 * It refuses early rather than showing a form whose every write 403s: the
 * account list already says whether the caller operates this account.
 */
export function OperatedAccountSettingsScreen({
  kind,
  handle,
}: OperatedAccountSettingsScreenProps) {
  const { t } = useTranslation();
  const safeBack = useSafeBack();
  const copy = useOperatedAccountSettingsCopy(kind);
  const {
    user,
    oxyServices,
    canUsePrivateApi,
    isAuthenticated,
    isAuthResolved,
    isPrivateApiPending,
  } = useAuth();

  const header = (
    <PageHeader title={copy.title} onBack={() => safeBack()} backLabel={t('common.back')} />
  );

  // Waits for the cold boot to settle rather than firing while the session is
  // still resolving: an anonymous answer would report "not an operator" for an
  // operator, with nothing to refetch it.
  const readsReady = handle.length > 0 && isAuthResolved && !isPrivateApiPending;

  const { data: accounts = [], isPending: accountsPending } = useQuery<AccountNode[]>({
    queryKey: viewerQueryKeys.operatedAccounts(user?.id),
    queryFn: () => oxyServices.accounts.list(),
    enabled: readsReady && canUsePrivateApi,
  });

  // Matched on the canonical handle rather than on the raw segment, so the one
  // spelling rule the rest of the app uses decides here too.
  const node = useMemo(
    () =>
      accounts.find(
        (account) => account.kind === kind && getNormalizedUserHandle(account.account) === handle,
      ),
    [accounts, kind, handle],
  );

  let body: ReactNode;
  if (!isAuthenticated) {
    body = <OxyAuthPrompt label={copy.signInRequired} description={copy.signInRequiredDesc} />;
  } else if (!readsReady || accountsPending) {
    body = <FormSkeleton />;
  } else if (!node) {
    body = <EmptyState title={copy.operatorOnly} sticker="operatorOnly" />;
  } else {
    body = <OperatedAccountSettingsForm node={node} kind={kind} copy={copy} />;
  }

  return (
    <View className="flex-1">
      {header}
      {body}
    </View>
  );
}

interface OperatedAccountSettingsFormProps {
  node: AccountNode;
  kind: OperatedAccountKind;
  copy: OperatedAccountSettingsCopy;
}

function OperatedAccountSettingsForm({ node, kind, copy }: OperatedAccountSettingsFormProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { user, oxyServices, showBottomSheet } = useAuth();
  const categoryLabel = useAccountCategoryLabel();
  const viewerId = user?.id;
  const accountId = node.accountId;
  const account = node.account;

  // Seeded from the account graph and NOT re-synced from it afterwards: while
  // this form is open it is the only writer, so a sync could only ever overwrite
  // what the operator is in the middle of typing. The stored values are still
  // read on every render for the dirty check, so a save lands and the button
  // settles without anything mirroring state.
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
  const profileChanged =
    trimmedName !== (account.name?.displayName ?? '').trim() ||
    trimmedBio !== (account.bio ?? '').trim() ||
    avatar !== (account.avatar ?? '') ||
    !accountCategoriesEqual(categories, account.accountCategories ?? []);
  // An empty display name is refused rather than sent: at Oxy an empty
  // `displayName` CLEARS the explicit name and falls back to a composed
  // first/last, which neither kind has — so saving one would leave the account
  // with no name at all.
  const canSaveProfile = profileChanged && trimmedName.length > 0;

  // The mutation takes the write INPUT as its variable rather than closing over
  // the form state, because `onSuccess` needs it: which fields the operator
  // EMPTIED is not recoverable from the response (Oxy omits a cleared scalar
  // exactly as it omits an untouched one), so the input is the only witness.
  const profileMutation = useMutation<AccountNode, unknown, UpdateAccountInput>({
    mutationFn: (input) => oxyServices.accounts.update(accountId, input),
    onSuccess: (updated, input) => {
      // The account's name, picture and description are held by more caches
      // than this screen can see — the SDK's user cache behind its page, the
      // operated-accounts list, and a copy embedded in every post that names it.
      // `noteIdentityChanged` is the single authority that reaches all of them.
      // The whole ACCOUNT goes over, not a hand-picked payload: the door picks
      // the fields it carries, so a field added there arrives here already
      // supplied.
      noteIdentityChanged(updated.account, viewerId, {
        cleared: clearedFieldsFromAccountUpdate(input),
      });
      toast.success(copy.profileSaved);
    },
    onError: (error) => {
      settingsLogger.error(copy.profileSaveFailed, error, { accountId, kind });
      toast(getErrorMessage(error, copy.profileSaveFailed), { type: 'error' });
    },
  });

  const deleteMutation = useOperatedAccountDeletion(node, kind, copy);
  const canDelete = canDeleteOperatedAccount(node);

  const openAvatarPicker = useCallback(() => {
    showBottomSheet?.({
      screen: 'FileManagement',
      props: {
        selectMode: true,
        multiSelect: false,
        disabledMimeTypes: ['video/', 'audio/', 'application/pdf'],
        // The picture is public-facing: an anonymous <img> on the account's page
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

  const handleSaveProfile = useCallback(
    () =>
      profileMutation.mutate({
        name: { displayName: trimmedName },
        // `null` is Oxy's documented clear for both; an empty string would store
        // one rather than remove it.
        bio: trimmedBio.length > 0 ? trimmedBio : null,
        avatar: avatar.length > 0 ? avatar : null,
        // Sent whole and IN ORDER, because that is the only shape Oxy accepts:
        // element 0 records the primary, and `[]` is the documented clear.
        accountCategories: categories,
      }),
    [profileMutation, trimmedName, trimmedBio, avatar, categories],
  );

  // Both take the previous list rather than closing over `categories`, so the
  // handlers stay identity-stable and can never apply an edit to a stale one.
  const handleToggleCategory = useCallback(
    (id: AccountCategoryId) =>
      setCategories((current) => toggleAccountCategory(current, id, MAX_ACCOUNT_CATEGORIES)),
    [],
  );
  // "Make primary" IS a re-ordering — the primary is the first element and
  // nothing else records it. A list of at most four needs a verb, not a drag
  // gesture that would be the ONLY way to set the one visible category.
  const handlePromoteCategory = useCallback(
    (id: AccountCategoryId) =>
      setCategories((current) => promoteAccountCategoryToPrimary(current, id)),
    [],
  );

  const handleDelete = useCallback(() => deleteMutation.mutate(), [deleteMutation]);
  const atCategoryCap = categories.length >= MAX_ACCOUNT_CATEGORIES;

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="py-2"
      showsVerticalScrollIndicator={false}
    >
      {/* The SAME controls the create form uses, so the two screens read as one
          flow. Not a `SettingsListGroup`: nothing here is a row to tap. */}
      <View className="px-4 pt-2 pb-4 gap-3">
        <Text className="text-foreground text-lg font-bold">{copy.profile}</Text>

        <View className="flex-row items-center gap-4">
          <Avatar source={avatar || undefined} size={64} variant={MEDIA_VARIANT_AVATAR} />
          <Pressable
            onPress={openAvatarPicker}
            accessibilityRole="button"
            className="bg-muted rounded-full px-4 py-2"
          >
            <Text className="text-foreground text-[14px] font-semibold">
              {t('operatedAccounts.settings.changePicture')}
            </Text>
          </Pressable>
        </View>

        <TextFieldInput
          label={copy.nameLabel}
          placeholder={copy.nameLabel}
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={accountNameMaxLength(kind)}
        />

        <Textarea
          value={bio}
          onChangeText={setBio}
          rows={4}
          placeholder={copy.bioPlaceholder}
          accessibilityLabel={copy.bioLabel}
        />

        <Item
          onPress={canSaveProfile && !profileMutation.isPending ? handleSaveProfile : undefined}
          disabled={!canSaveProfile || profileMutation.isPending}
          title={
            profileMutation.isPending
              ? t('operatedAccounts.settings.saving')
              : t('operatedAccounts.settings.saveProfile')
          }
        />
      </View>

      {/* Categories — what the account IS. The order is the model: element 0 is
          the primary, so the list is shown in its stored order and "Make
          primary" moves a row to the front. */}
      <SettingsListGroup
        title={t('operatedAccounts.settings.categories')}
        footer={copy.categoriesFooter}
      >
        {categories.map((id, index) => {
          // An id from a newer vocabulary keeps its ROW — it counts against the
          // cap at Oxy — but it is never printed raw.
          const label = isKnownAccountCategoryId(id)
            ? categoryLabel(id)
            : t('operatedAccounts.settings.categoryUnavailable');
          return (
            <SettingsListItem
              key={id}
              icon={
                index === 0 ? (
                  <RiStarFill width={20} height={20} fill={colors.primary} />
                ) : (
                  <RiShapesLine width={20} height={20} fill={colors.textSecondary} />
                )
              }
              title={label}
              value={index === 0 ? t('accountCategories.primary') : undefined}
              showChevron={false}
              rightElement={
                <View className="flex-row items-center gap-2">
                  {index > 0 && (
                    <Pressable
                      onPress={() => handlePromoteCategory(id)}
                      accessibilityRole="button"
                      className="bg-muted rounded-full px-3 py-1.5"
                    >
                      <Text className="text-foreground text-[13px] font-semibold">
                        {t('operatedAccounts.settings.makePrimary')}
                      </Text>
                    </Pressable>
                  )}
                  <Pressable
                    onPress={() => handleToggleCategory(id)}
                    accessibilityRole="button"
                    accessibilityLabel={t('operatedAccounts.settings.removeCategory', {
                      category: label,
                    })}
                    className="p-1"
                  >
                    <RiCloseLine width={18} height={18} fill={colors.textSecondary} />
                  </Pressable>
                </View>
              }
            />
          );
        })}

        <SettingsListItem
          icon={<RiAddLine width={20} height={20} fill={colors.textSecondary} />}
          title={t('operatedAccounts.settings.addCategory')}
          description={atCategoryCap ? t('operatedAccounts.settings.categoriesAtCap') : undefined}
          disabled={atCategoryCap}
          showChevron={false}
          rightElement={
            categoryPickerOpen ? (
              <RiArrowUpSLine width={18} height={18} fill={colors.textSecondary} />
            ) : (
              <RiArrowDownSLine width={18} height={18} fill={colors.textSecondary} />
            )
          }
          onPress={atCategoryCap ? undefined : () => setCategoryPickerOpen((open) => !open)}
        />
      </SettingsListGroup>

      {/* Collapsed by default: the vocabulary is a screen of its own. Only
          SELECTABLE ids are offered — a withdrawn one stays readable on an
          account that carries it, but Oxy refuses newly adding it. */}
      {categoryPickerOpen && (
        <SettingsListGroup>
          {SELECTABLE_ACCOUNT_CATEGORY_IDS.map((id) => {
            const selected = categories.includes(id);
            const blocked = !selected && atCategoryCap;
            return (
              <SettingsListItem
                key={id}
                title={categoryLabel(id)}
                showChevron={false}
                disabled={blocked}
                rightElement={
                  selected ? (
                    <RiCheckLine width={20} height={20} fill={colors.primary} />
                  ) : undefined
                }
                onPress={blocked ? undefined : () => handleToggleCategory(id)}
              />
            );
          })}
        </SettingsListGroup>
      )}

      {kind === 'channel' ? (
        <ChannelBylineSettings accountId={accountId} />
      ) : (
        <CommunityModerationSettings accountId={accountId} />
      )}

      {/* Shown only to a member Oxy granted `account:delete`: operating an
          account and ending it are different rights, and offering a row the
          server would refuse is worse than not offering it. */}
      {canDelete && (
        <SettingsListGroup
          title={t('operatedAccounts.settings.dangerZone')}
          footer={copy.deleteFooter}
        >
          <SettingsListItem
            icon={<RiDeleteBinLine width={20} height={20} fill={colors.error} />}
            title={
              deleteMutation.isPending ? t('operatedAccounts.settings.deleting') : copy.deleteRow
            }
            destructive
            showChevron={false}
            disabled={deleteMutation.isPending}
            onPress={deleteMutation.isPending ? undefined : handleDelete}
          />
        </SettingsListGroup>
      )}

      {/* Names what this screen deliberately does NOT own (the handle), so its
          absence reads as a decision rather than as something missing. */}
      <Text className="text-muted-foreground text-[13px] px-4 py-3">{copy.identityFooter}</Text>
    </ScrollView>
  );
}
