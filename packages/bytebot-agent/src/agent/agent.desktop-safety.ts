import {
  ComputerToolUseContentBlock,
  MessageContentType,
} from '@bytebot/shared';

export const DESKTOP_MAX_ACTIONS_WITHOUT_OBSERVATION = parseInt(
  process.env.BYTEBOT_DESKTOP_MAX_ACTIONS_WITHOUT_OBSERVATION || '3',
  10,
);

export const DESKTOP_MAX_KEY_HOLD_MS = parseInt(
  process.env.BYTEBOT_DESKTOP_MAX_KEY_HOLD_MS || '750',
  10,
);

export const DESKTOP_LOOP_REPEAT_THRESHOLD = parseInt(
  process.env.BYTEBOT_DESKTOP_LOOP_REPEAT_THRESHOLD || '6',
  10,
);

export const DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING = parseInt(
  process.env.BYTEBOT_DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING || '6',
  10,
);

// Secondary stability threshold to tolerate animated pages/spinners.
// Used only for loop detection heuristics; "meaningful progress" still uses the primary threshold above.
export const DESKTOP_LOOP_ANIMATED_MAX_HAMMING = parseInt(
  process.env.BYTEBOT_DESKTOP_LOOP_ANIMATED_MAX_HAMMING || '12',
  10,
);

export const DESKTOP_LOOP_RECENT_ACTIONS_MAX = parseInt(
  process.env.BYTEBOT_DESKTOP_LOOP_RECENT_ACTIONS_MAX || '25',
  10,
);

export const DESKTOP_LOOP_COORDINATE_BUCKET_PX = parseInt(
  process.env.BYTEBOT_DESKTOP_LOOP_COORDINATE_BUCKET_PX || '20',
  10,
);

export const DESKTOP_LOOP_WAIT_IN_WINDOW_THRESHOLD = parseInt(
  process.env.BYTEBOT_DESKTOP_LOOP_WAIT_IN_WINDOW_THRESHOLD || '12',
  10,
);

export const DESKTOP_LOOP_REPAIR_ENABLED =
  (process.env.BYTEBOT_DESKTOP_LOOP_REPAIR_ENABLED || '')
    .trim()
    .toLowerCase() === 'true';

export const DESKTOP_LOOP_REPAIR_ATTEMPT2_ENABLED =
  (process.env.BYTEBOT_DESKTOP_LOOP_REPAIR_ATTEMPT2_ENABLED || '')
    .trim()
    .toLowerCase() === 'true';

export const DESKTOP_LOOP_REPAIR_ATTEMPT2_MIN_CONFIDENCE = (() => {
  const raw = (
    process.env.BYTEBOT_DESKTOP_LOOP_REPAIR_ATTEMPT2_MIN_CONFIDENCE || '0.7'
  ).trim();
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return 0.7;
  return Math.min(Math.max(value, 0), 1);
})();

export const DESKTOP_LOOP_REPAIR_EPISODE_MAX_MS = parseInt(
  process.env.BYTEBOT_DESKTOP_LOOP_REPAIR_EPISODE_MAX_MS || '120000',
  10,
);

export const DESKTOP_TOOL_CONTRACT_VIOLATION_LIMIT = parseInt(
  process.env.BYTEBOT_DESKTOP_TOOL_CONTRACT_VIOLATION_LIMIT || '10',
  10,
);

const MODIFIER_KEY_NAMES = new Set([
  'shift',
  'shift_l',
  'shift_r',
  'control',
  'ctrl',
  'control_l',
  'control_r',
  'alt',
  'alt_l',
  'alt_r',
  'meta',
  'meta_l',
  'meta_r',
  'super',
  'super_l',
  'super_r',
  'cmd',
  'command',
  'option',
]);

export function isModifierKeyName(key: string): boolean {
  const normalized = key.trim().toLowerCase();
  if (!normalized) return false;
  if (MODIFIER_KEY_NAMES.has(normalized)) return true;

  return (
    normalized.startsWith('shift') ||
    normalized.startsWith('control') ||
    normalized.startsWith('ctrl') ||
    normalized.startsWith('alt') ||
    normalized.startsWith('meta') ||
    normalized.startsWith('super') ||
    normalized.startsWith('cmd') ||
    normalized.startsWith('command') ||
    normalized.startsWith('option')
  );
}

