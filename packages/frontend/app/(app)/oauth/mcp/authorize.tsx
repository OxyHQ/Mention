import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, ScrollView, Platform, Linking } from 'react-native';
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
import { getErrorMessage } from '@/utils/apiError';
import { createScopedLogger } from '@/lib/logger';

const logger = createScopedLogger('McpOAuthAuthorize');

/**
 * Known MCP client ids → human labels. Falls back to the raw client id so an
 * unrecognized (but legitimately registered) client still renders a usable
 * consent screen rather than a blank name.
 */
const KNOWN_MCP_CLIENTS: Record<string, string> = {
  'claude-web': 'Claude',
  claude: 'Claude',
  'claude-desktop': 'Claude',
  'claude-code': 'Claude Code',
  chatgpt: 'ChatGPT',
  cursor: 'Cursor',
};

function resolveClientLabel(clientId: string | undefined): string | undefined {
  if (!clientId) return undefined;
  return KNOWN_MCP_CLIENTS[clientId.toLowerCase()] ?? clientId;
}

/** Response shape from `POST /mcp/oauth/approve`. */
interface ApproveResponse {
  redirectUrl: string;
}

interface McpAuthorizeParams {
  client_id?: string;
  redirect_uri?: string;
  state?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
}

/**
 * Pull the first string value off an expo-router search param (params can be
 * `string | string[]` when a key repeats in the query).
 */
function firstParam(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Send the browser to the client's redirect_uri (native deep link or web URL). */
async function redirectToClient(url: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') {
      window.location.href = url;
    }
    return;
  }
  try {
    await Linking.openURL(url);
  } catch (error) {
    logger.warn('Failed to open client redirect URL', { error });
  }
}

/** Append an OAuth error to the client's redirect_uri, preserving `state`. */
function buildErrorRedirect(redirectUri: string, errorCode: string, state?: string): string | null {
  try {
    const url = new URL(redirectUri);
    url.searchParams.set('error', errorCode);
    if (state) url.searchParams.set('state', state);
    return url.toString();
  } catch {
    return null;
  }
}

