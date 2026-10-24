import type React from 'react';
import { Activity, useState, useEffect, useMemo } from 'react';
import { Screen } from '@oxy.so/bloom/screen';
import { MentionHomeHeader } from '@/components/navigation/MentionHomeHeader';
import { useTranslation } from 'react-i18next';
import { useRouter, useIsFocused } from '@/lib/navigation/router';
import Feed from '@/components/Feed/Feed';
import { useFeedPreferences } from '@/hooks/useFeedPreferences';
import { PRESET_FEEDS } from '@mention/shared-types/mtn/presetFeeds';
import { parseFeedDescriptor } from '@mention/shared-types/mtn/feedDescriptor';
import type { FeedType } from '@mention/shared-types/feed';
import { Tabs, TabsTrigger } from '@oxy.so/bloom/tabs';
import { ScreenReselect } from '@/components/common/ScreenReselect';
import { SEO } from '@/components/SEO';
import { siteStructuredData } from '@mention/shared-types/seo';
import { INSTANCE_LOGO_URL, INSTANCE_NAME, WEB_BASE_URL } from '@/config';
import { useAuth } from '@oxy.so/services/ui/client';

/**
 * The site's own identity (site name and logo in search results). The
 * backend's homepage carries the same; this head replaces it once it loads.
 */
const SITE_STRUCTURED_DATA = siteStructuredData({
  origin: WEB_BASE_URL.replace(/\/$/, ''),
  name: INSTANCE_NAME,
  logoUrl: INSTANCE_LOGO_URL || undefined,
});

type HomeTab = string;

/**
 * A resolved home tab derived from a pinned {@link SavedFeed}. `descriptor` tabs
 * render an inline `<Feed>`; `custom` tabs render the engine timeline.
 *
 * `custom` cannot be folded into `descriptor`: `FeedType` and
 * `FeedDescriptorSource` are two overlapping unions, and the `source as FeedType`
 * cast below type-checks for a source that is not a feed type at all — producing
 * a tab that fetches nothing, at runtime, with no error. A custom feed is scoped
 * by a FILTER, so it takes its own shape.
 */
type HomeTabModel =
  | { key: string; label: string; kind: 'descriptor'; type: FeedType }
  | { key: string; label: string; kind: 'custom'; feedId: string };

/** What the home screen shows before a signed-in layout has loaded. */
const FOR_YOU_TAB: HomeTabModel = {
  key: 'for_you',
  label: '',
  kind: 'descriptor',
  type: 'for_you',
};

