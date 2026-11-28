import { InsightsSkeleton } from '@/components/loading/ContentSkeleton';
import { lazy, Suspense } from 'react';
import type { InsightsViewProps } from './InsightsView';

// The insights dashboard is served by two routes, `/insights` and
// `/c/<handle>/insights`. Each route is its own async chunk, so a static import
// from both would make Metro share the dashboard between them and hoist it into
// `__common`, which every page load downloads (13.8 KB of startup JavaScript).
// Both routes render through this one boundary instead, so the dashboard is a
// single chunk fetched when someone opens it.
const InsightsView = lazy(() => import('./InsightsView'));

export default function LazyInsightsView(props: InsightsViewProps) {
  return (
    <Suspense fallback={<InsightsSkeleton />}>
      <InsightsView {...props} />
    </Suspense>
  );
}
