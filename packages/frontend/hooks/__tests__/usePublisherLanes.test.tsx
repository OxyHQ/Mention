import TestRenderer, { act } from 'react-test-renderer';
import { useQuery } from '@tanstack/react-query';
import type { AccountNode } from '@oxy.so/core';
import { usePublisherLanes } from '../usePublisherLanes';

jest.mock('@tanstack/react-query', () => ({ useQuery: jest.fn(() => ({ data: undefined })) }));
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: { id: 'me' }, canUsePrivateApi: true }),
}));
const mockLanes = { listMine: jest.fn(), listForOwner: jest.fn() };
jest.mock('@/services/lanesService', () => ({
  get lanesService() {
    return mockLanes;
  },
}));

function queryFor(publishAs?: Partial<AccountNode>) {
  function Probe() {
    usePublisherLanes(publishAs as AccountNode | undefined);
    return null;
  }
  act(() => {
    TestRenderer.create(<Probe />);
  });
  return (useQuery as jest.Mock).mock.calls.at(-1)[0];
}

it('reads the viewer lanes, an operated account management list, or its public lanes', () => {
  queryFor().queryFn();
  expect(mockLanes.listMine).toHaveBeenLastCalledWith();

  queryFor({ accountId: 'chan', relationship: 'owner' }).queryFn();
  expect(mockLanes.listMine).toHaveBeenLastCalledWith('chan');

  queryFor({ accountId: 'chan', relationship: 'member' }).queryFn();
  expect(mockLanes.listForOwner).toHaveBeenCalledWith('chan');
});
