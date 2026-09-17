import Ionicons from '@expo/vector-icons/Ionicons';
import { Icon } from '../icons';

describe('lib/icons', () => {
  it('re-exports Ionicons unchanged, only retyped', () => {
    expect(Icon).toBe(Ionicons);
  });
});
