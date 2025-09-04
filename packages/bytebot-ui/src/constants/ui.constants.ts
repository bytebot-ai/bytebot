/**
 * UI constants for consistent styling and configuration
 */

export const UI_CONSTANTS = {
  // Animation durations
  ANIMATION: {
    SPIN_DURATION: '3s',
    TRANSITION_DURATION: '150ms',
  },

  // Common class names
  CLASSES: {
    LOADING_SPINNER: 'animate-[spin_3s_linear_infinite]',
    TRANSITION_DEFAULT: 'transition-colors',
  },

  // Date formatting
  DATE_FORMAT: {
    TIME_12H: 'h:mma',
    FULL_DATE: 'MMMM d, yyyy, h:mma',
    TODAY_PREFIX: "'Today'",
  },

  // Component defaults
  DEFAULTS: {
    TASK_LIST_LIMIT: 5,
    LOADING_SPINNER_SIZE: 'h-6 w-6',
  },
} as const;

export type UIConstants = typeof UI_CONSTANTS;