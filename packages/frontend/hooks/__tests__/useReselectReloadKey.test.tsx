// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import type { ScreenReselectHandler } from '@oxy.so/bloom/screen';
import TestRenderer, { act } from 'react-test-renderer';

// Bloom's scope decides when a reselect reloads (covered there); this is the
// feed's key that the reload moves.
let mockHandler: ScreenReselectHandler = {};
jest.mock('@oxy.so/bloom/screen', () => ({
  useScreenReselectHandler: (handler: ScreenReselectHandler) => {
    mockHandler = handler;
  },
}));

// The mock above must be installed first.
import { useReselectReloadKey } from '../useReselectReloadKey';

it('moves the feed key and reloads the rest of the screen on each reselect reload', () => {
  const refresh = jest.fn();
  let reloadKey = -1;
  function Probe() {
    reloadKey = useReselectReloadKey(refresh);
    return null;
  }
  act(() => {
    TestRenderer.create(<Probe />);
  });
  expect(reloadKey).toBe(0);

  act(() => {
    void mockHandler.refresh?.();
  });
  expect(reloadKey).toBe(1);
  expect(refresh).toHaveBeenCalledTimes(1);
});
