import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  uIOhook,
  UiohookKeyboardEvent,
  UiohookMouseEvent,
  UiohookWheelEvent,
  WheelDirection,
} from 'uiohook-napi';
import {
  Button,
  ClickMouseAction,
  ComputerAction,
  DragMouseAction,
  ScrollAction,
  TypeKeysAction,
  TypeTextAction,
} from '@bytebot/shared';
import { ComputerUseService } from '../computer-use/computer-use.service';
import { InputTrackingGateway } from './input-tracking.gateway';
import { keyInfoMap } from './input-tracking.helpers';

@Injectable()
export class InputTrackingService implements OnModuleDestroy {
  private readonly logger = new Logger(InputTrackingService.name);

  private isTracking = false;

  private isDragging = false;
  private dragMouseAction: DragMouseAction | null = null;

  private scrollAction: ScrollAction | null = null;
  private scrollCount = 0;

  private clickMouseActionBuffer: ClickMouseAction[] = [];
  private clickMouseActionTimeout: NodeJS.Timeout | null = null;
  private readonly CLICK_DEBOUNCE_MS = 250;

  private screenshot: { image: string } | null = null;
  private screenshotTimeout: NodeJS.Timeout | null = null;
  private readonly SCREENSHOT_DEBOUNCE_MS = 250;

  private readonly pressedKeys = new Set<number>(); // suppress repeats
  private readonly typingBuffer: string[] = []; // pending chars
  private typingTimer: NodeJS.Timeout | null = null; // debounce
  private readonly TYPING_DEBOUNCE_MS = 500;

  constructor(
    private readonly gateway: InputTrackingGateway,
    private readonly computerUseService: ComputerUseService,
  ) {}

  // Tracking is started manually via startTracking

  onModuleDestroy() {
    this.stopTracking();
  }

  startTracking() {
    if (this.isTracking) {
      return;
    }
    this.logger.log('Starting input tracking');
    this.registerListeners();
    uIOhook.start();
    this.isTracking = true;
  }

  stopTracking() {
    if (!this.isTracking) {
      return;
    }
    this.logger.log('Stopping input tracking');
    uIOhook.stop();
    uIOhook.removeAllListeners();
    this.isTracking = false;
  }

  /** Adds a printable char to buffer and restarts debounce timer. */
  private bufferChar(char: string) {
    this.typingBuffer.push(char);
    if (this.typingTimer) clearTimeout(this.typingTimer);
    this.typingTimer = setTimeout(
      () => this.flushTypingBuffer(),
      this.TYPING_DEBOUNCE_MS,
    );
  }
  /** Convert buffered chars → action, then clear buffer. */
  private async flushTypingBuffer() {
    if (!this.typingBuffer.length) return;
    const action: TypeTextAction = {
      action: 'type_text',
      text: this.typingBuffer.join(''),
    };
    this.typingBuffer.length = 0;
    await this.logAction(action);
  }

  private isModifierKey(key: UiohookKeyboardEvent) {
    return key.altKey || key.ctrlKey || key.metaKey;
  }

