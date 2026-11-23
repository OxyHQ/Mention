import { FormSkeleton } from '@/components/loading/ContentSkeleton';
import { lazy, Suspense, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import type { FeedBuilder as FeedBuilderComponent } from './FeedBuilder';
import { Header, toElement, Embed } from '@oxy.so/bloom-language';

import { screen } from '@oxy.so/bloom-language/router';

// Both routes share one async boundary, so Metro does not move the editor into
// the startup bundle just because it is used by both create and edit.
const FeedBuilder = lazy(() =>
  import('./FeedBuilder').then((module) => ({ default: module.FeedBuilder })),
);

const BuilderLoading = screen(function BuilderLoading({ editing }: { editing: boolean }) {
  const { t } = useTranslation();
  return Embed(<FormSkeleton />).header(
    Embed(
      toElement(
        Header(editing ? t('feeds.builder.editTitle') : t('feeds.builder.createTitle'))
          .backLabel(t('common.back', { defaultValue: 'Back' }))
          .inPage(),
      ),
    ),
  );
});

export default function LazyFeedBuilder(props: ComponentProps<typeof FeedBuilderComponent>) {
  return (
    <Suspense fallback={<BuilderLoading editing={Boolean(props.feedId)} />}>
      <FeedBuilder {...props} />
    </Suspense>
  );
}
