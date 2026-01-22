import {
  decodePngDimensionsFromBase64,
  parseUiRepairCandidate,
  validateUiRepairCandidate,
} from './agent.desktop-repair';

describe('agent.desktop-repair', () => {
  describe('parseUiRepairCandidate', () => {
    it('parses valid JSON with rationale_code', () => {
      const res = parseUiRepairCandidate(
        JSON.stringify({
          x: 10,
          y: 20,
          confidence: 0.9,
          rationale_code: 'CLOSE_X',
        }),
      );
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.candidate.rationaleCode).toBe('CLOSE_X');
        expect(res.candidate.x).toBe(10);
        expect(res.candidate.y).toBe(20);
      }
    });

    it('rejects missing JSON', () => {
      const res = parseUiRepairCandidate('nope');
      expect(res.ok).toBe(false);
    });

    it('rejects invalid rationale_code', () => {
      const res = parseUiRepairCandidate(
        JSON.stringify({
          x: 10,
          y: 20,
          confidence: 0.9,
          rationale_code: 'DELETE_ALL',
        }),
      );
      expect(res.ok).toBe(false);
    });
  });

  describe('decodePngDimensionsFromBase64', () => {
    it('extracts width/height from a tiny PNG', () => {
      // 1x1 transparent PNG
      const base64 =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PF2K1QAAAABJRU5ErkJggg==';
      const dims = decodePngDimensionsFromBase64(base64);
      expect(dims).toEqual({ width: 1, height: 1 });
    });
  });

  describe('validateUiRepairCandidate', () => {
    it('accepts CLOSE_X in top-right region across multiple viewport sizes', () => {
      const viewports = [
        { width: 100, height: 100 },
        { width: 800, height: 600 },
        { width: 1366, height: 768 },
        { width: 1920, height: 1080 },
      ];

      for (const vp of viewports) {
        const res = validateUiRepairCandidate({
          candidate: {
            x: Math.floor(vp.width * 0.9),
            y: Math.floor(vp.height * 0.1),
            confidence: 0.9,
            rationaleCode: 'CLOSE_X',
          },
          dimensions: vp,
          minConfidence: 0.7,
        });
        expect(res.ok).toBe(true);
      }
    });

    it('rejects CLOSE_X outside top-right region', () => {
      const res = validateUiRepairCandidate({
        candidate: { x: 10, y: 90, confidence: 0.9, rationaleCode: 'CLOSE_X' },
        dimensions: { width: 100, height: 100 },
        minConfidence: 0.7,
      });
      expect(res.ok).toBe(false);
    });

    it('accepts DISMISS_BUTTON only in conservative right-side region', () => {
      const viewports = [
        { width: 320, height: 240 },
        { width: 1024, height: 768 },
        { width: 1920, height: 1080 },
      ];

      for (const vp of viewports) {
        const res = validateUiRepairCandidate({
          candidate: {
            x: Math.floor(vp.width * 0.85),
            y: Math.floor(vp.height * 0.5),
            confidence: 0.95,
            rationaleCode: 'DISMISS_BUTTON',
          },
          dimensions: vp,
          minConfidence: 0.7,
        });
        expect(res.ok).toBe(true);
      }
    });

    it('rejects low confidence', () => {
      const res = validateUiRepairCandidate({
        candidate: { x: 90, y: 10, confidence: 0.2, rationaleCode: 'CLOSE_X' },
        dimensions: { width: 100, height: 100 },
        minConfidence: 0.7,
      });
      expect(res.ok).toBe(false);
    });
  });
});
