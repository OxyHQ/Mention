import { ReplyComposerFocusContext } from './ReplyComposerFocusContext';
import { useMemo, useState, type ReactNode } from 'react';
import { TabPagerBottomBar } from '@oxy.so/bloom/tab-pager';

/** One editor remains mounted while Bloom coordinates its navigation and scroll motion. */
export function PostReplyFooter({ children }: { children?: ReactNode }) {
  const [focused, setFocused] = useState(false);
  const focus = useMemo(() => ({ focused, setFocused }), [focused]);
  return (
    <ReplyComposerFocusContext.Provider value={focus}>
      <TabPagerBottomBar
        action={children}
        actionBehavior="visible"
        style={{ marginHorizontal: 8 }}
        testID="post-reply-navigation"
      />
    </ReplyComposerFocusContext.Provider>
  );
}
