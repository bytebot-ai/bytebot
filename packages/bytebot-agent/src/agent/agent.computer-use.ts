import {
  Button,
  Coordinates,
  Press,
  ComputerToolUseContentBlock,
  ToolResultContentBlock,
  MessageContentType,
  isScreenshotToolUseBlock,
  isCursorPositionToolUseBlock,
  isMoveMouseToolUseBlock,
  isTraceMouseToolUseBlock,
  isClickMouseToolUseBlock,
  isPressMouseToolUseBlock,
  isDragMouseToolUseBlock,
  isScrollToolUseBlock,
  isTypeKeysToolUseBlock,
  isPressKeysToolUseBlock,
  isTypeTextToolUseBlock,
  isWaitToolUseBlock,
  isApplicationToolUseBlock,
  isPasteTextToolUseBlock,
  isReadFileToolUseBlock,
} from '@bytebot/shared';
import { Logger } from '@nestjs/common';
import { buildDesktopActionSignature, isModifierKeyName } from './agent.desktop-safety';

/**
 * Fallback desktop URL for legacy mode (Phase 6 not deployed)
 */
const FALLBACK_DESKTOP_URL = process.env.BYTEBOT_DESKTOP_BASE_URL as string;

/**
 * Phase 4: Error class for execution surface constraint violations
 */
export class DesktopRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopRequiredError';
  }
}

/**
 * Get the desktop URL to use for API calls
 * Phase 4: Now validates desktop requirement before falling back
 * @param desktopUrl - Per-task desktop URL from task controller (Phase 6)
 * @param requiresDesktop - Whether this task requires a desktop pod (Phase 4)
 * @returns The URL to use for desktop API calls
 * @throws DesktopRequiredError if desktop is required but not available
 */
function getDesktopUrl(desktopUrl?: string, requiresDesktop?: boolean): string {
  // If desktop is explicitly required, we must have a per-task URL
  if (requiresDesktop && !desktopUrl) {
    throw new DesktopRequiredError(
      'Task requires desktop but no desktop pod is assigned. ' +
      'Ensure task has a desktop pod before executing desktop tools.',
    );
  }

  // Log warning when falling back (but allow for non-required tasks)
  if (!desktopUrl && FALLBACK_DESKTOP_URL) {
    console.warn(
      '[Phase 4 Warning] Using fallback desktop URL. ' +
      'For production, ensure desktop pods are properly assigned.',
    );
  }

  return desktopUrl || FALLBACK_DESKTOP_URL;
}

/**
 * Context for action execution (Phase 6.4)
 */
export interface ActionContext {
  taskId: string;
  desktopUrl?: string;
  // Phase 4: Execution surface constraint
  requiresDesktop?: boolean;
  onAction?: (action: ActionResult) => void;
}

/**
 * Result of an action execution (for logging)
 */
export interface ActionResult {
  actionType: string;
  success: boolean;
  durationMs: number;
  coordinates?: { x: number; y: number };
  errorMessage?: string;
  input?: Record<string, unknown>;
  actionSignature?: string;
  screenshotHash?: string;
  screenshotCaptured?: boolean;
}

/**
 * Handle computer tool use with optional per-task context
 * @param block - The computer tool use content block from LLM
 * @param logger - Logger instance
 * @param context - Optional action context with per-task desktop URL (Phase 6.4)
 */
