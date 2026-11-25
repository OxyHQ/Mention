import { recoverChunkError } from '@/lib/chunkReload';
import type React from 'react';
import { Component, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { WhoToFollowWidget } from './WhoToFollowWidget';
import { TrendsWidget } from './TrendsWidget';
import { LiveRoomsWidget } from './LiveRoomsWidget';
import { TopicRailWidgets } from '../topic/TopicWidgets';
import { createLogger } from '@oxy.so/core/logger';

import { Embed, RawText, VStack, toElement } from '@oxy.so/bloom-language';

const logger = createLogger('WidgetManager');

class WidgetErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error: Error) {
    recoverChunkError(error);
    logger.error('Widget crashed', error);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

function WidgetSlot({ children }: { children: ReactNode }) {
  return toElement(VStack(Embed(children)).frame({ width: 'full' }).collapsable(false));
}

// Define screen IDs for social network
export type ScreenId =
  | 'home'
  | 'explore'
  | 'notifications'
  | 'saved'
  | 'profile'
  | 'post-detail'
  | 'search';

interface WidgetManagerProps {
  screenId: ScreenId;
  customWidgets?: ReactNode[];
  /** The topic the topic screen is showing; its widgets sit above the trends widget. */
  topicTerm?: string | null;
}

/**
 * Widget Manager Component
 *
 * This component controls which widgets should appear on which screens.
 * It provides a centralized way to manage widget visibility based on screen context.
 */
export function WidgetManager({ screenId, customWidgets = [], topicTerm }: WidgetManagerProps) {
  const { t } = useTranslation();

  const getWidgetsForScreen = (screen: ScreenId): ReactNode[] => {
    switch (screen) {
      case 'home':
        return [
          <LiveRoomsWidget key="live-rooms" divider />,
          ...(topicTerm ? [<TopicRailWidgets key="topic" term={topicTerm} />] : []),
          <TrendsWidget key="trends" divider />,
          <WhoToFollowWidget key="who-to-follow" />,
        ];

      case 'explore':
        return [<TrendsWidget key="trends" />];

      case 'notifications':
        return [toElement(VStack(RawText(t('widgets.notifications'))), 'notifications')];

      case 'saved':
        return [toElement(VStack(RawText(t('widgets.savedPosts'))), 'saved')];

      case 'profile':
        return [
          toElement(VStack(RawText(t('widgets.profileStats'))), 'profile-stats'),
          toElement(VStack(RawText(t('widgets.engagementStats'))), 'engagement-stats'),
        ];

      case 'post-detail':
        return [
          toElement(VStack(RawText(t('widgets.relatedPosts'))), 'related-posts'),
          toElement(VStack(RawText(t('widgets.recentlyViewed'))), 'recently-viewed'),
        ];

      case 'search':
        return [<TrendsWidget key="trends" />];

      default:
        return [];
    }
  };

  const allWidgets = [...getWidgetsForScreen(screenId), ...customWidgets];

  if (allWidgets.length === 0) {
    return null;
  }

  // No column `gap` — each widget owns its own bottom margin, see `BaseWidget`.
  return toElement(
    VStack(
      Embed(
        allWidgets.map((widget, index) => {
          const slotKey = (widget as React.ReactElement)?.key?.toString() ?? `widget-${index}`;
          return (
            <WidgetErrorBoundary key={slotKey}>
              <WidgetSlot>{widget}</WidgetSlot>
            </WidgetErrorBoundary>
          );
        }),
      ),
    ),
  );
}
