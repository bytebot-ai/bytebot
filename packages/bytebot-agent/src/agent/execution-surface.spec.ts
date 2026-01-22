import {
  isDispatchedUserPromptStep,
  resolveExecutionSurface,
  shouldAcquireDesktop,
} from './execution-surface';

describe('execution-surface helpers', () => {
  it('resolves surface from explicit value or requiresDesktop default', () => {
    expect(resolveExecutionSurface({ requiresDesktop: true })).toBe('DESKTOP');
    expect(resolveExecutionSurface({ requiresDesktop: false })).toBe('TEXT_ONLY');
    expect(resolveExecutionSurface({ requiresDesktop: false, executionSurface: 'DESKTOP' })).toBe('DESKTOP');
    expect(resolveExecutionSurface({ requiresDesktop: true, executionSurface: 'TEXT_ONLY' })).toBe('TEXT_ONLY');
    expect(resolveExecutionSurface({ requiresDesktop: true, executionSurface: 'invalid' })).toBe('DESKTOP');
  });

  it('acquires desktop only when requiresDesktop && surface=DESKTOP && desktop tools used', () => {
    expect(shouldAcquireDesktop({ requiresDesktop: true, surface: 'DESKTOP', hasDesktopToolUse: true })).toBe(true);
    expect(shouldAcquireDesktop({ requiresDesktop: false, surface: 'DESKTOP', hasDesktopToolUse: true })).toBe(false);
    expect(shouldAcquireDesktop({ requiresDesktop: true, surface: 'TEXT_ONLY', hasDesktopToolUse: true })).toBe(false);
    expect(shouldAcquireDesktop({ requiresDesktop: true, surface: 'DESKTOP', hasDesktopToolUse: false })).toBe(false);
  });

  it('detects dispatched user-prompt steps via ASK_USER tool flag', () => {
    expect(isDispatchedUserPromptStep({ allowedTools: ['ASK_USER'] })).toBe(true);
    expect(isDispatchedUserPromptStep({ allowedTools: [] })).toBe(false);
    expect(isDispatchedUserPromptStep({ allowedTools: null })).toBe(false);
  });
});