export async function handleComputerToolUse(
  block: ComputerToolUseContentBlock,
  logger: Logger,
  context?: ActionContext,
): Promise<ToolResultContentBlock> {
  // Phase 4: Pass requiresDesktop to enable fail-fast validation
  const desktopUrl = getDesktopUrl(context?.desktopUrl, context?.requiresDesktop);
  logger.debug(
    `Handling computer tool use: ${block.name}, tool_use_id: ${block.id}`,
  );

  // Helper to report action results
  const reportAction = (result: ActionResult) => {
    if (context?.onAction) {
      context.onAction(result);
    }
  };

  if (isScreenshotToolUseBlock(block)) {
    logger.debug('Processing screenshot request');
    const actionSignature = buildDesktopActionSignature(block);
    const startTime = Date.now();
    try {
      logger.debug('Taking screenshot');
      const shot = await screenshot(desktopUrl);
      logger.debug('Screenshot captured successfully');

      reportAction({
        actionType: block.name,
        success: true,
        durationMs: Date.now() - startTime,
        actionSignature,
        screenshotHash: shot.imageHash,
        screenshotCaptured: true,
        input: { signature: actionSignature },
      });

      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Image,
            source: {
              data: shot.image,
              media_type: 'image/png',
              type: 'base64',
            },
          },
        ],
      };
    } catch (error) {
      logger.error(`Screenshot failed: ${error.message}`, error.stack);
      reportAction({
        actionType: block.name,
        success: false,
        durationMs: Date.now() - startTime,
        errorMessage: error.message,
        actionSignature,
        screenshotCaptured: false,
        input: { signature: actionSignature },
      });
      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Text,
            text: 'ERROR: Failed to take screenshot',
          },
        ],
        is_error: true,
      };
    }
  }

  if (isCursorPositionToolUseBlock(block)) {
    logger.debug('Processing cursor position request');
    const actionSignature = buildDesktopActionSignature(block);
    const startTime = Date.now();
    try {
      logger.debug('Getting cursor position');
      const position = await cursorPosition(desktopUrl);
      logger.debug(`Cursor position obtained: ${position.x}, ${position.y}`);

      reportAction({
        actionType: block.name,
        success: true,
        durationMs: Date.now() - startTime,
        coordinates: position,
        actionSignature,
        screenshotCaptured: false,
        input: { signature: actionSignature },
      });

      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Text,
            text: `Cursor position: ${position.x}, ${position.y}`,
          },
        ],
      };
    } catch (error) {
      logger.error(
        `Getting cursor position failed: ${error.message}`,
        error.stack,
      );
      reportAction({
        actionType: block.name,
        success: false,
        durationMs: Date.now() - startTime,
        errorMessage: error.message,
        actionSignature,
        screenshotCaptured: false,
        input: { signature: actionSignature },
      });
      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Text,
            text: 'ERROR: Failed to get cursor position',
          },
        ],
        is_error: true,
      };
    }
  }

  const startTime = Date.now();
  let actionType = block.name;
  let actionCoordinates: { x: number; y: number } | undefined;
  const actionSignature = buildDesktopActionSignature(block);

  try {
    if (isMoveMouseToolUseBlock(block)) {
      actionType = 'computer_move_mouse';
      actionCoordinates = block.input.coordinates;
      await moveMouse(block.input, desktopUrl);
    }
    if (isTraceMouseToolUseBlock(block)) {
      actionType = 'computer_trace_mouse';
      await traceMouse(block.input, desktopUrl);
    }
    if (isClickMouseToolUseBlock(block)) {
      actionType = 'computer_click_mouse';
      actionCoordinates = block.input.coordinates;
      await clickMouse(block.input, desktopUrl);
    }
    if (isPressMouseToolUseBlock(block)) {
      actionType = 'computer_press_mouse';
      actionCoordinates = block.input.coordinates;
      await pressMouse(block.input, desktopUrl);
    }
    if (isDragMouseToolUseBlock(block)) {
      actionType = 'computer_drag_mouse';
      await dragMouse(block.input, desktopUrl);
    }
    if (isScrollToolUseBlock(block)) {
      actionType = 'computer_scroll';
      actionCoordinates = block.input.coordinates;
      await scroll(block.input, desktopUrl);
    }
    if (isTypeKeysToolUseBlock(block)) {
      actionType = 'computer_type_keys';
      await typeKeys(block.input, desktopUrl);
    }
    if (isPressKeysToolUseBlock(block)) {
      actionType = 'computer_press_keys';
      await pressKeys(block.input, desktopUrl);
    }
    if (isTypeTextToolUseBlock(block)) {
      actionType = 'computer_type_text';
      await typeText(block.input, desktopUrl);
    }
    if (isPasteTextToolUseBlock(block)) {
      actionType = 'computer_paste_text';
      await pasteText(block.input, desktopUrl);
    }
    if (isWaitToolUseBlock(block)) {
      actionType = 'computer_wait';
      await wait(block.input, desktopUrl);
    }
    if (isApplicationToolUseBlock(block)) {
      actionType = 'computer_application';
      await application(block.input, desktopUrl);
    }
    if (isReadFileToolUseBlock(block)) {
      actionType = 'computer_read_file';
      logger.debug(`Reading file: ${block.input.path}`);
      const result = await readFile(block.input, desktopUrl);

      reportAction({
        actionType,
        success: result.success,
        durationMs: Date.now() - startTime,
        input: { path: block.input.path },
      });

      if (result.success && result.data) {
        // Return document content block
        return {
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          content: [
            {
              type: MessageContentType.Document,
              source: {
                type: 'base64',
                media_type: result.mediaType || 'application/octet-stream',
                data: result.data,
              },
              name: result.name || 'file',
              size: result.size,
            },
          ],
        };
      } else {
        // Return error message
        return {
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          content: [
            {
              type: MessageContentType.Text,
              text: result.message || 'Error reading file',
            },
          ],
          is_error: true,
        };
      }
    }

    const actionDurationMs = Date.now() - startTime;

    let image: string | null = null;
    let screenshotHash: string | undefined;
    try {
      // Wait before taking screenshot to allow UI to settle
      const delayMs = 750; // 750ms delay
      logger.debug(`Waiting ${delayMs}ms before taking screenshot`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      logger.debug('Taking screenshot');
      const shot = await screenshot(desktopUrl);
      image = shot.image;
      screenshotHash = shot.imageHash;
      logger.debug('Screenshot captured successfully');
    } catch (error) {
      logger.error('Failed to take screenshot', error);
    }

    logger.debug(`Tool execution successful for tool_use_id: ${block.id}`);
    const toolResult: ToolResultContentBlock = {
      type: MessageContentType.ToolResult,
      tool_use_id: block.id,
      content: [
        {
          type: MessageContentType.Text,
          text: 'Tool executed successfully',
        },
      ],
    };

    if (image) {
      toolResult.content.push({
        type: MessageContentType.Image,
        source: {
          data: image,
          media_type: 'image/png',
          type: 'base64',
        },
      });
    }

    // Emit screenshot hash for loop detection / observability (no base64).
    reportAction({
      actionType,
      success: true,
      durationMs: actionDurationMs,
      coordinates: actionCoordinates,
      actionSignature,
      screenshotHash,
      screenshotCaptured: Boolean(image),
      input: { signature: actionSignature },
    });

    return toolResult;
  } catch (error) {
    logger.error(
      `Error executing ${block.name} tool: ${error.message}`,
      error.stack,
    );

    // Best-effort: ensure no stuck input state if an input-affecting tool failed.
    if (
      block.name === 'computer_press_keys' ||
      block.name === 'computer_press_mouse' ||
      block.name === 'computer_drag_mouse'
    ) {
      try {
        await resetDesktopInput(desktopUrl);
      } catch (resetError: any) {
        logger.warn(`Failed to reset desktop input: ${resetError.message}`);
      }
    }

    // Report failed action
    reportAction({
      actionType,
      success: false,
      durationMs: Date.now() - startTime,
      coordinates: actionCoordinates,
      errorMessage: error.message,
      actionSignature,
      screenshotCaptured: false,
      input: { signature: actionSignature },
    });

    return {
      type: MessageContentType.ToolResult,
      tool_use_id: block.id,
      content: [
        {
          type: MessageContentType.Text,
          text: `Error executing ${block.name} tool: ${error.message}`,
        },
      ],
      is_error: true,
    };
  }
}

