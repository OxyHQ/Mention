/**
 * Performance Configuration
 * Centralized performance settings for the app
 */

/**
 * Performance thresholds and limits
 */
export const PERFORMANCE_CONFIG = {
  // List virtualization thresholds
  LIST_VIRTUALIZATION_THRESHOLD: 10, // Use FlatList/FlashList for lists > 10 items
  
  // Debounce delays (ms)
  SEARCH_DEBOUNCE: 300,
  INPUT_DEBOUNCE: 200,
  SCROLL_DEBOUNCE: 100,
  
  // Throttle delays (ms)
  SCROLL_THROTTLE: 16, // ~60fps
  RESIZE_THROTTLE: 150,
  
  // Image optimization
  IMAGE_LAZY_LOAD_THRESHOLD: 3, // Start loading images 3 items before they're visible
  IMAGE_PLACEHOLDER_ENABLED: true,
  
  // Cache settings
  MEMORY_CACHE_SIZE: 50 * 1024 * 1024, // 50MB
  DISK_CACHE_SIZE: 200 * 1024 * 1024, // 200MB
  
  // Animation settings
  ANIMATION_DURATION: {
    FAST: 150,
    NORMAL: 300,
    SLOW: 500,
  },
  
  // Bundle optimization
  CODE_SPLITTING_ENABLED: true,
  LAZY_LOAD_ROUTES: true,
} as const;

/**
 * Feature flags for performance optimizations
 */
export const PERFORMANCE_FEATURES = {
  ENABLE_VIRTUALIZED_LISTS: true,
  ENABLE_IMAGE_LAZY_LOADING: true,
  ENABLE_CODE_SPLITTING: true,
  ENABLE_MEMOIZATION: true,
  ENABLE_DEBOUNCING: true,
  ENABLE_THROTTLING: true,
} as const;

