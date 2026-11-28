import { DetailSkeleton, FormSkeleton, ListSkeleton } from '@/components/loading/ContentSkeleton';
import { lazy, Suspense, type ComponentProps } from 'react';
import type { ProfileShopProps } from './Commerce/ProfileShop';
import type { OperatedAccountSettingsScreenProps } from './OperatedAccounts/OperatedAccountSettingsScreen';
import type { OperatedAccountsScreenProps } from './OperatedAccounts/OperatedAccountsScreen';
import type { WhoToFollowTabProps } from './WhoToFollowTab';

/**
 * Screens that more than one ROUTE renders, each behind its one async boundary.
 *
 * Expo's web export makes every route file its own async chunk and hoists any
 * module two async chunks share into `__common`, which every page load
 * downloads before anything renders. A screen that two routes import
 * statically is therefore startup JavaScript for every reader. Imported from
 * here instead, each screen is one chunk, fetched when one of its pages opens.
 * The `deferredSources` gate in `bundle-budgets.json` holds them out of the
 * initial chunks. Routes import the boundary, never the screen module itself;
 * a second static importer hoists the screen straight back.
 */
const AccountInfoScreen = lazy(() =>
  import('./AccountInfoScreen').then((module) => ({ default: module.AccountInfoScreen })),
);
const ConnectionsScreen = lazy(() => import('./Profile/ConnectionsScreen'));
const OperatedAccountsScreen = lazy(() =>
  import('./OperatedAccounts/OperatedAccountsScreen').then((module) => ({
    default: module.OperatedAccountsScreen,
  })),
);
const OperatedAccountSettingsScreen = lazy(() =>
  import('./OperatedAccounts/OperatedAccountSettingsScreen').then((module) => ({
    default: module.OperatedAccountSettingsScreen,
  })),
);
const ProfileShop = lazy(() =>
  import('./Commerce/ProfileShop').then((module) => ({ default: module.ProfileShop })),
);
const JobFormFields = lazy(() =>
  import('./Jobs/JobFormFields').then((module) => ({ default: module.JobFormFields })),
);
// One module, so the two tabs are one chunk.
const loadWhoToFollow = () => import('./WhoToFollowTab');
const WhoToFollowTab = lazy(() =>
  loadWhoToFollow().then((module) => ({ default: module.WhoToFollowTab })),
);
const NewUsersTab = lazy(() =>
  loadWhoToFollow().then((module) => ({ default: module.NewUsersTab })),
);

/** `/@<handle>/about` and `/c/<handle>/about`. */
export function LazyAccountInfoScreen(props: ComponentProps<typeof AccountInfoScreen>) {
  return (
    <Suspense fallback={<DetailSkeleton />}>
      <AccountInfoScreen {...props} />
    </Suspense>
  );
}

/** `/@<handle>/connections` and its four aliases (followers, following, ...). */
export function LazyConnectionsScreen() {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <ConnectionsScreen />
    </Suspense>
  );
}

/** `/channels` and `/communities`. */
export function LazyOperatedAccountsScreen(props: OperatedAccountsScreenProps) {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <OperatedAccountsScreen {...props} />
    </Suspense>
  );
}

/** `/c/<handle>/settings` and `/@<handle>/settings`. */
export function LazyOperatedAccountSettingsScreen(props: OperatedAccountSettingsScreenProps) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <OperatedAccountSettingsScreen {...props} />
    </Suspense>
  );
}

/** A person's Shop tab (`ProfileTabs`) and `/c/<handle>/shop`. */
export function LazyProfileShop(props: ProfileShopProps) {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <ProfileShop {...props} />
    </Suspense>
  );
}

/** `/jobs/create` and `/jobs/<id>/edit`; their state lives in `Jobs/jobForm.ts`. */
export function LazyJobFormFields(props: ComponentProps<typeof JobFormFields>) {
  return (
    <Suspense fallback={<FormSkeleton />}>
      <JobFormFields {...props} />
    </Suspense>
  );
}

/** `/explore/who-to-follow` and `/welcome`. */
export function LazyWhoToFollowTab(props: WhoToFollowTabProps) {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <WhoToFollowTab {...props} />
    </Suspense>
  );
}

/** `/explore/who-to-follow/new`. */
export function LazyNewUsersTab() {
  return (
    <Suspense fallback={<ListSkeleton />}>
      <NewUsersTab />
    </Suspense>
  );
}