/**
 * Action functions - all accept optional desktopUrl for Phase 6.4 per-task routing
 */

async function moveMouse(
  input: { coordinates: Coordinates },
  desktopUrl: string,
): Promise<void> {
  const { coordinates } = input;
  console.log(
    `Moving mouse to coordinates: [${coordinates.x}, ${coordinates.y}]`,
  );

  try {
    await postComputerUse(desktopUrl, {
      action: 'move_mouse',
      coordinates,
    });
  } catch (error) {
    console.error('Error in move_mouse action:', error);
    throw error;
  }
}

async function traceMouse(
  input: {
    path: Coordinates[];
    holdKeys?: string[];
  },
  desktopUrl: string,
): Promise<void> {
  const { path, holdKeys } = input;
  console.log(
    `Tracing mouse to path: ${path} ${holdKeys ? `with holdKeys: ${holdKeys}` : ''}`,
  );

  try {
    await postComputerUse(desktopUrl, {
      action: 'trace_mouse',
      path,
      holdKeys,
    });
  } catch (error) {
    console.error('Error in trace_mouse action:', error);
    throw error;
  }
}

async function clickMouse(
  input: {
    coordinates?: Coordinates;
    button: Button;
    holdKeys?: string[];
    clickCount: number;
  },
  desktopUrl: string,
): Promise<void> {
  const { coordinates, button, holdKeys, clickCount } = input;
  console.log(
    `Clicking mouse ${button} ${clickCount} times ${coordinates ? `at coordinates: [${coordinates.x}, ${coordinates.y}] ` : ''} ${holdKeys ? `with holdKeys: ${holdKeys}` : ''}`,
  );

  try {
    await postComputerUse(desktopUrl, {
      action: 'click_mouse',
      coordinates,
      button,
      holdKeys: holdKeys && holdKeys.length > 0 ? holdKeys : undefined,
      clickCount,
    });
  } catch (error) {
    console.error('Error in click_mouse action:', error);
    throw error;
  }
}

