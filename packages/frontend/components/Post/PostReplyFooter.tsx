import { ReplyComposerFocusContext } from './ReplyComposerFocusContext';
import { useContext, useMemo, useState, type ReactNode } from 'react';
import { useAppShellPanel } from '@oxy.so/bloom/app-shell';
import { TabPagerBottomBar } from '@oxy.so/bloom/tab-pager';
import { useScreen } from '@oxy.so/bloom/screen';
import { PostReplyNavigationContext } from './PostReplyNavigationContext';

/** One editor remains mounted while Bloom coordinates its navigation and scroll motion. */
export function PostReplyFooter({ children }: { children?: ReactNode }) {
  const [focused, setFocused] = useState(false);
  const focus = useMemo(() => ({ focused, setFocused }), [focused]);
  const ownsMainNavigation = useContext(PostReplyNavigationContext);
  const panel = useAppShellPanel();
  const { collapseProgress } = useScreen();
  return (
    <ReplyComposerFocusContext.Provider value={focus}>
      <TabPagerBottomBar
        action={children}
        actionBehavior="dock"
        horizontalInset={8}
        navigationVisibility={
          ownsMainNavigation && panel.id === 'main' && !focused ? 'compact' : 'never'
        }
        routeBehavior="contextual"
        minimizeProgress={collapseProgress}
        testID="post-reply-navigation"
      />
    </ReplyComposerFocusContext.Provider>
  );
}
