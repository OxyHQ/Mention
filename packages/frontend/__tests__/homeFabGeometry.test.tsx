import { StyleSheet } from 'react-native';
import { HOME_FAB_CONTAINING_BLOCK_STYLE } from '@/components/navigation/homeFabGeometry';

describe('home FAB geometry', () => {
  it('keeps the production home root as the FAB viewport containing block', () => {
    expect(StyleSheet.flatten(HOME_FAB_CONTAINING_BLOCK_STYLE)).toEqual({
      flex: 1,
      minHeight: 0,
      position: 'relative',
    });
  });
});