async function pressMouse(
  input: {
    coordinates?: Coordinates;
    button: Button;
    press: Press;
  },
  desktopUrl: string,
): Promise<void> {
  const { coordinates, button, press } = input;
  console.log(
    `Pressing mouse ${button} ${press} ${coordinates ? `at coordinates: [${coordinates.x}, ${coordinates.y}]` : ''}`,
  );

  try {
    await postComputerUse(desktopUrl, {
      action: 'press_mouse',
      coordinates,
      button,
      press,
    });
  } catch (error) {
    console.error('Error in press_mouse action:', error);
    throw error;
  }
}

async function dragMouse(
  input: {
    path: Coordinates[];
    button: Button;
    holdKeys?: string[];
  },
  desktopUrl: string,
): Promise<void> {
  const { path, button, holdKeys } = input;
  console.log(
    `Dragging mouse to path: ${path} ${holdKeys ? `with holdKeys: ${holdKeys}` : ''}`,
  );

  try {
    await postComputerUse(desktopUrl, {
      action: 'drag_mouse',
      path,
      button,
      holdKeys: holdKeys && holdKeys.length > 0 ? holdKeys : undefined,
    });
  } catch (error) {
    console.error('Error in drag_mouse action:', error);
    throw error;
  }
}

async function scroll(
  input: {
    coordinates?: Coordinates;
    direction: 'up' | 'down' | 'left' | 'right';
    scrollCount: number;
    holdKeys?: string[];
  },
  desktopUrl: string,
): Promise<void> {
  const { coordinates, direction, scrollCount, holdKeys } = input;
  console.log(
    `Scrolling ${direction} ${scrollCount} times ${coordinates ? `at coordinates: [${coordinates.x}, ${coordinates.y}]` : ''}`,
  );

  try {
    await postComputerUse(desktopUrl, {
      action: 'scroll',
      coordinates,
      direction,
      scrollCount,
      holdKeys: holdKeys && holdKeys.length > 0 ? holdKeys : undefined,
    });
  } catch (error) {
    console.error('Error in scroll action:', error);
    throw error;
  }
}

async function typeKeys(
  input: {
    keys: string[];
    delay?: number;
  },
  desktopUrl: string,
): Promise<void> {
  const { keys, delay } = input;
  console.log(`Typing keys: ${keys}`);

  try {
    await postComputerUse(desktopUrl, {
      action: 'type_keys',
      keys,
      delay,
    });
  } catch (error) {
    console.error('Error in type_keys action:', error);
    throw error;
  }
}