function ConsentBody({ params }: { params: Required<Pick<McpAuthorizeParams, 'client_id' | 'redirect_uri'>> & McpAuthorizeParams }) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { user } = useAuth();
  const { data: currentUserProfile } = useProfileData(user?.username);

  const [submitting, setSubmitting] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientLabel = resolveClientLabel(params.client_id) ?? params.client_id;

  const accountHandle = useMemo(() => {
    if (!currentUserProfile) return user?.username ? `@${user.username}` : undefined;
    return `@${getNormalizedUserHandle(currentUserProfile)}`;
  }, [currentUserProfile, user?.username]);

  const displayName = useMemo(() => {
    if (!currentUserProfile) return user?.username;
    return displayNameOrHandle(currentUserProfile.name?.displayName, accountHandle ?? '');
  }, [accountHandle, currentUserProfile, user?.username]);

  const scopes = useMemo(
    () => (params.scope ? params.scope.split(/\s+/).filter(Boolean) : []),
    [params.scope],
  );

  const handleAllow = useCallback(async () => {
    setError(null);
    setSubmitting('allow');
    try {
      const response = await api.post<ApproveResponse>('/mcp/oauth/approve', {
        client_id: params.client_id,
        redirect_uri: params.redirect_uri,
        state: params.state,
        code_challenge: params.code_challenge,
        code_challenge_method: params.code_challenge_method,
        scope: params.scope,
      });
      const redirectUrl = response.data?.redirectUrl;
      if (!redirectUrl) {
        throw new Error('Missing redirectUrl in approve response');
      }
      await redirectToClient(redirectUrl);
    } catch (err) {
      logger.error('MCP OAuth approval failed', { error: err });
      setError(
        getErrorMessage(
          err,
          t('mcp.authorize.approveError', {
            defaultValue: "Couldn't authorize this app. Please try again.",
          }),
        ),
      );
      setSubmitting(null);
    }
  }, [params, t]);

  const handleDeny = useCallback(async () => {
    setSubmitting('deny');
    const errorUrl = buildErrorRedirect(params.redirect_uri, 'access_denied', params.state);
    if (errorUrl) {
      await redirectToClient(errorUrl);
      return;
    }
    // No valid redirect target — nothing to redirect to; just release the button.
    setSubmitting(null);
  }, [params.redirect_uri, params.state]);

  return (
    <ScrollView
      className="flex-1"
      contentContainerClassName="px-6 py-6 gap-6"
      showsVerticalScrollIndicator={false}
    >
      <View className="items-center gap-4">
        <View className="flex-row items-center gap-3">
          {currentUserProfile ? (
            <Avatar source={currentUserProfile.avatar} size={56} variant={MEDIA_VARIANT_VIDEO_POSTER} />
          ) : (
            <View
              className="w-14 h-14 rounded-full items-center justify-center"
              style={{ backgroundColor: colors.primary + '1A' }}
            >
              <Icon name="person-outline" size={26} color={colors.primary} />
            </View>
          )}
          <Icon name="swap-horizontal" size={22} color={colors.textSecondary} />
          <View
            className="w-14 h-14 rounded-full items-center justify-center"
            style={{ backgroundColor: colors.primary + '1A' }}
          >
            <Icon name="sparkles" size={26} color={colors.primary} />
          </View>
        </View>

        <Text className="text-sm font-semibold uppercase text-muted-foreground">
          {t('mcp.authorize.authorizingAs', { defaultValue: 'Authorizing as' })}
        </Text>
        <Text className="text-3xl font-bold text-foreground text-center">
          {accountHandle ?? t('mcp.authorize.unknownAccount', { defaultValue: 'Your account' })}
        </Text>
        {displayName ? (
          <Text className="text-base text-muted-foreground text-center">{displayName}</Text>
        ) : null}

        <Text className="text-2xl font-bold text-foreground text-center pt-2">
          {t('mcp.authorize.title', {
            defaultValue: 'Authorize {{client}}',
            client: clientLabel,
          })}
        </Text>
        <Text className="text-base text-muted-foreground text-center max-w-[360px]">
          {t('mcp.authorize.subtitle', {
            defaultValue:
              '{{client}} wants to connect to your Mention account. Review what it will be able to do.',
            client: clientLabel,
          })}
        </Text>
      </View>

      <View className="rounded-2xl border border-border overflow-hidden">
        <View className="px-4 py-3 border-b border-border">
          <Text className="text-xs font-semibold uppercase text-muted-foreground">
            {t('mcp.authorize.permissionsTitle', { defaultValue: 'This will allow' })}
          </Text>
        </View>
        {scopes.length > 0 ? (
          scopes.map((scope) => (
            <View key={scope} className="flex-row items-center gap-3 px-4 py-3 border-b border-border">
              <Icon name="checkmark-circle" size={18} color={colors.success} />
              <Text className="flex-1 text-[15px] text-foreground">
                {t(`mcp.scopes.${scope}`, { defaultValue: scope })}
              </Text>
            </View>
          ))
        ) : (
          <View className="flex-row items-center gap-3 px-4 py-3">
            <Icon name="checkmark-circle" size={18} color={colors.success} />
            <Text className="flex-1 text-[15px] text-foreground">
              {t('mcp.authorize.defaultScope', {
                defaultValue: 'Access your Mention account on your behalf',
              })}
            </Text>
          </View>
        )}
      </View>

      <View className="flex-row items-start gap-2.5 rounded-xl p-3.5" style={{ backgroundColor: colors.info + '14' }}>
        <Icon name="information-circle" size={18} color={colors.info} />
        <Text className="flex-1 text-[13px] text-foreground">
          {t('mcp.authorize.reviewNotice', {
            defaultValue:
              'You can revoke this access anytime from Settings → Connected AI.',
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
        <Button
          variant="primary"
          onPress={handleAllow}
          disabled={submitting !== null}
        >
          {submitting === 'allow'
            ? t('mcp.authorize.authorizing', { defaultValue: 'Authorizing…' })
            : t('mcp.authorize.allow', { defaultValue: 'Allow' })}
        </Button>
        <Button
          variant="secondary"
          onPress={handleDeny}
          disabled={submitting !== null}
        >
          {t('mcp.authorize.deny', { defaultValue: 'Deny' })}
        </Button>
      </View>
    </ScrollView>
  );
}

export default function McpOAuthAuthorizeScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const safeBack = useSafeBack();
  const { isAuthResolved, canUsePrivateApi, isPrivateApiPending } = useAuth();

  const rawParams = useLocalSearchParams() as Record<string, string | string[] | undefined>;
  const params: McpAuthorizeParams = useMemo(
    () => ({
      client_id: firstParam(rawParams.client_id),
      redirect_uri: firstParam(rawParams.redirect_uri),
      state: firstParam(rawParams.state),
      code_challenge: firstParam(rawParams.code_challenge),
      code_challenge_method: firstParam(rawParams.code_challenge_method),
      scope: firstParam(rawParams.scope),
    }),
    [rawParams],
  );

  const header = (
    <Header
      options={{
        title: t('mcp.authorize.headerTitle', { defaultValue: 'Connect app' }),
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

  // Auth cold-boot: the SSO restore can take several seconds. Hold on a spinner
  // until auth + the private-API bearer resolve.
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
          label={t('mcp.authorize.signInRequired', { defaultValue: 'Sign in to continue' })}
          description={t('mcp.authorize.signInRequiredDesc', {
            defaultValue: 'Sign in to your Mention account to authorize this app.',
          })}
        />
      </ThemedView>
    );
  }

  if (!params.client_id || !params.redirect_uri) {
    return (
      <ThemedView className="flex-1">
        {header}
        <View className="flex-1 items-center justify-center px-6 gap-3">
          <Icon name="alert-circle-outline" size={44} color={colors.textSecondary} />
          <Text className="text-base text-foreground text-center">
            {t('mcp.authorize.invalidRequest', {
              defaultValue: 'This authorization request is missing required information.',
            })}
          </Text>
        </View>
      </ThemedView>
    );
  }

  return (
    <ThemedView className="flex-1">
      {header}
      <ConsentBody
        params={{ ...params, client_id: params.client_id, redirect_uri: params.redirect_uri }}
      />
    </ThemedView>
  );
}
