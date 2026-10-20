import {
  useVirtualizer,
  useWindowVirtualizer,
  type VirtualizerOptions,
} from '@tanstack/react-virtual';
import { useAppShellPanel, usePanelScrollContainer } from '@oxy.so/bloom/app-shell/hooks';
import { useScreenViewport } from '@oxy.so/bloom/screen';

type ListOptions<T extends Element> = Pick<
  VirtualizerOptions<HTMLElement, T>,
  'count' | 'estimateSize' | 'overscan' | 'scrollMargin' | 'getItemKey'
>;

/**
 * Virtualize against the existing Bloom scroll owner; creates no scroll container.
 *
 * `useFlushSync: false`: by default the virtualizer re-renders the list
 * synchronously inside every scroll event (`flushSync`), so each scroll frame
 * pays for a full list render before the browser can paint. Without it the
 * update is an ordinary batched render; overscan covers the frame it lags.
 */
export function useOwnerVirtualizer<T extends Element>(options: ListOptions<T>) {
  const panel = usePanelScrollContainer<HTMLElement>();
  const shellPanel = useAppShellPanel();
  const viewport = useScreenViewport();
  // Retained columns must not initialize a window virtualizer when their
  // hidden host changes flow: its initial scroll write would move the page
  // the reader is still viewing in another panel.
  const active = shellPanel.active !== false && viewport?.active !== false;
  const documentList = useWindowVirtualizer<T>({
    ...options,
    enabled: active && !panel,
    useFlushSync: false,
  });
  const panelList = useVirtualizer<HTMLElement, T>({
    ...options,
    enabled: active && Boolean(panel),
    useFlushSync: false,
    getScrollElement: () => panel?.current ?? null,
  });
  return panel ? panelList : documentList;
}
