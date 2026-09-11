import { StyleSheet } from 'react-native';

/**
 * The containing block Bloom's positioned home FAB resolves against.
 * `minHeight: 0` is structural: without it the feed's intrinsic minimum grows
 * this node beyond the viewport and `bottom` becomes the end of the feed.
 */
export const HOME_FAB_CONTAINING_BLOCK_STYLE = StyleSheet.create({
  root: {
    flex: 1,
    minHeight: 0,
    position: 'relative',
  },
}).root;
