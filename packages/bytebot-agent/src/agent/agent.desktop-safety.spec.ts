import {
  DESKTOP_MAX_KEY_HOLD_MS,
  DesktopLoopDetector,
  buildDesktopActionSignature,
  hammingDistanceHex,
  normalizeComputerToolUseBlock,
} from './agent.desktop-safety';
import { MessageContentType } from '@bytebot/shared';

describe('agent.desktop-safety', () => {
  describe('normalizeComputerToolUseBlock', () => {
    it('rewrites non-modifier press_keys down into a tap (type_keys)', () => {
      const block: any = {
        type: MessageContentType.ToolUse,
        id: 't1',
        name: 'computer_press_keys',
        input: { keys: ['Enter'], press: 'down' },
      };

      const normalized = normalizeComputerToolUseBlock(block);
      expect(normalized.normalizedBlock.name).toBe('computer_type_keys');
      expect(normalized.rewriteReason).toBe('non_modifier_down_to_tap');
    });

    it('rewrites modifier press_keys down without holdMs into a tap (type_keys)', () => {
      const block: any = {
        type: MessageContentType.ToolUse,
        id: 't2',
        name: 'computer_press_keys',
        input: { keys: ['Shift'], press: 'down' },
      };

      const normalized = normalizeComputerToolUseBlock(block);
      expect(normalized.normalizedBlock.name).toBe('computer_type_keys');
      expect(normalized.rewriteReason).toBe(
        'modifier_down_missing_holdms_to_tap',
      );
    });

    it('clamps holdMs for modifier holds', () => {
      const block: any = {
        type: MessageContentType.ToolUse,
        id: 't3',
        name: 'computer_press_keys',
        input: { keys: ['Shift'], press: 'down', holdMs: 5000 },
      };

      const normalized = normalizeComputerToolUseBlock(block);
      expect(normalized.normalizedBlock.name).toBe('computer_press_keys');
      expect((normalized.normalizedBlock as any).input.holdMs).toBe(
        DESKTOP_MAX_KEY_HOLD_MS,
      );
      expect(normalized.rewriteReason).toBe('modifier_holdms_clamped');
    });
  });

  describe('hammingDistanceHex', () => {
    it('computes correct nibble popcount distance', () => {
      expect(hammingDistanceHex('ff', '00')).toBe(8);
      expect(hammingDistanceHex('0f', '00')).toBe(4);
      expect(hammingDistanceHex('0f', '0f')).toBe(0);
    });
  });

  describe('DesktopLoopDetector', () => {
    it('interrupts on repeated same action with no meaningful hash change', () => {
      const detector = new DesktopLoopDetector();

      let interrupted = false;
      for (let i = 0; i < 6; i++) {
        const res = detector.record({
          atMs: Date.now(),
          signature: 'computer_type_keys(keys=Enter)',
          screenshotHash: 'ffffffffffffffff',
        });
        interrupted = res.interrupt;
      }

      expect(interrupted).toBe(true);
    });

    it('does not interrupt if the screen hash meaningfully changes during the streak', () => {
      const detector = new DesktopLoopDetector();

      const hashes = [
        'ffffffffffffffff',
        '0000000000000000',
        'ffffffffffffffff',
        '0000000000000000',
        'ffffffffffffffff',
        '0000000000000000',
      ];

      let interrupted = false;
      for (let i = 0; i < hashes.length; i++) {
        const res = detector.record({
          atMs: Date.now(),
          signature: 'computer_type_keys(keys=Enter)',
          screenshotHash: hashes[i],
        });
        interrupted = res.interrupt;
      }

      expect(interrupted).toBe(false);
    });

    it('interrupts on repeated waits even if the screen hash changes (spinner/animation case)', () => {
      const detector = new DesktopLoopDetector();

      const hashes = [
        'ffffffffffffffff',
        '0000000000000000',
        'ffffffffffffffff',
        '0000000000000000',
        'ffffffffffffffff',
        '0000000000000000',
      ];

      let interrupted = false;
      for (let i = 0; i < hashes.length; i++) {
        const res = detector.record({
          atMs: Date.now(),
          signature: 'computer_wait',
          screenshotHash: hashes[i],
        });
        interrupted = res.interrupt;
      }

      expect(interrupted).toBe(true);
    });

    it('interrupts on alternating click/move loops within a window (non-consecutive repeats)', () => {
      const detector = new DesktopLoopDetector();

      const clickSig =
        'computer_click_mouse(bucket=38,29,button=left,clickCount=1)';
      const moveSig = 'computer_move_mouse(bucket=38,29)';

      let interrupted = false;
      for (let i = 0; i < 12; i++) {
        const signature = i % 2 === 0 ? moveSig : clickSig;
        const res = detector.record({
          atMs: Date.now(),
          signature,
          screenshotHash: 'ffffffffffffffff',
        });
        interrupted = res.interrupt;
        if (interrupted) break;
      }

      expect(interrupted).toBe(true);
    });

    it('interrupts on alternating click/move loops even when hashes jitter (animated page case)', () => {
      const detector = new DesktopLoopDetector();

      const clickSig =
        'computer_click_mouse(bucket=38,29,button=left,clickCount=1)';
      const moveSig = 'computer_move_mouse(bucket=38,29)';

      // Hamming distance between these is 8 (fails "no change"<=6, passes animated<=12).
      const h1 = 'ffffffffffffffff';
      const h2 = '00ffffffffffffff';

      let lastRule: string | undefined;
      for (let i = 0; i < 12; i++) {
        const signature = i % 2 === 0 ? moveSig : clickSig;
        const res = detector.record({
          atMs: Date.now(),
          signature,
          screenshotHash: i % 2 === 0 ? h1 : h2,
        });
        if (res.interrupt) {
          lastRule = res.rule;
          break;
        }
      }

      expect(lastRule).toBe('repeat_in_window_animated_no_progress');
    });

    it('interrupts on excessive waits within a window when the screen jitters (non-consecutive waits)', () => {
      const detector = new DesktopLoopDetector();

      const h1 = 'ffffffffffffffff';
      const h2 = '00ffffffffffffff';

      let lastRule: string | undefined;
      for (let i = 0; i < 24; i++) {
        const signature =
          i % 2 === 0 ? 'computer_wait' : 'computer_move_mouse(bucket=0,0)';
        const res = detector.record({
          atMs: Date.now(),
          signature,
          screenshotHash: i % 2 === 0 ? h1 : h2,
        });
        if (res.interrupt) {
          lastRule = res.rule;
          break;
        }
      }

      expect(lastRule).toBe('wait_in_window_excessive');
    });
  });

  describe('buildDesktopActionSignature', () => {
    it('does not include raw text for type_text', () => {
      const block: any = {
        type: MessageContentType.ToolUse,
        id: 't4',
        name: 'computer_type_text',
        input: { text: 'super secret password', isSensitive: true },
      };
      const sig = buildDesktopActionSignature(block);
      expect(sig).toContain('len=');
      expect(sig).toContain('sensitive=true');
      expect(sig).not.toContain('super secret password');
    });
  });
});
