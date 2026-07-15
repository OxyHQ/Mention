import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Loading } from '@oxyhq/bloom/loading';
import { useTheme } from '@oxyhq/bloom/theme';
import { useAuth, OxyAuthPrompt } from '@oxyhq/services';
import { getNormalizedUserHandle } from '@oxyhq/core';
import { Avatar } from '@oxyhq/bloom/avatar';
import { MEDIA_VARIANT_VIDEO_POSTER } from '@mention/shared-types';
import { ThemedView } from '@/components/ThemedView';
import { Header } from '@/components/Header';
import { IconButton, Button } from '@/components/ui/Button';
import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Icon } from '@/lib/icons';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useProfileData } from '@/hooks/useProfileData';
import { displayNameOrHandle } from '@/utils/displayName';
import { api } from '@/utils/api';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('McpOAuthLink');

interface LinkPreviewResponse {
  clientLabel: string;
  bundleId: string;
}

interface LinkCompleteResponse {
  message: string;
  handle: string;
  displayName?: string;
}

function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function LinkBody({ token }: { token: string }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { user } = useAuth();
  const { data: currentUserProfile } = useProfileData(user?.username);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<LinkCompleteResponse | null>(null);
  const [preview, setPreview] = useState<LinkPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api.get<LinkPreviewResponse>('/mcp/bundles/link/preview', { token });
        if (!cancelled) {
          setPreview(response.data ?? null);
        }
      } catch (err) {
        if (!cancelled) {
          setPreviewError(
            t('mcp.link.invalidToken', {
              defaultValue: 'This link is invalid or has expired. Run link-account again from Claude.',
            }),
          );
        }
        logger.warn('MCP link preview failed', { error: err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, t]);

  const accountHandle = useMemo(() => {
    if (!currentUserProfile) return user?.username ? `@${user.username}` : undefined;
    return `@${getNormalizedUserHandle(currentUserProfile)}`;
  }, [currentUserProfile, user?.username]);

  const displayName = useMemo(() => {
    if (!currentUserProfile) return user?.username;
    return displayNameOrHandle(currentUserProfile.name?.displayName, accountHandle ?? '');
  }, [accountHandle, currentUserProfile, user?.username]);

  const handleLink = useCallback(async () => {
    setError(null);
    setSubmitting(true);
    try {
      const response = await api.post<LinkCompleteResponse>('/mcp/bundles/link/complete', { token });
      setDone(response.data ?? null);
    } catch (err) {
      logger.error('MCP link complete failed', { error: err });
      setError(
        t('mcp.link.completeError', {
          defaultValue: "Couldn't link this account. Please try again.",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [token, t]);

  if (previewError) {
    return (
      <View className="flex-1 items-center justify-center px-6 gap-3">
        <Icon name="alert-circle-outline" size={44} color={colors.textSecondary} />
        <Text className="text-base text-foreground text-center">{previewError}</Text>
      </View>
    );
  }

  if (!preview) {
    return (
      <View className="flex-1 items-center justify-center">
        <Loading />
      </View>
    );
  }

  if (done) {
    return (
      <View className="px-6 py-8 gap-4 items-center">
        <Icon name="checkmark-circle" size={52} color={colors.success} />
        <Text className="text-2xl font-bold text-foreground text-center">
          {t('mcp.link.successTitle', { defaultValue: 'Account linked' })}
        </Text>
        <Text className="text-base text-muted-foreground text-center max-w-[360px]">
          {t('mcp.link.successBody', {
            defaultValue:
              '@{{handle}} is now linked to {{client}}. Return to Claude and run switch-account before posting.',
            handle: done.handle.replace(/^@+/, ''),
            client: preview.clientLabel,
          })}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="px-6 py-6 gap-6"
      showsVerticalScrollIndicator={false}
    >
      <View className="items-center gap-3">
        {currentUserProfile ? (
          <Avatar source={currentUserProfile.avatar} size={72} variant={MEDIA_VARIANT_VIDEO_POSTER} />
        ) : (
          <View
            className="w-[72px] h-[72px] rounded-full items-center justify-center"
            style={{ backgroundColor: colors.primary + '1A' }}
          >
            <Icon name="person-outline" size={34} color={colors.primary} />
          </View>
        )}
        <Text className="text-sm font-semibold uppercase text-muted-foreground">
          {t('mcp.link.linkingAs', { defaultValue: 'Linking as' })}
        </Text>
        <Text className="text-3xl font-bold text-foreground text-center">
          {accountHandle ?? t('mcp.link.unknownAccount', { defaultValue: 'Your account' })}
        </Text>
        {displayName ? (
          <Text className="text-base text-muted-foreground text-center">{displayName}</Text>
        ) : null}
      </View>

      <View className="rounded-2xl border border-border px-4 py-4 gap-2">
        <Text className="text-[15px] text-foreground text-center">
          {t('mcp.link.description', {
            defaultValue:
              'This will add your Mention account to the {{client}} connector. You can switch between linked accounts from Claude.',
            client: preview.clientLabel,
          })}
        </Text>
      </View>

      {error ? (
        <View className="flex-row items-start gap-2.5 rounded-xl p-3.5" style={{ backgroundColor: colors.error + '14' }}>
          <Icon name="alert-circle" size={18} color={colors.error} />
          <Text className="flex-1 text-[13px] text-foreground">{error}</Text>
        </View>
      ) : null}

      <View className="gap-3">
        <Button variant="primary" onPress={handleLink} disabled={submitting}>
          {submitting
            ? t('mcp.link.linking', { defaultValue: 'Linking…' })
            : t('mcp.link.confirm', { defaultValue: 'Link to Claude' })}
        </Button>
      </View>
    </ScrollView>
  );
}

export default function McpOAuthLinkScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const safeBack = useSafeBack();
  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();

  const rawParams = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const token = firstParam(rawParams.token);

  const header = (
    <Header
      options={{
        title: t('mcp.link.headerTitle', { defaultValue: 'Link account' }),
        leftComponents: [
          <IconButton variant="icon" key="back" onPress={() => safeBack()}>
            <BackArrowIcon size={20} className="text-foreground" />
          </IconButton>,
        ],
      }}
      hideBottomBorder
      disableSticky
    />
  );

  if (!isAuthResolved || isPrivateApiPending) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center">
          <Loading />
        </View>
      </ThemedView>
    );
  }

  if (!canUsePrivateApi) {
    return (
      <ThemedView className="flex-1">
        {header}
        <OxyAuthPrompt
          label={t('mcp.link.signInRequired', { defaultValue: 'Sign in to link this account' })}
          description={t('mcp.link.signInRequiredDesc', {
            defaultValue: 'Sign in to the Mention account you want to add to Claude.',
          })}
        />
      </ThemedView>
    );
  }

  if (!token) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center px-6 gap-3">
          <Icon name="alert-circle-outline" size={44} color={colors.textSecondary} />
          <Text className="text-base text-foreground text-center">
            {t('mcp.link.missingToken', {
              defaultValue: 'This link is missing required information. Run link-account from Claude again.',
            })}
          </Text>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}
      <LinkBody token={token} />
    </ThemedView>
  );
}
