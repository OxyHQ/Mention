// Copyright (c) 2024-present The Oxy Collective, Inc.
// SPDX-License-Identifier: LicenseRef-Breathe-1.0
// Licensed under the Breathe License 1.0. Commercial use requires a paid
// license. Source publication and attribution are required of everyone.
// https://github.com/OxyHQ/.github/blob/main/LICENSE-BREATHE.md

import TestRenderer, { act } from 'react-test-renderer';

const mockUseRoutedProfileUsername = jest.fn();
jest.mock('@/components/Profile/hooks/useRoutedProfileUsername', () => ({
  useRoutedProfileUsername: () => mockUseRoutedProfileUsername(),
}));

const mockProfileScreen = jest.fn();
jest.mock('@/components/ProfileScreen', () => ({
  __esModule: true,
  default: (props: unknown) => {
    mockProfileScreen(props);
    return null;
  },
}));

import ProfileJobsRoute from '../jobs';

describe('ProfileJobsRoute', () => {
  it('renders ProfileScreen with the routed username and the jobs tab selected', () => {
    mockUseRoutedProfileUsername.mockReturnValue('acme');

    act(() => {
      TestRenderer.create(<ProfileJobsRoute />);
    });

    expect(mockProfileScreen).toHaveBeenCalledWith({ username: 'acme', tab: 'jobs' });
  });
});
