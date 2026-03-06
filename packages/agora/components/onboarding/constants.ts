import type { OnboardingStep } from './types';

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to Agora',
    subtitle: 'Your space for live audio conversations with real people.',
    lottieSource: require('@/assets/lottie/happy.json'),
  },
  {
    id: 'rooms',
    title: 'Join Live Rooms',
    subtitle: 'Drop into conversations happening right now, or schedule your own.',
    lottieSource: require('@/assets/lottie/onair.json'),
  },
  {
    id: 'connect',
    title: 'Connect & Discover',
    subtitle: 'Follow topics you love and meet people who share your interests.',
    lottieSource: require('@/assets/lottie/looking.json'),
  },
  {
    id: 'interests',
    title: 'Topics to Follow',
    subtitle: 'Choose topics that interest you to personalize your experience.',
    lottieSource: require('@/assets/lottie/looking.json'),
    type: 'interests' as const,
  },
  {
    id: 'create',
    title: 'Create Your Space',
    subtitle: 'Host rooms, build communities, and shape the conversation.',
    lottieSource: require('@/assets/lottie/egg.json'),
  },
];

export const STORAGE_KEY_ONBOARDING = 'agora_onboarding_progress';

export const ONBOARDING_ANIMATION = {
  PARALLAX_FACTOR: 0.2,
  SCALE_INACTIVE: 0.95,
  SCALE_ACTIVE: 1,
} as const;

export const DOT_SIZE = 8;
export const DOT_ACTIVE_WIDTH = 24;
export const DOT_GAP = 8;

export const INTEREST_TOPICS = [
  { label: 'Clubhouse', emoji: '👋' },
  { label: 'Dating', emoji: '💖' },
  { label: 'Flirting', emoji: '💋' },
  { label: 'Happiness', emoji: '🤗' },
  { label: 'Television', emoji: '📺' },
  { label: 'Health', emoji: '🍎' },
  { label: 'Relationships', emoji: '💕' },
  { label: 'Positivity', emoji: '🌈' },
  { label: 'Weights', emoji: '🏋️' },
  { label: 'Nutrition', emoji: '🥗' },
  { label: 'Support', emoji: '☕' },
  { label: 'Love Stories', emoji: '💝' },
  { label: 'Technology', emoji: '💻' },
  { label: 'Music', emoji: '🎵' },
  { label: 'Sports', emoji: '⚽' },
  { label: 'Gaming', emoji: '🎮' },
  { label: 'Science', emoji: '🔬' },
  { label: 'Art', emoji: '🎨' },
  { label: 'Business', emoji: '💼' },
  { label: 'Crypto', emoji: '🪙' },
] as const;