async function pressKeys(
  input: {
    keys: string[];
    press: Press;
    holdMs?: number;
    hold_ms?: number;
  },
  desktopUrl: string,
): Promise<void> {
  const { keys, press } = input;
  console.log(`Pressing keys: ${keys}`);

  try {
    const holdMsRaw =
      typeof (input as any).holdMs === 'number'
        ? (input as any).holdMs
        : typeof (input as any).hold_ms === 'number'
          ? (input as any).hold_ms
          : null;

    const holdMs =
      typeof holdMsRaw === 'number' && Number.isFinite(holdMsRaw) && holdMsRaw >= 0
        ? Math.min(Math.floor(holdMsRaw), 750)
        : null;

    const hasNonModifier = keys.some((k) => !isModifierKeyName(k));

    // Safety invariant: non-modifier holds are not allowed. Treat as atomic tap.
    if (press === 'down' && hasNonModifier) {
      await typeKeys({ keys, delay: 75 }, desktopUrl);
      return;
    }

    // Safety invariant: modifier holds must be bounded. If holdMs isn't provided, treat as tap.
    if (press === 'down' && !hasNonModifier && holdMs === null) {
      await typeKeys({ keys, delay: 75 }, desktopUrl);
      return;
    }

    if (press === 'down' && !hasNonModifier && holdMs !== null) {
      await postComputerUse(desktopUrl, {
        action: 'press_keys',
        keys,
        press: 'down',
      });

      try {
        await new Promise((resolve) => setTimeout(resolve, holdMs));
      } finally {
        await postComputerUse(desktopUrl, {
          action: 'press_keys',
          keys,
          press: 'up',
        });
      }
      return;
    }

    await postComputerUse(desktopUrl, {
      action: 'press_keys',
      keys,
      press,
    });
  } catch (error) {
    console.error('Error in press_keys action:', error);
    throw error;
  }
}

async function typeText(
  input: {
    text: string;
    delay?: number;
  },
  desktopUrl: string,
): Promise<void> {
  const { text, delay } = input;
  console.log(`Typing text: ${text}`);

  try {
    await postComputerUse(desktopUrl, {
      action: 'type_text',
      text,
      delay,
    });
  } catch (error) {
    console.error('Error in type_text action:', error);
    throw error;
  }
}

async function pasteText(
  input: { text: string },
  desktopUrl: string,
): Promise<void> {
  const { text } = input;
  console.log(`Pasting text: ${text}`);

  try {
    await postComputerUse(desktopUrl, {
      action: 'paste_text',
      text,
    });
  } catch (error) {
    console.error('Error in paste_text action:', error);
    throw error;
  }
}

async function wait(
  input: { duration: number },
  desktopUrl: string,
): Promise<void> {
  const { duration } = input;
  console.log(`Waiting for ${duration}ms`);

  try {
    await postComputerUse(desktopUrl, {
      action: 'wait',
      duration,
    });
  } catch (error) {
    console.error('Error in wait action:', error);
    throw error;
  }
}

async function cursorPosition(desktopUrl: string): Promise<Coordinates> {
  console.log('Getting cursor position');

  try {
    const data = await postComputerUseJson<{ x: number; y: number }>(desktopUrl, {
      action: 'cursor_position',
    });
    return { x: data.x, y: data.y };
  } catch (error) {
    console.error('Error in cursor_position action:', error);
    throw error;
  }
}

async function screenshot(
  desktopUrl: string,
): Promise<{ image: string; imageHash?: string }> {
  console.log('Taking screenshot');

  try {
    const data = await postComputerUseJson<{ image?: string; imageHash?: string }>(
      desktopUrl,
      {
        action: 'screenshot',
      },
    );

    if (!data.image) {
      throw new Error('Failed to take screenshot: No image data received');
    }

    return { image: data.image, imageHash: data.imageHash };
  } catch (error) {
    console.error('Error in screenshot action:', error);
    throw error;
  }
}

async function application(
  input: { application: string },
  desktopUrl: string,
): Promise<void> {
  const { application: app } = input;
  console.log(`Opening application: ${app}`);

  try {
    await postComputerUse(desktopUrl, {
      action: 'application',
      application: app,
    });
  } catch (error) {
    console.error('Error in application action:', error);
    throw error;
  }
}

