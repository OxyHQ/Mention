import { useEffect, useState } from 'react';
import { socketService } from '@/services/socketService';
import { useAuth } from '@oxy.so/services/ui/client';

// The bridge using this hook is the sole owner of the posts socket lease.
export default function useRealtimePosts() {
  const { canUsePrivateApi, user, oxyServices } = useAuth();
  const [contextRevision, setContextRevision] = useState(0);

  useEffect(() => {
    if (!canUsePrivateApi || !user?.id) return;
    socketService.connect(user.id, oxyServices, () => setContextRevision(contextRevision + 1));
    return () => socketService.disconnect();
  }, [canUsePrivateApi, user?.id, oxyServices, contextRevision]);
}
