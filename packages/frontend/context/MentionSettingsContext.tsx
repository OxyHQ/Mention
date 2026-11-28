// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { createContext, useCallback, useContext } from 'react';

export interface MentionSettingsActions {
  open: (page?: string) => void;
  close: () => void;
  page: string;
  navigate: (route: string) => void;
  afterClose: (action: () => void) => void;
}
export const MentionSettingsContext = createContext<MentionSettingsActions | null>(null);
export function useMentionSettings() {
  const value = useContext(MentionSettingsContext);
  if (!value) throw new Error('MentionSettingsProvider is missing');
  return value;
}
export function useSettingsRouter() {
  const { navigate, close } = useMentionSettings();
  return {
    push: navigate,
    replace: navigate,
    navigate,
    back: close,
    canGoBack: () => true,
  };
}
export function useSettingsBack() {
  const { open, page } = useMentionSettings();
  return useCallback(
    () => open(page.includes('/') ? page.slice(0, page.lastIndexOf('/')) : 'account'),
    [open, page],
  );
}
