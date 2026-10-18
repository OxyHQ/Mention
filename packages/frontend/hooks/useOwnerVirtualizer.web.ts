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

/** Virtualize against the existing Bloom scroll owner; creates no scroll container. */
export function useOwnerVirtualizer<T extends Element>(options: ListOptions<T>) {
  const panel = usePanelScrollContainer<HTMLElement>();
  const documentList = useWindowVirtualizer<T>({ ...options, enabled: !panel });
  const panelList = useVirtualizer<HTMLElement, T>({
    ...options,
    enabled: Boolean(panel),
    getScrollElement: () => panel?.current ?? null,
  });
  return panel ? panelList : documentList;
}
