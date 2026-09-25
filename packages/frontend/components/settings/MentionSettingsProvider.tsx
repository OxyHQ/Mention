import { MentionSettingsContext } from "@/context/MentionSettingsContext";
import { useDialogControl } from "@oxy.so/bloom/dialog";
import { RiAccessibilityLine } from '@oxy.so/bloom/icons/RiAccessibilityLine';
import { RiBroadcastLine } from '@oxy.so/bloom/icons/RiBroadcastLine';
import { RiChat3Line } from '@oxy.so/bloom/icons/RiChat3Line';
import { RiEarthLine } from '@oxy.so/bloom/icons/RiEarthLine';
import { RiEyeOffLine } from '@oxy.so/bloom/icons/RiEyeOffLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiHeartLine } from '@oxy.so/bloom/icons/RiHeartLine';
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { RiListUnordered } from '@oxy.so/bloom/icons/RiListUnordered';
import { RiNotification3Line } from '@oxy.so/bloom/icons/RiNotification3Line';
import { RiPaletteLine } from '@oxy.so/bloom/icons/RiPaletteLine';
import { RiPlayLine } from '@oxy.so/bloom/icons/RiPlayLine';
import { RiSparklingLine } from '@oxy.so/bloom/icons/RiSparklingLine';
import { RiUserLine } from '@oxy.so/bloom/icons/RiUserLine';
import { Loading } from "@oxy.so/bloom/loading";
import {
SettingsModal,
type SettingsNavGroup,
} from "@oxy.so/bloom/settings-modal";
import { useRouter,type Href } from "expo-router";
import {
lazy,
Suspense,
useCallback,
useEffect,
useMemo,
useRef,
useState,
type PropsWithChildren,
} from "react";
import { useTranslation } from "react-i18next";
import {
isSettingsPage,
onSettingsRequest,
SETTINGS_PAGE_IDS,
settingsPageFromRoute,
} from "./settingsRoutes";

const Page0 = lazy(() => import("./pages/account"));
const Page1 = lazy(() => import("./pages/about"));
const Page2 = lazy(() => import("./pages/accessibility"));
const Page3 = lazy(() => import("./pages/appearance"));
const Page4 = lazy(() => import("./pages/connected-ai"));
const Page5 = lazy(() => import("./pages/external-media"));
const Page6 = lazy(() => import("./pages/fediverse/index"));
const Page7 = lazy(() => import("./pages/fediverse/node"));
const Page8 = lazy(() => import("./pages/feed"));
const Page9 = lazy(() => import("./pages/for-you"));
const Page10 = lazy(() => import("./pages/interests"));
const Page11 = lazy(() => import("./pages/language"));
const Page12 = lazy(() => import("./pages/live-presence"));
const Page13 = lazy(() => import("./pages/notifications/subscriptions"));
const Page14 = lazy(() => import("./pages/notifications"));
const Page15 = lazy(() => import("./pages/privacy/blocked"));
const Page16 = lazy(() => import("./pages/privacy/hidden-words"));
const Page17 = lazy(() => import("./pages/privacy/hide-counts"));
const Page18 = lazy(() => import("./pages/privacy/muted-lanes"));
const Page19 = lazy(() => import("./pages/privacy/online-status"));
const Page20 = lazy(() => import("./pages/privacy/profile-visibility"));
const Page21 = lazy(() => import("./pages/privacy/restricted"));
const Page22 = lazy(() => import("./pages/privacy/tags-mentions"));
const Page23 = lazy(() => import("./pages/privacy"));
const Page24 = lazy(() => import("./pages/thread-preferences"));

export { SETTINGS_PAGE_IDS, settingsPageFromRoute };

