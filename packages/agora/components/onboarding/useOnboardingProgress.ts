import { useState, useEffect, useCallback } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '@/utils/api';
import { STORAGE_KEY_ONBOARDING } from './constants';
import type { OnboardingProgress } from './types';

const DEFAULT_PROGRESS: OnboardingProgress = {
  currentStep: 0,
  completed: false,
  skipped: false,
};

async function readLocal(): Promise<OnboardingProgress | null> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY_ONBOARDING);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function writeLocal(progress: OnboardingProgress): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY_ONBOARDING, JSON.stringify(progress));
  } catch {}
}

export function useOnboardingProgress(isAuthenticated: boolean) {
  const [progress, setProgress] = useState<OnboardingProgress>(DEFAULT_PROGRESS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const local = await readLocal();
      if (!cancelled && local) {
        setProgress(local);
      }

      if (isAuthenticated) {
        try {
          const res = await api.get<{ onboarding?: OnboardingProgress }>('profile/settings/me');
          const server = res.data?.onboarding;
          if (!cancelled && server) {
            setProgress(server);
            await writeLocal(server);
          }
        } catch {}
      }

      if (!cancelled) setLoaded(true);
    }

    load();
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  const persist = useCallback(async (next: OnboardingProgress) => {
    await writeLocal(next);
    if (isAuthenticated) {
      try {
        await api.put('profile/settings', { onboarding: next } as Record<string, unknown>);
      } catch {}
    }
  }, [isAuthenticated]);

  const updateStep = useCallback((step: number) => {
    setProgress((prev) => {
      const next = { ...prev, currentStep: step };
      persist(next);
      return next;
    });
  }, [persist]);

  const markCompleted = useCallback(() => {
    setProgress((prev) => {
      const next = { ...prev, completed: true };
      persist(next);
      return next;
    });
  }, [persist]);

  const markSkipped = useCallback(() => {
    setProgress((prev) => {
      const next = { ...prev, skipped: true, completed: true };
      persist(next);
      return next;
    });
  }, [persist]);

  return { progress, loaded, updateStep, markCompleted, markSkipped };
}
