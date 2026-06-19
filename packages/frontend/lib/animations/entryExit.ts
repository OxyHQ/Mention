import {
  Easing,
  FadeIn,
  FadeInDown,
  FadeInUp,
  FadeOut,
  FadeOutDown,
  FadeOutUp,
} from 'react-native-reanimated';

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const easeIn = Easing.bezier(0.32, 0, 0.67, 0);

export const composePreviewEnter = FadeIn.duration(180).easing(easeOut);
export const composePreviewExit = FadeOut.duration(120).easing(easeIn);

export const countEnterFromBelow = FadeInDown.duration(400).easing(easeOut);
export const countEnterFromAbove = FadeInUp.duration(400).easing(easeOut);
export const countExitUp = FadeOutUp.duration(400).easing(easeOut);
export const countExitDown = FadeOutDown.duration(400).easing(easeOut);
