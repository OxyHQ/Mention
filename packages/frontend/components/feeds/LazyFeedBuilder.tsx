import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { PageHeader } from '@oxy.so/bloom/page-header';
import { Screen } from '@oxy.so/bloom/screen';
import { lazy, Suspense, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { FeedBuilder as FeedBuilderComponent } from './FeedBuilder';

// Both routes share one async boundary, so Metro does not move the editor into
// the startup bundle just because it is used by both create and edit.
const FeedBuilder = lazy(() =>
  import('./FeedBuilder').then((module) => ({ default: module.FeedBuilder })),
);

function BuilderLoading({ editing }: { editing: boolean }) {
  const { t } = useTranslation();
  return (
    <Screen
      header={
        <PageHeader
          title={editing ? t('feeds.builder.editTitle') : t('feeds.builder.createTitle')}
          backLabel={t('common.back', { defaultValue: 'Back' })}
        />
      }
    >
      <FormSkeleton />
    </Screen>
  );
}

export default function LazyFeedBuilder(props: ComponentProps<typeof FeedBuilderComponent>) {
  return (
    <Suspense fallback={<BuilderLoading editing={Boolean(props.feedId)} />}>
      <FeedBuilder {...props} />
    </Suspense>
  );
}
