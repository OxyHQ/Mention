// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { create } from 'zustand';

/**
 * The topic the topic screen is showing, so the right rail can render that
 * topic's widgets above the shared ones.
 *
 * Only the term is shared. The widgets read their own data by term, so the rail
 * never receives a node from the screen and the screen never reaches into the
 * rail. Cleared on unmount, so a topic's widgets cannot outlive its page.
 */
interface TopicRailState {
  term: string | null;
  setTerm: (term: string | null) => void;
}

export const useTopicRailStore = create<TopicRailState>()((set) => ({
  term: null,
  setTerm: (term) => set({ term }),
}));