export type PressKeysNormalization = {
  normalizedBlock: ComputerToolUseContentBlock;
  rewriteReason?:
    | 'non_modifier_down_to_tap'
    | 'modifier_down_missing_holdms_to_tap'
    | 'modifier_holdms_clamped'
    | 'none';
  rewrittenKeys?: string[];
  holdMs?: number | null;
};

export function normalizeComputerToolUseBlock(
  block: ComputerToolUseContentBlock,
): PressKeysNormalization {
  if (block.name !== 'computer_press_keys') {
    return { normalizedBlock: block, rewriteReason: 'none' };
  }

  const input = (block as any).input as Record<string, unknown> | undefined;
  const keys = Array.isArray(input?.keys)
    ? (input.keys as unknown[]).filter(
        (k): k is string => typeof k === 'string',
      )
    : [];
  const press =
    input?.press === 'down' || input?.press === 'up' ? input.press : 'down';

  const holdMsRaw =
    typeof input?.holdMs === 'number'
      ? input.holdMs
      : typeof input?.hold_ms === 'number'
        ? (input as any).hold_ms
        : null;

  const holdMs =
    typeof holdMsRaw === 'number' &&
    Number.isFinite(holdMsRaw) &&
    holdMsRaw >= 0
      ? Math.min(Math.floor(holdMsRaw), DESKTOP_MAX_KEY_HOLD_MS)
      : null;

  const nonModifiers = keys.filter((k) => !isModifierKeyName(k));

  if (press === 'down' && nonModifiers.length > 0) {
    return {
      normalizedBlock: {
        type: MessageContentType.ToolUse,
        id: block.id,
        name: 'computer_type_keys',
        input: {
          keys,
          delay: 75,
        },
      },
      rewriteReason: 'non_modifier_down_to_tap',
      rewrittenKeys: nonModifiers,
      holdMs: null,
    };
  }

  if (press === 'down' && nonModifiers.length === 0 && holdMs === null) {
    return {
      normalizedBlock: {
        type: MessageContentType.ToolUse,
        id: block.id,
        name: 'computer_type_keys',
        input: {
          keys,
          delay: 75,
        },
      },
      rewriteReason: 'modifier_down_missing_holdms_to_tap',
      rewrittenKeys: keys,
      holdMs: null,
    };
  }

  if (press === 'down' && holdMsRaw !== null && holdMsRaw !== holdMs) {
    return {
      normalizedBlock: {
        ...block,
        input: {
          ...(block as any).input,
          holdMs,
        },
      } as ComputerToolUseContentBlock,
      rewriteReason: 'modifier_holdms_clamped',
      rewrittenKeys: keys,
      holdMs,
    };
  }

  if (press === 'down' && holdMs !== null) {
    return {
      normalizedBlock: {
        ...block,
        input: {
          ...(block as any).input,
          holdMs,
        },
      } as ComputerToolUseContentBlock,
      rewriteReason: 'none',
      rewrittenKeys: [],
      holdMs,
    };
  }

  return { normalizedBlock: block, rewriteReason: 'none' };
}

export type DesktopActionSample = {
  atMs: number;
  signature: string;
  screenshotHash?: string | null;
};

const NIBBLE_POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

export function hammingDistanceHex(a: string, b: string): number {
  const aa = a.trim().toLowerCase();
  const bb = b.trim().toLowerCase();
  if (aa.length !== bb.length) return Number.POSITIVE_INFINITY;

  let distance = 0;
  for (let i = 0; i < aa.length; i++) {
    const x = parseInt(aa[i], 16);
    const y = parseInt(bb[i], 16);
    if (Number.isNaN(x) || Number.isNaN(y)) return Number.POSITIVE_INFINITY;
    distance += NIBBLE_POPCOUNT[x ^ y];
  }
  return distance;
}

export class DesktopLoopDetector {
  private recent: DesktopActionSample[] = [];
  private consecutiveWaitCount = 0;

