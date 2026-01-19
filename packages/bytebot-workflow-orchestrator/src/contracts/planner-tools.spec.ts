import { normalizeSuggestedToolsOrThrow } from './planner-tools';

describe('planner-tools', () => {
  describe('normalizeSuggestedToolsOrThrow', () => {
    it('normalizes execution tool alias web_browser -> browser', () => {
      expect(
        normalizeSuggestedToolsOrThrow({
          suggestedTools: ['web_browser'],
          allowedTools: null,
        }),
      ).toEqual(['browser']);
    });
  });
});

