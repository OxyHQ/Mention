import type { AnimationObject } from 'lottie-react-native';
import type { SharedValue } from 'react-native-reanimated';

export interface OnboardingStep {
  id: string;
  title: string;
  subtitle: string;
  lottieSource: AnimationObject | { uri: string };
  type?: 'info' | 'interests';
}

export interface OnboardingProgress {
  currentStep: number;
  completed: boolean;
  skipped: boolean;
}

export interface OnboardingPageProps {
  step: OnboardingStep;
  index: number;
  scrollProgress: SharedValue<number>;
  pageWidth: number;
  reduceMotion: boolean;
  onContentHeightMeasured?: (index: number, height: number) => void;
}