  record(sample: DesktopActionSample): {
    interrupt: boolean;
    rule?: string;
    signature?: string;
    count?: number;
  } {
    this.recent.push(sample);
    if (this.recent.length > DESKTOP_LOOP_RECENT_ACTIONS_MAX) {
      this.recent.shift();
    }

    const signature = sample.signature;
    const hash = sample.screenshotHash ?? null;
    const actionType = signature.split('(')[0] || signature;

    if (actionType === 'computer_wait') {
      this.consecutiveWaitCount++;
    } else {
      this.consecutiveWaitCount = 0;
    }

    // Special-case: repeated waits are a strong signal of a stalled control loop,
    // even if the screen hash changes due to animations/spinners.
    if (this.consecutiveWaitCount >= DESKTOP_LOOP_REPEAT_THRESHOLD) {
      return { interrupt: true, rule: 'wait_loop_excessive' };
    }

    const waitCountInWindow = this.recent.filter((r) => {
      const t = r.signature.split('(')[0] || r.signature;
      return t === 'computer_wait';
    }).length;

    const hashes = this.recent
      .map((r) => r.screenshotHash)
      .filter((h): h is string => typeof h === 'string' && h.trim().length > 0);

    // Require multiple observations to assert "no progress" robustly.
    const stableHashWindowSize = 3;
    const recentHashes = hashes.slice(-stableHashWindowSize);
    const hasStableObservationWindow =
      recentHashes.length >= stableHashWindowSize &&
      recentHashes.every(
        (h) =>
          hammingDistanceHex(recentHashes[0], h) <=
          DESKTOP_LOOP_NO_CHANGE_MAX_HAMMING,
      );

    const hasAnimatedObservationWindow =
      !hasStableObservationWindow &&
      recentHashes.length >= stableHashWindowSize &&
      recentHashes.every(
        (h) =>
          hammingDistanceHex(recentHashes[0], h) <=
          DESKTOP_LOOP_ANIMATED_MAX_HAMMING,
      );

    // Animated/spinner case: tolerate small hash jitter while still stopping obvious repeats.
    if (
      hasAnimatedObservationWindow &&
      waitCountInWindow >= DESKTOP_LOOP_WAIT_IN_WINDOW_THRESHOLD
    ) {
      return { interrupt: true, rule: 'wait_in_window_excessive' };
    }

    if (
      (!hasStableObservationWindow && !hasAnimatedObservationWindow) ||
      !hash
    ) {
      return { interrupt: false };
    }

    const signatureCounts = new Map<string, number>();
    for (const r of this.recent) {
      signatureCounts.set(
        r.signature,
        (signatureCounts.get(r.signature) || 0) + 1,
      );
    }

    let topSignature: string | null = null;
    let topCount = 0;
    for (const [sig, count] of signatureCounts.entries()) {
      if (count > topCount) {
        topSignature = sig;
        topCount = count;
      }
    }

    if (topSignature && topCount >= DESKTOP_LOOP_REPEAT_THRESHOLD) {
      if (hasStableObservationWindow) {
        return {
          interrupt: true,
          rule: 'repeat_in_window_no_progress',
          signature: topSignature,
          count: topCount,
        };
      }

      // Conservative: only trip the animated/jitter-tolerant rule for click/move bucket loops.
      const topType = (topSignature.split('(')[0] || topSignature).trim();
      if (
        topType === 'computer_click_mouse' ||
        topType === 'computer_move_mouse'
      ) {
        return {
          interrupt: true,
          rule: 'repeat_in_window_animated_no_progress',
          signature: topSignature,
          count: topCount,
        };
      }
    }

    return { interrupt: false };
  }

  getRecent(): DesktopActionSample[] {
    return [...this.recent];
  }
}

