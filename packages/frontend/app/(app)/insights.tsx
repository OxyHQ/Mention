import type React from 'react';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { useTranslation } from 'react-i18next';
import { SEO } from '@/components/SEO';
import LazyInsightsView from '@/components/insights/LazyInsightsView';

/**
 * The VIEWER's own insights.
 *
 * The dashboard itself lives in `InsightsView`, loaded on demand through
 * `LazyInsightsView`, which a channel's operators render too at
 * `/c/<handle>/insights`. This route is the difference between the two: it
 * names no subject, so every read is about the signed-in account.
 */
const InsightsScreen: React.FC = () => {
  const { t } = useTranslation();

  return (
    <>
      <SEO title={t('seo.insights.title')} description={t('seo.insights.description')} />
      <Screen
        scroll="auto"
        header={
          <PageHeader
            title={t('Insights')}
            presentation="floating"
            backLabel={t('common.back', { defaultValue: 'Back' })}
          />
        }
      >
        <LazyInsightsView />
      </Screen>
    </>
  );
};

export default InsightsScreen;
