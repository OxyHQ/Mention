// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import TestRenderer, { act } from 'react-test-renderer';
import { OwnedSurfaceContent } from '../OwnedSurfaceContent';

it('removes only the content whose owner aborts', async () => {
  const first = new AbortController();
  const second = new AbortController();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <>
        <OwnedSurfaceContent signal={first.signal}>first</OwnedSurfaceContent>
        <OwnedSurfaceContent signal={second.signal}>second</OwnedSurfaceContent>
      </>,
    );
  });
  expect(renderer.toJSON()).toEqual(['first', 'second']);
  await act(async () => first.abort());
  expect(renderer.toJSON()).toBe('second');
  expect(second.signal.aborted).toBe(false);
  await act(async () => renderer.unmount());
});
