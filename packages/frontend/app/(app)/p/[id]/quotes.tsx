import { useMemo } from 'react';
import { useLocalSearchParams, useIsFocused } from '@/lib/navigation/router';
import { useTranslation } from 'react-i18next';
import Feed from '@/components/Feed/Feed';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { SEO } from '@/components/SEO';
import { useSafeBack } from '@/hooks/useSafeBack';

/**
 * The posts quoting a given post — where the "N quotes" count on the post-detail
 * screen leads. Quotes are posts, not actors, so this is a feed screen rather
 * than the user-list sheet that likes and boosts open.
 */
export default function PostQuotesScreen() {
  const isFocused = useIsFocused();
  const { id } = useLocalSearchParams<{ id: string }>();
  const safeBack = useSafeBack();
  const { t } = useTranslation();

  const filters = useMemo(() => ({ postId: String(id) }), [id]);
  const title = t('post.quotes.title', { defaultValue: 'Quotes' });

  return (
    <Screen
      active={isFocused}
      header={
        <PageHeader
          title={title}
          onBack={() => safeBack()}
          backLabel={t('common.back', { defaultValue: 'Back' })}
        />
      }
    >
      <SEO
        title={title}
        description={t('post.quotes.description', {
          defaultValue: 'Posts quoting this post on Mention',
        })}
      />
      <Feed type="quotes" filters={filters} />
    </Screen>
  );
}
