import { MessageContentType } from '@bytebot/shared';
import type { MessageContentBlock } from '@bytebot/shared';
import { Role } from '@prisma/client';
import type { Message } from '@prisma/client';

export type UiRepairRationaleCode = 'CLOSE_X' | 'DISMISS_BUTTON' | 'CLICK_AWAY';

export type UiRepairCandidate = {
  x: number;
  y: number;
  confidence: number;
  rationaleCode: UiRepairRationaleCode;
};

export type UiRepairCandidateParseResult =
  | { ok: true; candidate: UiRepairCandidate }
  | { ok: false; error: string };

export type PngDimensions = { width: number; height: number };

export function buildUiRepairClassifierSystemPrompt(): string {
  return `
You are a strict UI repair classifier for a desktop automation system.

Task:
- You will receive a single desktop screenshot.
- Determine whether there is a SAFE, non-destructive action to dismiss a blocking modal/popup/overlay.

Output:
- Reply with ONLY valid JSON (no Markdown, no prose).
- Schema:
  {
    "x": number,
    "y": number,
    "confidence": number,  // 0.0 to 1.0
    "rationale_code": "CLOSE_X" | "DISMISS_BUTTON" | "CLICK_AWAY"
  }

Rules:
- Prefer CLOSE_X (top-right close icon on a modal/popup).
- Use DISMISS_BUTTON only if it clearly DISMISSES the overlay (e.g., "Close", "Dismiss", "Not now", "No thanks", "Cancel").
- Use CLICK_AWAY only if the overlay is a click-away popover and there is a safe empty area to click that will not navigate.
- If you are not confident, set confidence to 0.0 and use CLOSE_X with x=0,y=0.
`.trim();
}

export function buildUiRepairClassifierMessage(input: {
  taskId: string;
  screenshotBase64Png: string;
}): Message {
  const blocks: MessageContentBlock[] = [
    {
      type: MessageContentType.Text,
      text: 'Find a safe dismiss action for any blocking modal/popup in this screenshot.',
    } as any,
    {
      type: MessageContentType.Image,
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: input.screenshotBase64Png,
      },
    } as any,
  ];

  return {
    id: '',
    createdAt: new Date(),
    updatedAt: new Date(),
    taskId: input.taskId,
    summaryId: null,
    role: Role.USER,
    content: blocks as any,
  } as Message;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end < 0 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

export function parseUiRepairCandidate(
  text: string,
): UiRepairCandidateParseResult {
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return { ok: false, error: 'No JSON object found in classifier response' };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error: any) {
    return { ok: false, error: `Invalid JSON: ${error.message}` };
  }

  const x = typeof parsed?.x === 'number' ? parsed.x : NaN;
  const y = typeof parsed?.y === 'number' ? parsed.y : NaN;
  const confidence =
    typeof parsed?.confidence === 'number' ? parsed.confidence : NaN;
  const rationaleCodeRaw =
    typeof parsed?.rationale_code === 'string' ? parsed.rationale_code : '';

  const rationaleCode = rationaleCodeRaw.trim().toUpperCase();
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(confidence)
  ) {
    return {
      ok: false,
      error: 'Missing or invalid numeric fields (x,y,confidence)',
    };
  }

  const allowed: UiRepairRationaleCode[] = [
    'CLOSE_X',
    'DISMISS_BUTTON',
    'CLICK_AWAY',
  ];
  if (!allowed.includes(rationaleCode as UiRepairRationaleCode)) {
    return { ok: false, error: `Invalid rationale_code: ${rationaleCodeRaw}` };
  }

  return {
    ok: true,
    candidate: {
      x,
      y,
      confidence,
      rationaleCode: rationaleCode as UiRepairRationaleCode,
    },
  };
}

export function decodePngDimensionsFromBase64(
  base64Png: string,
): PngDimensions | null {
  try {
    const buffer = Buffer.from(base64Png, 'base64');
    // PNG signature (8 bytes)
    if (buffer.length < 24) return null;
    const signature = buffer.subarray(0, 8);
    const pngSig = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    if (!signature.equals(pngSig)) return null;

    // IHDR chunk starts at byte 8:
    // 4 bytes length, 4 bytes type ("IHDR"), then 4 width, 4 height
    const ihdrType = buffer.subarray(12, 16).toString('ascii');
    if (ihdrType !== 'IHDR') return null;

    const width = buffer.readUInt32BE(16);
    const height = buffer.readUInt32BE(20);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  }
}

export function validateUiRepairCandidate(input: {
  candidate: UiRepairCandidate;
  dimensions: PngDimensions;
  minConfidence: number;
}): { ok: true } | { ok: false; error: string } {
  const { candidate, dimensions, minConfidence } = input;
  const { width, height } = dimensions;

  if (candidate.confidence < minConfidence) {
    return {
      ok: false,
      error: `confidence ${candidate.confidence} < ${minConfidence}`,
    };
  }

  if (
    !Number.isFinite(candidate.x) ||
    !Number.isFinite(candidate.y) ||
    candidate.x < 0 ||
    candidate.y < 0 ||
    candidate.x >= width ||
    candidate.y >= height
  ) {
    return { ok: false, error: 'coordinates out of bounds' };
  }

  // Conservative “danger zone” rules:
  // - Prefer top-right close icons.
  // - Only accept other actions if they still land in conservative, low-risk regions.
  const xNorm = candidate.x / width;
  const yNorm = candidate.y / height;

  switch (candidate.rationaleCode) {
    case 'CLOSE_X': {
      // Close icons are typically in the top-right corner of a modal/popup.
      // Accept only a tight safe region: x ∈ [0.80..1.00), y ∈ [0.00..0.25].
      if (xNorm < 0.8 || yNorm > 0.25) {
        return {
          ok: false,
          error: 'CLOSE_X must be in tight top-right region',
        };
      }
      break;
    }
    case 'DISMISS_BUTTON': {
      // Dismiss buttons are riskier than a close icon; keep this very conservative.
      // Accept only a right-side region: x ∈ [0.65..1.00), y ∈ [0.00..0.70].
      if (xNorm < 0.65 || yNorm > 0.7) {
        return {
          ok: false,
          error: 'DISMISS_BUTTON must be in conservative right-side region',
        };
      }
      break;
    }
    case 'CLICK_AWAY': {
      // Only allow click-away in a small top-left corner region to reduce risk of clicking results/buttons.
      if (xNorm > 0.12 || yNorm > 0.12) {
        return {
          ok: false,
          error: 'CLICK_AWAY must be in conservative corner region',
        };
      }
      break;
    }
  }

  return { ok: true };
}