  private registerListeners() {
    uIOhook.on('mousemove', (e: UiohookMouseEvent) => {
      if (this.isDragging && this.dragMouseAction) {
        this.dragMouseAction.path.push({ x: e.x, y: e.y });
      } else {
        if (this.screenshotTimeout) {
          clearTimeout(this.screenshotTimeout);
        }
        this.screenshotTimeout = setTimeout(async () => {
          this.screenshot = await this.computerUseService.screenshot();
        }, this.SCREENSHOT_DEBOUNCE_MS);
      }
    });

    uIOhook.on('click', (e: UiohookMouseEvent) => {
      const action: ClickMouseAction = {
        action: 'click_mouse',
        button: this.mapButton(e.button),
        coordinates: { x: e.x, y: e.y },
        clickCount: e.clicks,
        holdKeys: [
          e.altKey ? 'alt' : undefined,
          e.ctrlKey ? 'ctrl' : undefined,
          e.shiftKey ? 'shift' : undefined,
          e.metaKey ? 'meta' : undefined,
        ].filter((key) => key !== undefined),
      };
      this.clickMouseActionBuffer.push(action);
      if (this.clickMouseActionTimeout) {
        clearTimeout(this.clickMouseActionTimeout);
      }

      this.clickMouseActionTimeout = setTimeout(async () => {
        // pick the event with the largest clickCount in the burst
        const final = this.clickMouseActionBuffer.reduce((a, b) =>
          b.clickCount > a.clickCount ? b : a,
        );
        await this.logAction(final); // emit exactly once

        this.clickMouseActionTimeout = null;
        this.clickMouseActionBuffer = [];
      }, this.CLICK_DEBOUNCE_MS);
    });

    uIOhook.on('mousedown', (e: UiohookMouseEvent) => {
      this.isDragging = true;
      this.dragMouseAction = {
        action: 'drag_mouse',
        button: this.mapButton(e.button),
        path: [{ x: e.x, y: e.y }],
        holdKeys: [
          e.altKey ? 'alt' : undefined,
          e.ctrlKey ? 'ctrl' : undefined,
          e.shiftKey ? 'shift' : undefined,
          e.metaKey ? 'meta' : undefined,
        ].filter((key) => key !== undefined),
      };
    });

    uIOhook.on('mouseup', async (e: UiohookMouseEvent) => {
      if (this.isDragging && this.dragMouseAction) {
        this.dragMouseAction.path.push({ x: e.x, y: e.y });
        if (this.dragMouseAction.path.length > 3) {
          await this.logAction(this.dragMouseAction);
        }
        this.dragMouseAction = null;
      }
      this.isDragging = false;
    });

    uIOhook.on('wheel', async (e: UiohookWheelEvent) => {
      const direction =
        e.direction === WheelDirection.VERTICAL
          ? e.rotation > 0
            ? 'down'
            : 'up'
          : e.rotation > 0
            ? 'right'
            : 'left';
      const action: ScrollAction = {
        action: 'scroll',
        direction: direction as any,
        scrollCount: 1,
        coordinates: { x: e.x, y: e.y },
      };

      if (
        this.scrollAction &&
        action.direction === this.scrollAction.direction
      ) {
        this.scrollCount++;
        if (this.scrollCount >= 4) {
          await this.logAction(this.scrollAction);
          this.scrollAction = null;
          this.scrollCount = 0;
        }
      } else {
        this.scrollAction = action;
        this.scrollCount = 1;
      }
    });

    uIOhook.on('keydown', async (e: UiohookKeyboardEvent) => {
      if (!keyInfoMap[e.keycode]) {
        this.logger.warn(`Unknown key: ${e.keycode}`);
        return;
      }

      /* Printable char with no active modifier → buffer for TypeTextAction. */
      if (!this.isModifierKey(e) && keyInfoMap[e.keycode].isPrintable) {
        this.bufferChar(
          e.shiftKey
            ? keyInfoMap[e.keycode].shiftString!
            : keyInfoMap[e.keycode].string!,
        );
        return;
      }

      /* Anything with modifiers _or_ a non‑printable key: 
      first flush buffered text so ordering is preserved. */
      await this.flushTypingBuffer();

      /* Ignore auto‑repeat for pressed keys. */
      if (this.pressedKeys.has(e.keycode)) {
        return;
      }
      this.pressedKeys.add(e.keycode);
    });

    uIOhook.on('keyup', async (e: UiohookKeyboardEvent) => {
      if (!keyInfoMap[e.keycode]) {
        this.logger.warn(`Unknown key: ${e.keycode}`);
        return;
      }
      /* If key belongs to typing buffer we don't emit anything on keyup. *
       * (Up‑event is irrelevant for a pure “typed character”.) */
      if (!this.isModifierKey(e) && keyInfoMap[e.keycode].isPrintable) {
        return;
      }

      await this.flushTypingBuffer();

      if (this.pressedKeys.size === 0) {
        return;
      }

      const action: TypeKeysAction = {
        action: 'type_keys',
        keys: [
          // take the pressed keys and map them to their names
          ...Array.from(this.pressedKeys.values()).map(
            (key) => keyInfoMap[key].name,
          ),
        ].filter((key) => key !== undefined),
      };

      this.pressedKeys.clear();
      await this.logAction(action);
    });
  }

  private mapButton(btn: unknown): Button {
    switch (btn) {
      case 1:
        return 'left';
      case 2:
        return 'right';
      case 3:
        return 'middle';
      default:
        return 'left';
    }
  }

  private async logAction(action: ComputerAction) {
    this.logger.log(`Detected action: ${JSON.stringify(action)}`);

    if (
      this.screenshot &&
      (action.action === 'click_mouse' || action.action === 'drag_mouse')
    ) {
      this.gateway.emitScreenshotAndAction(this.screenshot, action);
      return;
    }

    this.gateway.emitAction(action);
  }
}
