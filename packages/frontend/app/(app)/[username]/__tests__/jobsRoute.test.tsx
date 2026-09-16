import React from 'react';
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
