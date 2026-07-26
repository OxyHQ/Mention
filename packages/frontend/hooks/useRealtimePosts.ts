import { useEffect } from 'react';
import { socketService } from '@/services/socketService';
import { useAuth, useOxy } from '@oxyhq/services/ui/client';

// The bridge using this hook is the sole owner of the posts socket lease.
export default function useRealtimePosts() {
	const { canUsePrivateApi, user, oxyServices } = useAuth();
	const { activeSessionId } = useOxy();

	useEffect(() => {
		if (!canUsePrivateApi || !user?.id) return;
		const token = oxyServices?.getAccessToken() ?? undefined;
		if (!token) return;
		socketService.connect(user.id, token);
		return () => socketService.disconnect();
	}, [activeSessionId, canUsePrivateApi, user?.id, oxyServices]);
}