/** One shared settings surface; pages contain business controls, never chrome or scrollers. */
export function MentionSettingsProvider({ children }: PropsWithChildren) {
  const { t } = useTranslation();
  const router = useRouter();
  const control = useDialogControl();
  const [page, setPage] = useState("account");
  const [openRequest, setOpenRequest] = useState(0);
  const [initialView, setInitialView] = useState<"navigation" | "page">(
    "navigation",
  );
  const active = useRef(false);
  const pendingAction = useRef<(() => void) | null>(null);
  const open = useCallback(
    (next?: string) => {
      setInitialView(next ? "page" : "navigation");
      pendingAction.current = null;
      setPage(next && isSettingsPage(next) ? next : "account");
      active.current = true;
      setOpenRequest((request) => request + 1);
    },
    [control],
  );
  useEffect(() => {
    if (openRequest) control.open();
  }, [openRequest, control]);
  useEffect(() => onSettingsRequest(open), [open]);
  const close = useCallback(() => control.close(), [control]);
  const afterClose = useCallback(
    (action: () => void) => {
      if (!active.current) {
        action();
        return;
      }
      pendingAction.current = action;
      control.close();
    },
    [control],
  );
  const navigate = useCallback(
    (route: string) => {
      const next = settingsPageFromRoute(route);
      if (next) open(next);
      else afterClose(() => router.navigate(route as Href));
    },
    [open, afterClose, router],
  );
  const onClose = useCallback(() => {
    active.current = false;
    const action = pendingAction.current;
    pendingAction.current = null;
    action?.();
  }, []);
  const value = useMemo(
    () => ({ open, close, page, navigate, afterClose }),
    [open, close, page, navigate, afterClose],
  );
  const pages = {
    account: {
      title: t("settings.account.manageAccount", { defaultValue: "Account" }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page0 />
        </Suspense>
      ),
    },
    about: {
      title: t("settings.aboutMention.title", { defaultValue: "About" }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page1 />
        </Suspense>
      ),
    },
    accessibility: {
      title: t("settings.accessibility.title", {
        defaultValue: "Accessibility",
      }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page2 />
        </Suspense>
      ),
    },
    appearance: {
      title: t("settings.appearance", "Appearance"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page3 />
        </Suspense>
      ),
    },
    "connected-ai": {
      title: t("mcp.connections.title", { defaultValue: "Connected AI" }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page4 />
        </Suspense>
      ),
    },
    "external-media": {
      title: t("settings.externalMedia.title", {
        defaultValue: "External media",
      }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page5 />
        </Suspense>
      ),
    },
    fediverse: {
      title: t("fediverse.settings.title"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page6 />
        </Suspense>
      ),
    },
    "fediverse/node": {
      title: t("settings.node.title", { defaultValue: "Your Mention node" }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page7 />
        </Suspense>
      ),
    },
    feed: {
      title: t("settings.feed.title"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page8 />
        </Suspense>
      ),
    },
    "for-you": {
      title: t("feed.tuning.title", { defaultValue: "For You" }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page9 />
        </Suspense>
      ),
    },
    interests: {
      title: t("settings.interests.title", { defaultValue: "Your interests" }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page10 />
        </Suspense>
      ),
    },
    language: {
      title: t("Language"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page11 />
        </Suspense>
      ),
    },
    "live-presence": {
      title: t("settings.livePresence.title", {
        defaultValue: "Live presence",
      }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page12 />
        </Suspense>
      ),
    },
    "notifications/subscriptions": {
      title: t("subscription.list.title", {
        defaultValue: "Activity notifications",
      }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page13 />
        </Suspense>
      ),
    },
    notifications: {
      title: t("settings.notifications.title", {
        defaultValue: "Notifications",
      }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page14 />
        </Suspense>
      ),
    },
    "privacy/blocked": {
      title: t("settings.privacy.blockedProfiles"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page15 />
        </Suspense>
      ),
    },
    "privacy/hidden-words": {
      title: t("settings.privacy.hiddenWords"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page16 />
        </Suspense>
      ),
    },
    "privacy/hide-counts": {
      title: t("settings.privacy.hideAllCounts"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page17 />
        </Suspense>
      ),
    },
    "privacy/muted-lanes": {
      title: t("lanes.muted.title", { defaultValue: "Muted lanes" }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page18 />
        </Suspense>
      ),
    },
    "privacy/online-status": {
      title: t("settings.privacy.onlineStatus"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page19 />
        </Suspense>
      ),
    },
    "privacy/profile-visibility": {
      title: t("settings.privacy.privateProfile"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page20 />
        </Suspense>
      ),
    },
    "privacy/restricted": {
      title: t("settings.privacy.restrictedProfiles"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page21 />
        </Suspense>
      ),
    },
    "privacy/tags-mentions": {
      title: t("settings.privacy.tagsAndMentions"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page22 />
        </Suspense>
      ),
    },
    privacy: {
      title: t("settings.privacy.title"),
      content: (
        <Suspense fallback={<Loading />}>
          <Page23 />
        </Suspense>
      ),
    },
    "thread-preferences": {
      title: t("settings.threadPreferences.title", {
        defaultValue: "Thread preferences",
      }),
      content: (
        <Suspense fallback={<Loading />}>
          <Page24 />
        </Suspense>
      ),
    },
  };
  const groups: SettingsNavGroup[] = [
    {
      key: "personal",
      label: t("settings.title", { defaultValue: "Settings" }),
      items: [
        {
          key: "account",
          page: "account",
          label: pages["account"].title,
          icon: RiUserLine,
        },
        {
          key: "privacy",
          page: "privacy",
          label: pages["privacy"].title,
          icon: RiEyeOffLine,
        },
        {
          key: "notifications",
          page: "notifications",
          label: pages["notifications"].title,
          icon: RiNotification3Line,
        },
        {
          key: "fediverse",
          page: "fediverse",
          label: pages["fediverse"].title,
          icon: RiEarthLine,
        },
        {
          key: "connected-ai",
          page: "connected-ai",
          label: pages["connected-ai"].title,
          icon: RiSparklingLine,
        },
      ],
    },
    {
      key: "preferences",
      label: t("settings.preferences.title", { defaultValue: "Preferences" }),
      items: [
        {
          key: "appearance",
          page: "appearance",
          label: pages["appearance"].title,
          icon: RiPaletteLine,
        },
        {
          key: "accessibility",
          page: "accessibility",
          label: pages["accessibility"].title,
          icon: RiAccessibilityLine,
        },
        {
          key: "feed",
          page: "feed",
          label: pages["feed"].title,
          icon: RiListUnordered,
        },
        {
          key: "for-you",
          page: "for-you",
          label: pages["for-you"].title,
          icon: RiSparklingLine,
        },
        {
          key: "live-presence",
          page: "live-presence",
          label: pages["live-presence"].title,
          icon: RiBroadcastLine,
        },
        {
          key: "interests",
          page: "interests",
          label: pages["interests"].title,
          icon: RiHeartLine,
        },
        {
          key: "external-media",
          page: "external-media",
          label: pages["external-media"].title,
          icon: RiPlayLine,
        },
        {
          key: "thread-preferences",
          page: "thread-preferences",
          label: pages["thread-preferences"].title,
          icon: RiChat3Line,
        },
        {
          key: "language",
          page: "language",
          label: pages["language"].title,
          icon: RiGlobalLine,
        },
        {
          key: "about",
          page: "about",
          label: pages["about"].title,
          icon: RiInformationLine,
        },
      ],
    },
  ];
  return (
    <MentionSettingsContext.Provider value={value}>
      {children}
      <SettingsModal
        initialView={initialView}
        control={control}
        page={page}
        defaultPage={page}
        onPageChange={setPage}
        onClose={onClose}
        groups={groups}
        pages={pages}
        labels={{
          dialog: t("settings.title", { defaultValue: "Settings" }),
          close: t("common.close", { defaultValue: "Close settings" }),
          back: t("common.back", { defaultValue: "Back" }),
        }}
      />
    </MentionSettingsContext.Provider>
  );
}
