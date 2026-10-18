import { Screen } from '@oxy.so/bloom/screen';
import { useMemo, useState } from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams, usePathname } from '@/lib/navigation/router';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Text } from '@oxy.so/bloom/typography';
import { useSafeBack } from '@/hooks/useSafeBack';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import { SEO } from '@/components/SEO';
import { WEB_BASE_URL } from '@/config';
import { matchesServerSEOPath, readServerSEO } from '@/lib/seoHandoff';
import { EntityFollowButton } from '@/components/EntityFollowButton';

export default function HashtagScreen() {
  const { tag } = useLocalSearchParams<{ tag: string }>();
  const safeBack = useSafeBack();
  const { t } = useTranslation();

  const hashtag = tag?.replace(/^#/, '') || '';
  const displayTag = `#${hashtag}`;

  const filters = useMemo(() => ({ hashtag }), [hashtag]);

  // The server normalizes the tag (one canonical URL for every spelling)
  // and knows whether any listable post carries it; keep its answer.
  const pathname = usePathname();
  const [initialSEO] = useState(() =>
    Platform.OS === 'web' && typeof document !== 'undefined'
      ? readServerSEO(document, window.location.pathname)
      : undefined,
  );
  const server = initialSEO && matchesServerSEOPath(initialSEO, pathname) ? initialSEO : undefined;

  const listHeader = useMemo(
    () => (
      <View className="px-4 pb-2">
        <View className="flex-row items-center justify-between">
          <Text className="text-[28px] leading-8 font-bold mb-1 font-primary flex-1 text-foreground">
            {displayTag}
          </Text>
          <EntityFollowButton
            entityType="hashtag"
            entityId={hashtag}
            label="Subscribe"
            followingLabel="Subscribed"
          />
        </View>
      </View>
    ),
    [displayTag, hashtag],
  );

  return (
    <Screen
      scroll="auto"
      header={
        <PageHeader
          title={displayTag}
          onBack={() => safeBack()}
          backLabel={t('common.back', { defaultValue: 'Back' })}
        />
      }
    >
      <SEO
        title={
          server?.title ||
          t('seo.hashtag.title', { hashtag: displayTag, defaultValue: '{{hashtag}} - Mention' })
        }
        description={
          server?.description ||
          t('seo.hashtag.description', {
            hashtag: displayTag,
            defaultValue: 'Posts tagged with {{hashtag}} on Mention',
          })
        }
        url={
          server?.url ||
          `${WEB_BASE_URL.replace(/\/$/, '')}/hashtag/${encodeURIComponent(hashtag.toLowerCase())}`
        }
        robots={server?.robots}
        jsonLd={server?.jsonLd}
      />

      <Feed type="hashtag" filters={filters} listHeaderComponent={listHeader} />
    </Screen>
  );
}