export function buildDesktopActionSignature(
  block: ComputerToolUseContentBlock,
): string {
  const name = block.name;
  const input = (block as any).input as Record<string, unknown> | undefined;

  const bucket = (coordinates?: { x: number; y: number } | null): string => {
    if (
      !coordinates ||
      typeof coordinates.x !== 'number' ||
      typeof coordinates.y !== 'number' ||
      !Number.isFinite(coordinates.x) ||
      !Number.isFinite(coordinates.y)
    ) {
      return '∅';
    }
    const bx = Math.floor(coordinates.x / DESKTOP_LOOP_COORDINATE_BUCKET_PX);
    const by = Math.floor(coordinates.y / DESKTOP_LOOP_COORDINATE_BUCKET_PX);
    return `${bx},${by}`;
  };

  switch (name) {
    case 'computer_move_mouse': {
      const coordinates =
        input?.coordinates &&
        typeof input.coordinates === 'object' &&
        typeof (input as any).coordinates.x === 'number' &&
        typeof (input as any).coordinates.y === 'number'
          ? ((input as any).coordinates as { x: number; y: number })
          : null;
      return `${name}(bucket=${bucket(coordinates)})`;
    }
    case 'computer_type_keys': {
      const keys = Array.isArray(input?.keys)
        ? (input.keys as unknown[]).filter(
            (k): k is string => typeof k === 'string',
          )
        : [];
      return `${name}(keys=${keys.join('+') || '∅'})`;
    }
    case 'computer_press_keys': {
      const keys = Array.isArray(input?.keys)
        ? (input.keys as unknown[]).filter(
            (k): k is string => typeof k === 'string',
          )
        : [];
      const press =
        input?.press === 'down' || input?.press === 'up' ? input.press : 'down';
      const holdMs =
        typeof input?.holdMs === 'number'
          ? Math.floor(input.holdMs)
          : typeof (input as any)?.hold_ms === 'number'
            ? Math.floor((input as any).hold_ms)
            : null;
      return `${name}(press=${press},keys=${keys.join('+') || '∅'},holdMs=${holdMs ?? '∅'})`;
    }
    case 'computer_type_text': {
      const text = typeof input?.text === 'string' ? input.text : '';
      const isSensitive =
        typeof input?.isSensitive === 'boolean' ? input.isSensitive : false;
      return `${name}(len=${text.length},hasNewline=${text.includes('\n')},sensitive=${isSensitive})`;
    }
    case 'computer_paste_text': {
      const text = typeof input?.text === 'string' ? input.text : '';
      const isSensitive =
        typeof input?.isSensitive === 'boolean' ? input.isSensitive : false;
      return `${name}(len=${text.length},hasNewline=${text.includes('\n')},sensitive=${isSensitive})`;
    }
    case 'computer_wait': {
      return name;
    }
    case 'computer_click_mouse': {
      const button = typeof input?.button === 'string' ? input.button : 'left';
      const clickCount =
        typeof input?.clickCount === 'number' ? input.clickCount : 1;
      const coordinates =
        input?.coordinates &&
        typeof input.coordinates === 'object' &&
        typeof (input as any).coordinates.x === 'number' &&
        typeof (input as any).coordinates.y === 'number'
          ? ((input as any).coordinates as { x: number; y: number })
          : null;
      return `${name}(bucket=${bucket(coordinates)},button=${button},clickCount=${clickCount})`;
    }
    case 'computer_press_mouse': {
      const button = typeof input?.button === 'string' ? input.button : 'left';
      const press =
        input?.press === 'down' || input?.press === 'up' ? input.press : 'down';
      const coordinates =
        input?.coordinates &&
        typeof input.coordinates === 'object' &&
        typeof (input as any).coordinates.x === 'number' &&
        typeof (input as any).coordinates.y === 'number'
          ? ((input as any).coordinates as { x: number; y: number })
          : null;
      return `${name}(bucket=${bucket(coordinates)},button=${button},press=${press})`;
    }
    case 'computer_scroll': {
      const direction =
        typeof input?.direction === 'string' ? input.direction : 'down';
      const scrollCount =
        typeof input?.scrollCount === 'number' ? input.scrollCount : 1;
      const coordinates =
        input?.coordinates &&
        typeof input.coordinates === 'object' &&
        typeof (input as any).coordinates.x === 'number' &&
        typeof (input as any).coordinates.y === 'number'
          ? ((input as any).coordinates as { x: number; y: number })
          : null;
      return `${name}(bucket=${bucket(coordinates)},direction=${direction},scrollCount=${scrollCount})`;
    }
    default:
      return name;
  }
}
