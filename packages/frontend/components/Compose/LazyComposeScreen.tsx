import { lazy, Suspense } from 'react';
import { Loading } from '@oxy.so/bloom/loading';
import type { ComposeScreenProps } from './ComposeScreen';

// The composer is served by two routes, `/compose` and the `/write` tab. Each
// route is its own async chunk, so a static import from both would make Metro
// share the composer between them and hoist it into `__common`, which every
// page load downloads. Both routes render through this one boundary instead,
// so the composer is a single chunk fetched when someone opens it.
const ComposeScreen = lazy(() => import('./ComposeScreen'));

export default function LazyComposeScreen(props: ComposeScreenProps) {
  return (
    <Suspense fallback={<Loading />}>
      <ComposeScreen {...props} />
    </Suspense>
  );
}