const HomeScreen: React.FC = () => {
  const isFocused = useIsFocused();
  const router = useRouter();
  const { t } = useTranslation();
  const { isAuthResolved, canUsePrivateApi, user } = useAuth();
  const [activeTab, setActiveTab] = useState<HomeTab>('for_you');
  // The home tabs ARE the viewer's server-persisted pinned feeds (server order),
  // so pinning in the feeds screen updates the tab bar cross-device. Anonymous
  // viewers get the read-only default (For You).
  // Pinned custom feeds carry only a descriptor; their titles ride along on
  // the same preferences response.
  const { pinnedFeeds, customFeedTitles } = useFeedPreferences();

  const presetById = useMemo(() => new Map(PRESET_FEEDS.map((p) => [p.id, p])), []);

  const homeTabs = useMemo<HomeTabModel[]>(() => {
    return pinnedFeeds
      .filter((sf) => {
        // Belt-and-suspenders: hide viewer-relative presets + custom feeds
        // for anonymous viewers (the hook's anon default already excludes them).
        if (canUsePrivateApi) return true;
        const preset = presetById.get(sf.key);
        return preset ? !preset.requiresAuth : false;
      })
      .map((sf): HomeTabModel => {
        const { source, params } = parseFeedDescriptor(sf.descriptor);
        if (source === 'custom') {
          const feedId = params[0] ?? '';
          return {
            key: sf.key,
            kind: 'custom',
            feedId,
            label: customFeedTitles[feedId] || t('feeds.untitled', { defaultValue: 'Feed' }),
          };
        }
        const preset = presetById.get(sf.key);
        return {
          key: sf.key,
          kind: 'descriptor',
          type: source as FeedType,
          label: preset ? t(preset.labelKey) : sf.descriptor,
        };
      });
  }, [pinnedFeeds, canUsePrivateApi, presetById, customFeedTitles, t]);

  useEffect(() => {
    // Keep the active tab valid as the pinned set changes (e.g. logout removes
    // Following / custom tabs → fall back to the first tab, For You). Only act
    // once auth is RESOLVED so the cold-boot window doesn't fight a session
    // that is about to restore.
    if (!isAuthResolved) return;
    if (homeTabs.length > 0 && !homeTabs.some((tab) => tab.key === activeTab)) {
      setActiveTab(homeTabs[0].key);
    }
  }, [isAuthResolved, homeTabs, activeTab]);

  // Resolve the active tab; fall back to the first tab (For You) if the active
  // key is momentarily stale (the reset effect converges it next render), and
  // to For You itself while a signed-in layout is still loading.
  const currentTab = homeTabs.find((x) => x.key === activeTab) ?? homeTabs[0] ?? FOR_YOU_TAB;

  // Reselecting the screen at its top reloads the tab in front only: a retained
  // tab does not reload behind the reader, or again when it is shown.
  const [reloadKeys, setReloadKeys] = useState<Readonly<Record<string, number>>>({});
  const reloadCurrentTab = () =>
    setReloadKeys((keys) => ({ ...keys, [currentTab.key]: (keys[currentTab.key] ?? 0) + 1 }));
  const reloadKeyFor = (key: string) => reloadKeys[key] ?? 0;

  // Every tab the reader has opened stays mounted, hidden and frozen behind
  // `<Activity>` (its effects — scroll listeners, live updates, observers —
  // are torn down while hidden), so switching back shows its rows and scroll
  // position at once instead of rebuilding the whole list.
  const [visitedTabs, setVisitedTabs] = useState<readonly string[]>([currentTab.key]);
  if (!visitedTabs.includes(currentTab.key)) {
    setVisitedTabs([...visitedTabs, currentTab.key]);
  }
  const mountedTabs = visitedTabs
    .map((key) => (key === currentTab.key ? currentTab : homeTabs.find((x) => x.key === key)))
    .filter((tab): tab is HomeTabModel => Boolean(tab));

  // Feeds that render in both the anon and authed branches (for_you, …) must
  // remount when the auth identity flips so their mount-time fetch re-runs
  // against the now-ready token. Without an identity-scoped key, React
  // reconciles the same element across the anon→authed transition and the feed
  // stays stuck on anonymous (or empty) content. This is the belt-and-suspenders
  // guarantee alongside the auth-keyed initial-fetch effect inside useFeedState.
  const feedIdentity = canUsePrivateApi && user?.id ? user.id : 'anon';
  const composeProps = canUsePrivateApi
    ? { showComposeButton: true, onComposePress: () => router.push('/compose') }
    : {};

  const renderTabFeed = (tab: HomeTabModel) =>
    tab.kind === 'custom' ? (
      <Feed
        key={`custom-${tab.feedId}-${feedIdentity}`}
        type="custom"
        filters={{ customFeedId: tab.feedId }}
        reloadKey={reloadKeyFor(tab.key)}
        {...composeProps}
      />
    ) : (
      <Feed
        key={`${tab.type}-${feedIdentity}`}
        type={tab.type}
        reloadKey={reloadKeyFor(tab.key)}
        {...composeProps}
      />
    );

  return (
    <>
      <SEO
        title={t('seo.home.title')}
        description={t('seo.home.description')}
        jsonLd={SITE_STRUCTURED_DATA}
      />
      <Screen active={isFocused} scroll="auto" header={<MentionHomeHeader />}>
        <ScreenReselect refresh={reloadCurrentTab} />
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          pressOpenTab="reselect"
          variant="underline"
          style={{ height: 38 }}
        >
          {homeTabs.map((tab) => (
            <TabsTrigger
              key={tab.key}
              value={tab.key}
              label={tab.label}
              style={{
                height: 38,
                minWidth: 76,
                paddingLeft: 12,
                paddingRight: 12,
                paddingTop: 0,
                paddingBottom: 0,
              }}
              textStyle={{
                fontSize: 15,
                lineHeight: 18,
                fontWeight: activeTab === tab.key ? '700' : '500',
              }}
            />
          ))}
        </Tabs>
        {mountedTabs.map((tab) => (
          <Activity key={tab.key} mode={tab.key === currentTab.key ? 'visible' : 'hidden'}>
            {renderTabFeed(tab)}
          </Activity>
        ))}
      </Screen>
    </>
  );
};

export default HomeScreen;
