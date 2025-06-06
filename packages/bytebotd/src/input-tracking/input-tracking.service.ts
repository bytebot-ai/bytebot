import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { uIOhook } from 'uiohook-napi';
import {
  Button,
  ComputerAction,
  Coordinates,
} from '../computer-use/computer-use.service';

@Injectable()
export class InputTrackingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InputTrackingService.name);

  private mouseMovePath: Coordinates[] = [];
  private mouseMoveTimeout: NodeJS.Timeout | null = null;

  private keyBuffer: string[] = [];
  private keyTimeout: NodeJS.Timeout | null = null;

  onModuleInit() {
    this.logger.log('Starting input tracking');
    this.registerListeners();
    uIOhook.start();
  }

  onModuleDestroy() {
    this.logger.log('Stopping input tracking');
    this.flushMouseMoves();
    this.flushTyping();
    uIOhook.stop();
  }

  private registerListeners() {
    uIOhook.on('mousemove', (e: any) => {
      this.mouseMovePath.push({ x: e.x, y: e.y });
      if (this.mouseMoveTimeout) {
        clearTimeout(this.mouseMoveTimeout);
      }
      this.mouseMoveTimeout = setTimeout(
        () => this.flushMouseMoves(),
        100,
      );
    });

    uIOhook.on('mousedown', (e: any) => {
      this.flushMouseMoves();
      const action: ComputerAction = {
        action: 'press_mouse',
        button: this.mapButton(e.button),
        press: 'down',
        coordinates: { x: e.x, y: e.y },
      };
      this.logAction(action);
    });

    uIOhook.on('mouseup', (e: any) => {
      this.flushMouseMoves();
      const action: ComputerAction = {
        action: 'press_mouse',
        button: this.mapButton(e.button),
        press: 'up',
        coordinates: { x: e.x, y: e.y },
      };
      this.logAction(action);
    });

    uIOhook.on('wheel', (e: any) => {
      this.flushMouseMoves();
      const direction = e.rotation > 0 ? 'down' : 'up';
      const action: ComputerAction = {
        action: 'scroll',
        direction: direction as any,
        numScrolls: Math.abs(e.rotation),
        coordinates: { x: e.x, y: e.y },
      };
      this.logAction(action);
    });

    uIOhook.on('keydown', (e: any) => {
      if (typeof e.keychar === 'number' && e.keychar > 0) {
        this.keyBuffer.push(this.keyToString(e.keychar, e.keycode));
        if (this.keyTimeout) {
          clearTimeout(this.keyTimeout);
        }
        this.keyTimeout = setTimeout(() => this.flushTyping(), 200);
      } else {
        this.flushTyping();
        const action: ComputerAction = {
          action: 'press_keys',
          keys: [this.keyToString(e.keychar, e.keycode)],
          press: 'down',
        };
        this.logAction(action);
      }
    });

    uIOhook.on('keyup', (e: any) => {
      this.flushTyping();
      const action: ComputerAction = {
        action: 'press_keys',
        keys: [this.keyToString(e.keychar, e.keycode)],
        press: 'up',
      };
      this.logAction(action);
    });
  }

  private mapButton(btn: number): Button {
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

  private keyToString(keychar: number, keycode: number): string {
    if (typeof keychar === 'number' && keychar > 0) {
      return String.fromCharCode(keychar);
    }
    return String(keycode);
  }

  private flushMouseMoves() {
    if (!this.mouseMovePath.length) {
      return;
    }
    const action: ComputerAction =
      this.mouseMovePath.length === 1
        ? { action: 'move_mouse', coordinates: this.mouseMovePath[0] }
        : { action: 'trace_mouse', path: [...this.mouseMovePath] };
    this.mouseMovePath = [];
    if (this.mouseMoveTimeout) {
      clearTimeout(this.mouseMoveTimeout);
      this.mouseMoveTimeout = null;
    }
    this.logAction(action);
  }

  private flushTyping() {
    if (!this.keyBuffer.length) {
      return;
    }
    const action: ComputerAction = {
      action: 'type_keys',
      keys: [...this.keyBuffer],
    };
    this.keyBuffer = [];
    if (this.keyTimeout) {
      clearTimeout(this.keyTimeout);
      this.keyTimeout = null;
    }
    this.logAction(action);
  }

  private logAction(action: ComputerAction) {
    this.logger.log(`Detected action: ${JSON.stringify(action)}`);
  }
}
