import { useCallback, useEffect, useRef } from 'react';
import { useIsFocused } from 'expo-router';
import { useLayoutScroll, type ScrollableRef } from '@/context/LayoutScrollContext';

/**
 * Make a native scroller the screen's scroll owner for exactly as long as its
 * screen is in front.
 *
 * The native tab pager keeps every tab mounted, so "mounted" is not "in front":
 * a list that registers on mount and stays registered either takes the slot
 * from the tab the reader is looking at, or — once a focused list registers
 * over it and later releases — leaves its own tab with no owner at all. Owning
 * the slot while focused, and releasing it on blur, is the one rule that holds.
 *
 * Returns a callback ref for the scroller. `enabled: false` is for a list that
 * does not scroll itself (it is laid out inside another scroller).
 * `initialOffset` is where the scroller sits the first time it claims the slot,
 * when the caller knows it; after that `LayoutScrollContext` remembers.
 */
export function useFocusedScrollable<T extends ScrollableRef>({
    enabled = true,
    initialOffset,
}: { enabled?: boolean; initialOffset?: number } = {}): (node: T | null) => void {
    const isFocused = useIsFocused();
    const { registerScrollable } = useLayoutScroll();
    const nodeRef = useRef<T | null>(null);
    const releaseRef = useRef<(() => void) | null>(null);
    const owns = enabled && isFocused;

    const release = useCallback(() => {
        releaseRef.current?.();
        releaseRef.current = null;
    }, []);

    const claim = useCallback(() => {
        if (!nodeRef.current || releaseRef.current) return;
        releaseRef.current = registerScrollable(nodeRef.current, initialOffset);
    }, [registerScrollable, initialOffset]);

    useEffect(() => {
        if (owns) claim();
        else release();
    }, [owns, claim, release]);

    useEffect(() => release, [release]);

    return useCallback((node: T | null) => {
        nodeRef.current = node;
        release();
        if (owns) claim();
    }, [owns, claim, release]);
}
