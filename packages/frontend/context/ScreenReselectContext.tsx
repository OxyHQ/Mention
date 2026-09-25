import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useIsFocused } from 'expo-router';
import { useLayoutScroll } from '@/context/LayoutScrollContext';
import { useRefSync } from '@/hooks/useRefSync';

/**
 * What pressing the place you are already on means for one screen — the
 * bottom-bar tab, the sidebar row, the logo, the inner tab that is already
 * selected. The convention every social app shares: the first press takes the
 * reader back to the top, and a press while already there reloads.
 *
 * A screen only says HOW it reloads. Where the top is belongs to whoever owns
 * the scroller: the web document or the registered native list
 * (`LayoutScrollContext`). A screen that drives its own scroller (the reel,
 * where the top is the first slide) supplies both halves itself.
 */
export type ReselectHandler = {
    refresh?: () => void | Promise<unknown>;
    scrollToTop?: () => void;
    isAtTop?: () => boolean;
};

/** Within this many points of the top, the reader is at the top. */
export const AT_TOP_THRESHOLD = 4;

/**
 * Whether an offset is the top. A screen with no scroller to measure (`null`)
 * cannot be anywhere else.
 */
export function isOffsetAtTop(offset: number | null): boolean {
    return offset === null || offset <= AT_TOP_THRESHOLD;
}

type ScreenReselectContextValue = {
    reselect: () => void;
    register: (read: () => ReselectHandler) => () => void;
};

const ScreenReselectContext = createContext<ScreenReselectContextValue | null>(null);

export function ScreenReselectProvider({ children }: { children: React.ReactNode }) {
    const { getScrollOffset, scrollToTop } = useLayoutScroll();
    // One slot, last registration wins, and a cleanup only clears the slot it
    // filled — the same ownership rule as `registerScrollable`, for the same
    // reason: a screen that lost focus must not take the next screen's slot
    // with it when it unregisters late.
    const activeRef = useRef<{ id: number; read: () => ReselectHandler } | null>(null);
    const counterRef = useRef(0);

    const register = useCallback((read: () => ReselectHandler) => {
        const id = ++counterRef.current;
        activeRef.current = { id, read };
        return () => {
            if (activeRef.current?.id === id) activeRef.current = null;
        };
    }, []);

    const reselect = useCallback(() => {
        const handler = activeRef.current?.read();
        // Away from the top a press only scrolls; at the top it also reloads,
        // and the scroll keeps what arrives in view.
        const atTop = handler?.isAtTop ? handler.isAtTop() : isOffsetAtTop(getScrollOffset());
        (handler?.scrollToTop ?? scrollToTop)();
        if (atTop) void handler?.refresh?.();
    }, [getScrollOffset, scrollToTop]);

    const value = useMemo(() => ({ reselect, register }), [reselect, register]);

    return <ScreenReselectContext.Provider value={value}>{children}</ScreenReselectContext.Provider>;
}

function useScreenReselectContext(): ScreenReselectContextValue {
    const ctx = useContext(ScreenReselectContext);
    if (!ctx) throw new Error('Screen reselect hooks must be used within ScreenReselectProvider');
    return ctx;
}

/** Scroll the focused screen to the top, or reload it if it is already there. */
export function useReselect(): () => void {
    return useScreenReselectContext().reselect;
}

/**
 * Declare what reselecting this screen means. Registered only while the screen
 * is focused: the native tab pager keeps every tab mounted, and a background
 * tab must never answer for the one in front of the reader.
 */
export function useScreenReselect(handler: ReselectHandler) {
    const { register } = useScreenReselectContext();
    const isFocused = useIsFocused();
    const handlerRef = useRefSync(handler);

    useEffect(() => {
        if (!isFocused) return;
        return register(() => handlerRef.current);
    }, [isFocused, register, handlerRef]);
}

/**
 * For a screen whose reload is "fetch the feed again from the top": a
 * `reloadKey` for its `<Feed>` that moves each time the screen is reselected
 * at the top. `handler` carries whatever else the screen reloads alongside
 * the feed, or where its own top is.
 */
export function useReselectReloadKey(handler: ReselectHandler = {}): number {
    const [reloadKey, setReloadKey] = useState(0);
    useScreenReselect({
        ...handler,
        refresh: () => {
            setReloadKey(key => key + 1);
            return handler.refresh?.();
        },
    });
    return reloadKey;
}

/**
 * An inner tab strip's press handler: the tab already selected is reselected,
 * any other one is selected with `select`.
 */
export function useTabSelect<T>(active: T, select: (tab: T) => void): (tab: T) => void {
    const reselect = useReselect();
    return useCallback((tab: T) => {
        if (tab === active) reselect();
        else select(tab);
    }, [active, reselect, select]);
}
