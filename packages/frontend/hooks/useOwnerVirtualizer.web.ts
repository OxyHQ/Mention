import {
  useVirtualizer,
  useWindowVirtualizer,
  type VirtualizerOptions,
} from '@tanstack/react-virtual';
import { usePanelScrollContainer } from '@oxy.so/bloom/app-shell/hooks';

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
  const documentList = useWindowVirtualizer<T>({
    ...options,
    enabled: !panel,
    useFlushSync: false,
  });
  const panelList = useVirtualizer<HTMLElement, T>({
    ...options,
    enabled: Boolean(panel),
    useFlushSync: false,
    getScrollElement: () => panel?.current ?? null,
  });
  return panel ? panelList : documentList;
}