async function readFile(
  input: { path: string },
  desktopUrl: string,
): Promise<{
  success: boolean;
  data?: string;
  name?: string;
  size?: number;
  mediaType?: string;
  message?: string;
}> {
  const { path } = input;
  console.log(`Reading file: ${path}`);

  try {
    const data = await postComputerUseJson<any>(desktopUrl, {
      action: 'read_file',
      path,
    });
    return data;
  } catch (error) {
    console.error('Error in read_file action:', error);
    return {
      success: false,
      message: `Error reading file: ${error.message}`,
    };
  }
}

/**
 * Write file to desktop - also updated for Phase 6.4
 */
export async function writeFile(
  input: {
    path: string;
    content: string;
  },
  desktopUrl?: string,
): Promise<{ success: boolean; message?: string }> {
  const { path, content } = input;
  const url = getDesktopUrl(desktopUrl);
  console.log(`Writing file: ${path}`);

  try {
    // Content is always base64 encoded
    const base64Data = content;

    const data = await postComputerUseJson<any>(url, {
      action: 'write_file',
      path,
      data: base64Data,
    });
    return data;
  } catch (error) {
    console.error('Error in write_file action:', error);
    return {
      success: false,
      message: `Error writing file: ${error.message}`,
    };
  }
}

type DesktopCapabilities = {
  resetInput?: boolean;
  screenshotHash?: boolean;
};

const DESKTOP_CAPABILITIES_TTL_MS = parseInt(
  process.env.BYTEBOT_DESKTOP_CAPABILITIES_TTL_MS || '300000',
  10,
);

const desktopCapabilitiesCache = new Map<
  string,
  { checkedAt: number; capabilities: DesktopCapabilities }
>();

async function getDesktopCapabilities(desktopUrl: string): Promise<DesktopCapabilities | null> {
  const now = Date.now();
  const cached = desktopCapabilitiesCache.get(desktopUrl);
  if (cached && now - cached.checkedAt < DESKTOP_CAPABILITIES_TTL_MS) {
    return cached.capabilities;
  }

  try {
    const response = await fetch(`${desktopUrl}/computer-use/capabilities`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!response.ok) {
      // Backward compatibility: older daemons may not expose a capabilities endpoint yet.
      // Do not treat 404 as "feature unsupported" because reset-input may still exist.
      if (response.status === 404) return null;
      return null;
    }

    const json = (await response.json()) as DesktopCapabilities;
    const capabilities: DesktopCapabilities = {
      resetInput: Boolean((json as any)?.resetInput),
      screenshotHash: Boolean((json as any)?.screenshotHash),
    };
    desktopCapabilitiesCache.set(desktopUrl, { checkedAt: now, capabilities });
    return capabilities;
  } catch {
    return null;
  }
}

export async function resetDesktopInput(desktopUrl: string): Promise<void> {
  const capabilities = await getDesktopCapabilities(desktopUrl);
  if (capabilities && capabilities.resetInput === false) {
    return;
  }

  const response = await fetch(`${desktopUrl}/computer-use/reset-input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  // Backward compatibility with older daemon images.
  if (response.status === 404) {
    desktopCapabilitiesCache.set(desktopUrl, {
      checkedAt: Date.now(),
      capabilities: { resetInput: false, screenshotHash: false },
    });
    return;
  }

  if (!response.ok) {
    const text = await safeReadResponseText(response);
    throw new Error(
      `Failed to reset desktop input: ${response.status} ${response.statusText} ${text}`.trim(),
    );
  }
}

async function postComputerUse(
  desktopUrl: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await fetch(`${desktopUrl}/computer-use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await safeReadResponseText(response);
    throw new Error(
      `Desktop action failed: ${response.status} ${response.statusText} ${text}`.trim(),
    );
  }
}

async function postComputerUseJson<T>(
  desktopUrl: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${desktopUrl}/computer-use`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await safeReadResponseText(response);
    throw new Error(
      `Desktop action failed: ${response.status} ${response.statusText} ${text}`.trim(),
    );
  }

  return (await response.json()) as T;
}

async function safeReadResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 2048 ? `${text.slice(0, 2048)}…` : text;
  } catch {
    return '';
  }
}
