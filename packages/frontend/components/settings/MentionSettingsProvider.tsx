import { MentionSettingsContext } from '@/context/MentionSettingsContext';
import { useDialogControl } from '@oxy.so/bloom/dialog';
import { useRouter, type Href } from 'expo-router';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react';
import {
  isSettingsPage,
  onSettingsRequest,
  SETTINGS_PAGE_IDS,
  settingsPageFromRoute,
} from './settingsRoutes';

// The dialog and its pages load on the first open request, not at startup:
// this provider wraps the whole app, and the dialog is never visible before
// someone asks for it.
const MentionSettingsModal = lazy(() => import('./MentionSettingsModal'));

export { SETTINGS_PAGE_IDS, settingsPageFromRoute };

/** One shared settings surface; pages contain business controls, never chrome or scrollers. */
export function MentionSettingsProvider({ children }: PropsWithChildren) {
  const router = useRouter();
  const control = useDialogControl();
  const [page, setPage] = useState('account');
  const [openRequest, setOpenRequest] = useState(0);
  const [initialView, setInitialView] = useState<'navigation' | 'page'>('navigation');
  const active = useRef(false);
  const pendingAction = useRef<(() => void) | null>(null);
  const open = useCallback((next?: string) => {
    setInitialView(next ? 'page' : 'navigation');
    pendingAction.current = null;
    setPage(next && isSettingsPage(next) ? next : 'account');
    active.current = true;
    setOpenRequest((request) => request + 1);
  }, []);
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
  return (
    <MentionSettingsContext.Provider value={value}>
      {children}
      {openRequest > 0 && (
        <Suspense fallback={null}>
          <MentionSettingsModal
            control={control}
            openRequest={openRequest}
            page={page}
            initialView={initialView}
            onPageChange={setPage}
            onClose={onClose}
          />
        </Suspense>
      )}
    </MentionSettingsContext.Provider>
  );
}
