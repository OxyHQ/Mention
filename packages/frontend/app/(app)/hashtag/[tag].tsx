import { useMemo, useState } from 'react';
import { Platform } from 'react-native';
import { useLocalSearchParams, usePathname } from '@/lib/navigation/router';
import { Text } from '@oxy.so/bloom/typography';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import { SEO } from '@/components/SEO';
import { WEB_BASE_URL } from '@/config';
import { matchesServerSEOPath, readServerSEO } from '@/lib/seoHandoff';
import { EntityFollowButton } from '@/components/EntityFollowButton';
import { Embed, Group, HStack, Header, VStack, toElement } from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

export default screen(function HashtagScreen() {
  const { tag } = useLocalSearchParams<{ tag: string }>();
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
    () =>
      toElement(
        VStack(
          HStack(
            Embed(
              <Text className="text-[28px] leading-8 font-bold mb-1 font-primary flex-1 text-foreground">
                {displayTag}
              </Text>,
            ),
            Embed(
              <EntityFollowButton
                entityType="hashtag"
                entityId={hashtag}
                label="Subscribe"
                followingLabel="Subscribed"
              />,
            ),
          )
            .align('center')
            .justify('between'),
        )
          .padding('horizontal', 'lg')
          .padding('bottom', 'sm'),
      ),
    [displayTag, hashtag],
  );

  return Group(
    Embed(
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
          `${WEB_BASE_URL.replace(/\/$/, '')}/hashtag/${encodeURIComponent(hashtag.replace(/^#/, '').trim().toLowerCase())}`
        }
        robots={server?.robots ?? (hashtag ? 'index,follow' : 'noindex,follow')}
        jsonLd={server?.jsonLd}
      />,
    ),
    Embed(<Feed type="hashtag" filters={filters} listHeaderComponent={listHeader} />),
  )
    .screenScroll('auto')
    .header(
      Header(displayTag)
        .backLabel(t('common.back', { defaultValue: 'Back' }))
        .inPage(),
    );
});
