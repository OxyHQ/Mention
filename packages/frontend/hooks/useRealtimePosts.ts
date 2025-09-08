import { useEffect } from 'react';
import { socketService } from '@/services/socketService';
import { useOxy } from '@oxyhq/services';

// Lightweight hook to ensure socket connection when authenticated
export default function useRealtimePosts() {
		const { isAuthenticated, user } = useOxy();

	useEffect(() => {
		let didCancel = false;
			if (isAuthenticated) {
				// Pass user id for echo guard/auth
				socketService.connect(user?.id);
		}
		return () => {
			if (didCancel) return;
			// Keep connection for app lifecycle; we don't hard disconnect on unmount
		};
		}, [isAuthenticated, user?.id]);
}
