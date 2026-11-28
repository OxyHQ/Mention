// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

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
