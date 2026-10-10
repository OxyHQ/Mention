import {
  Easing,
  FadeInDown,
  FadeInUp,
  FadeOutDown,
  FadeOutUp,
} from 'react-native-reanimated';

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);

export const countEnterFromBelow = FadeInDown.duration(400).easing(easeOut);
export const countEnterFromAbove = FadeInUp.duration(400).easing(easeOut);
export const countExitUp = FadeOutUp.duration(400).easing(easeOut);
export const countExitDown = FadeOutDown.duration(400).easing(easeOut);
