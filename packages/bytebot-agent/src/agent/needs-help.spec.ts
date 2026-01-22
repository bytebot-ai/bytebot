import { buildNeedsHelpResult, parseNeedsHelpErrorCode } from './needs-help';

describe('needs-help helpers', () => {
  it('uses default message when message is empty', () => {
    const result = buildNeedsHelpResult({
      errorCode: 'LLM_EMPTY_RESPONSE',
      message: '   ',
    });

    expect(result.errorCode).toBe('LLM_EMPTY_RESPONSE');
    expect(result.message).toBe('LLM returned an empty response.');
  });

  it('passes through details when provided', () => {
    const result = buildNeedsHelpResult({
      errorCode: 'DESKTOP_NOT_ALLOWED',
      message: 'Custom',
      details: { executionSurface: 'TEXT_ONLY' },
    });

    expect(result).toEqual({
      errorCode: 'DESKTOP_NOT_ALLOWED',
      message: 'Custom',
      details: { executionSurface: 'TEXT_ONLY' },
    });
  });

  it('parses known error codes and rejects unknowns', () => {
    expect(parseNeedsHelpErrorCode('UI_BLOCKED_SIGNIN')).toBe('UI_BLOCKED_SIGNIN');
    expect(parseNeedsHelpErrorCode('  UI_BLOCKED_POPUP  ')).toBe('UI_BLOCKED_POPUP');
    expect(parseNeedsHelpErrorCode('CONTRACT_VIOLATION_UNTYPED_NEEDS_HELP')).toBe(
      'CONTRACT_VIOLATION_UNTYPED_NEEDS_HELP',
    );
    expect(parseNeedsHelpErrorCode('NOT_A_REAL_CODE')).toBeNull();
    expect(parseNeedsHelpErrorCode(null)).toBeNull();
  });
});
