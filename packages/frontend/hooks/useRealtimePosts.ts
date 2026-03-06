import { useEffect } from 'react';
import { socketService } from '@/services/socketService';
import { useAuth } from '@oxyhq/services';

// Lightweight hook to ensure socket connection when authenticated
export default function useRealtimePosts() {
		const { isAuthenticated, user, oxyServices } = useAuth();

	useEffect(() => {
		let didCancel = false;
			if (isAuthenticated) {
				const token = oxyServices?.getAccessToken() ?? undefined;
				socketService.connect(user?.id, token);
		}
		return () => {
			didCancel = true;
			// Keep connection for app lifecycle; we don't hard disconnect on unmount
		};
		}, [isAuthenticated, user?.id, oxyServices]);
}
