// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import { createContext } from 'react';

/** The containing footer and its one editor share interaction state, never geometry. */
export const ReplyComposerFocusContext = createContext<{
  focused: boolean;
  setFocused: (focused: boolean) => void;
} | null>(null);
