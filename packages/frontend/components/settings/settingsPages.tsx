import { useTranslation } from "react-i18next";
import type {
  SettingsModalPage,
  SettingsNavGroup,
} from "@oxy.so/bloom/settings-modal";
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
import Page0 from "./pages/account";
import Page1 from "./pages/about";
import Page2 from "./pages/accessibility";
import Page3 from "./pages/appearance";
import Page4 from "./pages/connected-ai";
import Page5 from "./pages/external-media";
import Page6 from "./pages/fediverse/index";
import Page7 from "./pages/fediverse/node";
import Page8 from "./pages/feed";
import Page9 from "./pages/for-you";
import Page10 from "./pages/interests";
import Page11 from "./pages/language";
import Page12 from "./pages/live-presence";
import Page13 from "./pages/notifications/subscriptions";
import Page14 from "./pages/notifications";
import Page15 from "./pages/privacy/blocked";
import Page16 from "./pages/privacy/hidden-words";
import Page17 from "./pages/privacy/hide-counts";
import Page18 from "./pages/privacy/muted-lanes";
import Page19 from "./pages/privacy/online-status";
import Page20 from "./pages/privacy/profile-visibility";
import Page21 from "./pages/privacy/restricted";
import Page22 from "./pages/privacy/tags-mentions";
import Page23 from "./pages/privacy";
import Page24 from "./pages/thread-preferences";

export interface MentionSettingsPages {
  pages: Record<string, SettingsModalPage>;
  groups: SettingsNavGroup[];
}

/**
 * Every settings page and the navigation that lists them. Only
 * `MentionSettingsModal` imports this, so the pages share its async chunk.
 */
export function useMentionSettingsPages(): MentionSettingsPages {
  const { t } = useTranslation();
  const pages = {
    account: {
      title: t("settings.account.manageAccount", { defaultValue: "Account" }),
      content: <Page0 />,
    },
    about: {
      title: t("settings.aboutMention.title", { defaultValue: "About" }),
      content: <Page1 />,
    },
    accessibility: {
      title: t("settings.accessibility.title", {
        defaultValue: "Accessibility",
      }),
      content: <Page2 />,
    },
    appearance: {
      title: t("settings.appearance", "Appearance"),
      content: <Page3 />,
    },
    "connected-ai": {
      title: t("mcp.connections.title", { defaultValue: "Connected AI" }),
      content: <Page4 />,
    },
    "external-media": {
      title: t("settings.externalMedia.title", {
        defaultValue: "External media",
      }),
      content: <Page5 />,
    },
    fediverse: {
      title: t("fediverse.settings.title"),
      content: <Page6 />,
    },
    "fediverse/node": {
      title: t("settings.node.title", { defaultValue: "Your Mention node" }),
      content: <Page7 />,
    },
    feed: {
      title: t("settings.feed.title"),
      content: <Page8 />,
    },
    "for-you": {
      title: t("feed.tuning.title", { defaultValue: "For You" }),
      content: <Page9 />,
    },
    interests: {
      title: t("settings.interests.title", { defaultValue: "Your interests" }),
      content: <Page10 />,
    },
    language: {
      title: t("Language"),
      content: <Page11 />,
    },
    "live-presence": {
      title: t("settings.livePresence.title", {
        defaultValue: "Live presence",
      }),
      content: <Page12 />,
    },
    "notifications/subscriptions": {
      title: t("subscription.list.title", {
        defaultValue: "Activity notifications",
      }),
      content: <Page13 />,
    },
    notifications: {
      title: t("settings.notifications.title", {
        defaultValue: "Notifications",
      }),
      content: <Page14 />,
    },
    "privacy/blocked": {
      title: t("settings.privacy.blockedProfiles"),
      content: <Page15 />,
    },
    "privacy/hidden-words": {
      title: t("settings.privacy.hiddenWords"),
      content: <Page16 />,
    },
    "privacy/hide-counts": {
      title: t("settings.privacy.hideAllCounts"),
      content: <Page17 />,
    },
    "privacy/muted-lanes": {
      title: t("lanes.muted.title", { defaultValue: "Muted lanes" }),
      content: <Page18 />,
    },
    "privacy/online-status": {
      title: t("settings.privacy.onlineStatus"),
      content: <Page19 />,
    },
    "privacy/profile-visibility": {
      title: t("settings.privacy.privateProfile"),
      content: <Page20 />,
    },
    "privacy/restricted": {
      title: t("settings.privacy.restrictedProfiles"),
      content: <Page21 />,
    },
    "privacy/tags-mentions": {
      title: t("settings.privacy.tagsAndMentions"),
      content: <Page22 />,
    },
    privacy: {
      title: t("settings.privacy.title"),
      content: <Page23 />,
    },
    "thread-preferences": {
      title: t("settings.threadPreferences.title", {
        defaultValue: "Thread preferences",
      }),
      content: <Page24 />,
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
  return { pages, groups };
}
