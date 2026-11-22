import { useTranslation } from 'react-i18next';
import { SEO } from '@/components/SEO';
import LazyInsightsView from '@/components/insights/LazyInsightsView';
import { Embed, Group, Header } from '@oxy.so/bloom-language';
import { screen } from '@oxy.so/bloom-language/router';

/**
 * The VIEWER's own insights.
 *
 * The dashboard itself lives in `InsightsView`, loaded on demand through
 * `LazyInsightsView`, which a channel's operators render too at
 * `/c/<handle>/insights`. This route is the difference between the two: it
 * names no subject, so every read is about the signed-in account.
 */
export default screen(function InsightsScreen() {
  const { t } = useTranslation();

  // The SEO tags draw nothing in place (the document's head on the web).
  return Group(
    Embed(<SEO title={t('seo.insights.title')} description={t('seo.insights.description')} />),
    Embed(<LazyInsightsView />),
  )
    .screenScroll('auto')
    .header(
      Header(t('insights.title'))
        .presentation('floating')
        .backLabel(t('common.back', { defaultValue: 'Back' }))
        .inPage(),
    );
});
