/**
 * Records that the viewer finished or skipped the `/welcome` flow. The server
 * owns the answer (`user_settings.welcome_completed_at`). Nothing sends a new
 * account there automatically, so this is only written from the flow itself.
 */

import { useMutation } from '@tanstack/react-query';
import { authenticatedClient } from '@/utils/api';

/** Record that the viewer finished or skipped `/welcome`. Idempotent server-side. */
export function useCompleteWelcome() {
  return useMutation({
    mutationFn: async () => {
      await authenticatedClient.post('/profile/settings/welcome');
    },
  });
}
