import { useCallback } from 'react';
import { useAuth, useOxy } from '@oxy.so/services/ui/client';

/**
 * The two account actions a signed-out reader is offered.
 *
 * Create account opens the Oxy dialog on its signup view. Sign in is the same
 * dialog's sign-in view (`useAuth().signIn` → `openAccountDialog('signin')`).
 * The dialog does not change the URL; campaign query stays on the page that
 * opened it.
 */
export function useAccountEntry() {
  const { signIn } = useAuth();
  const { openAccountDialog } = useOxy();

  const createAccount = useCallback(() => {
    openAccountDialog('signup');
  }, [openAccountDialog]);

  const signInAccount = useCallback(() => {
    signIn().catch(() => {});
  }, [signIn]);

  return { createAccount, signInAccount };
}
