import { useColorScheme as useRNColorScheme } from 'react-native';
import { useAppearanceStore } from '@/store/appearanceStore';

// Returns 'light' or 'dark' based on user preference; falls back to OS setting
export function useColorScheme(): 'light' | 'dark' {
	const rnScheme = useRNColorScheme();
	// Use selector to only subscribe to mySettings, not the entire store
	const mySettings = useAppearanceStore((state) => state.mySettings);
	const pref = mySettings?.appearance?.themeMode ?? 'system';

	if (pref === 'light' || pref === 'dark') return pref;
	return (rnScheme ?? 'light');
}
