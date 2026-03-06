import { useEffect } from 'react';
import { socketService } from '@/services/socketService';
import { useAuth } from '@oxyhq/services';

// Lightweight hook to ensure socket connection when authenticated
export default function useRealtimePosts() {
	const { isAuthenticated, isReady, user, oxyServices } = useAuth();

	useEffect(() => {
		if (!isAuthenticated || !isReady || !user?.id) return;
		const token = oxyServices?.getAccessToken() ?? undefined;
		if (!token) return;
		socketService.connect(user.id, token);
	}, [isAuthenticated, isReady, user?.id, oxyServices]);
}
