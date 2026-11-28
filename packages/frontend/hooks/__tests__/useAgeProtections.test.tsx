import TestRenderer, { act } from 'react-test-renderer';
import type { AgeProtections } from '@oxy.so/contracts/client';
import { useAgeProtections } from '@/hooks/useAgeProtections';

/**
 * The protective defaults come from the age band on the signed-in account's
 * own profile (oxy ADR 0068). Only a minor's band changes anything: an adult,
 * an account of unknown age and a signed-out reader all get the standard
 * profile.
 */

let mockUser: { ageBand?: string } | null = null;
jest.mock('@oxy.so/services/ui/client', () => ({
  useAuth: () => ({ user: mockUser }),
}));

function read(): AgeProtections {
  let seen: AgeProtections | undefined;
  function Probe() {
    seen = useAgeProtections();
    return null;
  }
  act(() => {
    TestRenderer.create(<Probe />);
  });
  if (!seen) throw new Error('the hook did not run');
  return seen;
}

const STANDARD: AgeProtections = {
  feedProfile: 'standard',
  autoplay: 'personal',
  quietHours: null,
};

describe('useAgeProtections', () => {
  it.each(['teen', 'under13'])('protects an account whose band is %s', (ageBand) => {
    mockUser = { ageBand };
    expect(read()).toEqual({
      feedProfile: 'protected',
      autoplay: 'never',
      quietHours: { start: '22:00', end: '07:00' },
    });
  });

  it('gives an adult the standard profile', () => {
    mockUser = { ageBand: 'adult' };
    expect(read()).toEqual(STANDARD);
  });

  it('gives an account of unknown age the standard profile', () => {
    mockUser = {};
    expect(read()).toEqual(STANDARD);
  });

  it('gives a signed-out reader the standard profile', () => {
    mockUser = null;
    expect(read()).toEqual(STANDARD);
  });
});
