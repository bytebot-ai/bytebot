import { Injectable, Logger } from '@nestjs/common';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PNG } from 'pngjs';
import { NutService } from '../nut/nut.service';
import {
  ComputerAction,
  MoveMouseAction,
  TraceMouseAction,
  ClickMouseAction,
  PressMouseAction,
  DragMouseAction,
  ScrollAction,
  TypeKeysAction,
  PressKeysAction,
  TypeTextAction,
  ApplicationAction,
  Application,
  PasteTextAction,
  WriteFileAction,
  ReadFileAction,
} from '@bytebot/shared';

@Injectable()
export class ComputerUseService {
  private readonly logger = new Logger(ComputerUseService.name);
  private readonly deadmanMs = parseInt(
    process.env.BYTEBOT_INPUT_DEADMAN_MS || '1500',
    10,
  );

  private readonly keyDownSince = new Map<string, number>();
  private readonly keyDeadmanTimers = new Map<string, NodeJS.Timeout>();
  private readonly buttonDownSince = new Map<'left' | 'right' | 'middle', number>();
  private readonly buttonDeadmanTimers = new Map<
    'left' | 'right' | 'middle',
    NodeJS.Timeout
  >();

  constructor(private readonly nutService: NutService) {}

  getCapabilities(): {
    resetInput: true;
    screenshotHash: true;
    inputDeadmanMs: number;
    supportedActions: string[];
  } {
    return {
      resetInput: true,
      screenshotHash: true,
      inputDeadmanMs: this.deadmanMs,
      supportedActions: [
        'move_mouse',
        'trace_mouse',
        'click_mouse',
        'press_mouse',
        'drag_mouse',
        'scroll',
        'type_keys',
        'press_keys',
        'type_text',
        'paste_text',
        'wait',
        'screenshot',
        'cursor_position',
        'application',
        'write_file',
        'read_file',
      ],
    };
  }

  async action(params: ComputerAction): Promise<any> {
    this.logger.log(`Executing computer action: ${params.action}`);

    switch (params.action) {
      case 'move_mouse': {
        await this.moveMouse(params);
        break;
      }
      case 'trace_mouse': {
        await this.traceMouse(params);
        break;
      }
      case 'click_mouse': {
        await this.clickMouse(params);
        break;
      }
      case 'press_mouse': {
        await this.pressMouse(params);
        break;
      }
      case 'drag_mouse': {
        await this.dragMouse(params);
        break;
      }

      case 'scroll': {
        await this.scroll(params);
        break;
      }
      case 'type_keys': {
        await this.typeKeys(params);
        break;
      }
      case 'press_keys': {
        await this.pressKeys(params);
        break;
      }
      case 'type_text': {
        await this.typeText(params);
        break;
      }
      case 'paste_text': {
        await this.pasteText(params);
        break;
      }
      case 'wait': {
        const waitParams = params;
        await this.delay(waitParams.duration);
        break;
      }
      case 'screenshot':
        return this.screenshot();

      case 'cursor_position':
        return this.cursor_position();

      case 'application': {
        await this.application(params);
        break;
      }

      case 'write_file': {
        return this.writeFile(params);
      }

      case 'read_file': {
        return this.readFile(params);
      }

      default:
        throw new Error(
          `Unsupported computer action: ${(params as any).action}`,
        );
    }
  }

  private async moveMouse(action: MoveMouseAction): Promise<void> {
    await this.nutService.mouseMoveEvent(action.coordinates);
  }

  private async traceMouse(action: TraceMouseAction): Promise<void> {
    const { path, holdKeys } = action;

    // Move to the first coordinate
    await this.nutService.mouseMoveEvent(path[0]);

    await this.withHeldModifiers(holdKeys, async () => {
      // Move to each coordinate in the path
      for (const coordinates of path) {
        await this.nutService.mouseMoveEvent(coordinates);
      }
    });
  }

  private async clickMouse(action: ClickMouseAction): Promise<void> {
    const { coordinates, button, holdKeys, clickCount } = action;

    await this.withHeldModifiers(holdKeys, async () => {
      // Move to coordinates if provided
      if (coordinates) {
        await this.nutService.mouseMoveEvent(coordinates);
      }

      // Perform clicks
      if (clickCount > 1) {
        for (let i = 0; i < clickCount; i++) {
          await this.nutService.mouseClickEvent(button);
          await this.delay(150);
        }
      } else {
        await this.nutService.mouseClickEvent(button);
      }
    });
  }

  private async pressMouse(action: PressMouseAction): Promise<void> {
    const { coordinates, button, press } = action;

    // Move to coordinates if provided
    if (coordinates) {
      await this.nutService.mouseMoveEvent(coordinates);
    }

    // Perform press
    if (press === 'down') {
      await this.nutService.mouseButtonEvent(button, true);
      this.markButtonDown(button);
    } else {
      await this.nutService.mouseButtonEvent(button, false);
      this.markButtonUp(button);
    }
  }

  private async dragMouse(action: DragMouseAction): Promise<void> {
    const { path, button, holdKeys } = action;

    // Move to the first coordinate
    await this.nutService.mouseMoveEvent(path[0]);

    await this.withHeldModifiers(holdKeys, async () => {
      await this.nutService.mouseButtonEvent(button, true);
      this.markButtonDown(button);
      try {
        for (const coordinates of path) {
          await this.nutService.mouseMoveEvent(coordinates);
        }
      } finally {
        try {
          await this.nutService.mouseButtonEvent(button, false);
        } finally {
          this.markButtonUp(button);
        }
      }
    });
  }

  private async scroll(action: ScrollAction): Promise<void> {
    const { coordinates, direction, scrollCount, holdKeys } = action;

    await this.withHeldModifiers(holdKeys, async () => {
      // Move to coordinates if provided
      if (coordinates) {
        await this.nutService.mouseMoveEvent(coordinates);
      }

      // Perform scroll
      for (let i = 0; i < scrollCount; i++) {
        await this.nutService.mouseWheelEvent(direction, 1);
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    });
  }

  private async typeKeys(action: TypeKeysAction): Promise<void> {
    const { keys, delay } = action;
    await this.nutService.sendKeys(keys, delay);
  }

  private async pressKeys(action: PressKeysAction): Promise<void> {
    const { keys, press } = action;
    const { modifiers, nonModifiers } = this.splitModifiers(keys);

    // Safety invariant: non-modifier holds are not allowed. Treat as a tap/chord tap.
    if (press === 'down' && nonModifiers.length > 0) {
      await this.nutService.sendKeys(keys, 75);
      return;
    }

    if (press === 'down') {
      await this.nutService.holdKeys(modifiers, true);
      this.markKeysDown(modifiers);
      return;
    }

    await this.nutService.holdKeys(keys, false);
    this.markKeysUp(keys);
  }

  private async typeText(action: TypeTextAction): Promise<void> {
    const { text, delay } = action;
    await this.nutService.typeText(text, delay);
  }

  private async pasteText(action: PasteTextAction): Promise<void> {
    const { text } = action;
    await this.nutService.pasteText(text);
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async screenshot(): Promise<{ image: string; imageHash?: string }> {
    this.logger.log(`Taking screenshot`);
    const buffer = await this.nutService.screendump();
    let imageHash: string | undefined;
    try {
      imageHash = this.computeAHash(buffer);
    } catch (error: any) {
      this.logger.warn(`Failed to compute screenshot hash: ${error.message}`);
    }

    return { image: `${buffer.toString('base64')}`, ...(imageHash ? { imageHash } : {}) };
  }

  private async cursor_position(): Promise<{ x: number; y: number }> {
    this.logger.log(`Getting cursor position`);
    return await this.nutService.getCursorPosition();
  }

  async resetInput(): Promise<{
    success: true;
    releasedKeys: string[];
    releasedButtons: Array<'left' | 'right' | 'middle'>;
  }> {
    const releasedKeys: string[] = [];
    const releasedButtons: Array<'left' | 'right' | 'middle'> = [];

    for (const [key, timer] of this.keyDeadmanTimers.entries()) {
      clearTimeout(timer);
      this.keyDeadmanTimers.delete(key);
    }
    for (const [button, timer] of this.buttonDeadmanTimers.entries()) {
      clearTimeout(timer);
      this.buttonDeadmanTimers.delete(button);
    }

    for (const key of this.keyDownSince.keys()) {
      try {
        await this.nutService.holdKeys([key], false);
        releasedKeys.push(key);
      } catch (error: any) {
        this.logger.warn(`Failed to release key '${key}' during reset: ${error.message}`);
      }
    }
    for (const button of this.buttonDownSince.keys()) {
      try {
        await this.nutService.mouseButtonEvent(button, false);
        releasedButtons.push(button);
      } catch (error: any) {
        this.logger.warn(
          `Failed to release mouse button '${button}' during reset: ${error.message}`,
        );
      }
    }

    this.keyDownSince.clear();
    this.buttonDownSince.clear();

    return { success: true, releasedKeys, releasedButtons };
  }

  private splitModifiers(keys: string[]): { modifiers: string[]; nonModifiers: string[] } {
    const modifiers: string[] = [];
    const nonModifiers: string[] = [];

    for (const key of keys) {
      if (this.isModifierKeyName(key)) {
        modifiers.push(key);
      } else {
        nonModifiers.push(key);
      }
    }

    return { modifiers, nonModifiers };
  }

  private isModifierKeyName(key: string): boolean {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return false;

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

  private async withHeldModifiers(
    holdKeys: string[] | undefined,
    fn: () => Promise<void>,
  ): Promise<void> {
    const keys = Array.isArray(holdKeys) ? holdKeys : [];
    if (keys.length === 0) {
      return await fn();
    }

    const { modifiers, nonModifiers } = this.splitModifiers(keys);
    if (nonModifiers.length > 0) {
      this.logger.warn(
        `Ignoring non-modifier hold keys: ${nonModifiers.join(', ')} (only modifiers are allowed)`,
      );
    }

    if (modifiers.length === 0) {
      return await fn();
    }

    await this.nutService.holdKeys(modifiers, true);
    this.markKeysDown(modifiers);
    try {
      await fn();
    } finally {
      try {
        await this.nutService.holdKeys(modifiers, false);
      } finally {
        this.markKeysUp(modifiers);
      }
    }
  }

  private markKeysDown(keys: string[]): void {
    const now = Date.now();
    for (const key of keys) {
      if (this.keyDownSince.has(key)) continue;
      this.keyDownSince.set(key, now);
      this.scheduleKeyDeadman(key, now);
    }
  }

  private markKeysUp(keys: string[]): void {
    for (const key of keys) {
      this.keyDownSince.delete(key);
      const timer = this.keyDeadmanTimers.get(key);
      if (timer) {
        clearTimeout(timer);
        this.keyDeadmanTimers.delete(key);
      }
    }
  }

  private scheduleKeyDeadman(key: string, sinceMs: number): void {
    const existing = this.keyDeadmanTimers.get(key);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      void this.deadmanReleaseKey(key, sinceMs);
    }, this.deadmanMs);
    this.keyDeadmanTimers.set(key, timer);
  }

  private async deadmanReleaseKey(key: string, sinceMs: number): Promise<void> {
    if (this.keyDownSince.get(key) !== sinceMs) {
      return;
    }
    this.logger.warn(`Deadman auto-releasing key held too long: ${key} (${this.deadmanMs}ms)`);
    try {
      await this.nutService.holdKeys([key], false);
    } catch (error: any) {
      this.logger.error(`Deadman failed to release key '${key}': ${error.message}`, error.stack);
    } finally {
      this.markKeysUp([key]);
    }
  }

  private markButtonDown(button: 'left' | 'right' | 'middle'): void {
    const now = Date.now();
    if (this.buttonDownSince.has(button)) return;
    this.buttonDownSince.set(button, now);
    this.scheduleButtonDeadman(button, now);
  }

  private markButtonUp(button: 'left' | 'right' | 'middle'): void {
    this.buttonDownSince.delete(button);
    const timer = this.buttonDeadmanTimers.get(button);
    if (timer) {
      clearTimeout(timer);
      this.buttonDeadmanTimers.delete(button);
    }
  }

  private scheduleButtonDeadman(button: 'left' | 'right' | 'middle', sinceMs: number): void {
    const existing = this.buttonDeadmanTimers.get(button);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      void this.deadmanReleaseButton(button, sinceMs);
    }, this.deadmanMs);
    this.buttonDeadmanTimers.set(button, timer);
  }

  private async deadmanReleaseButton(
    button: 'left' | 'right' | 'middle',
    sinceMs: number,
  ): Promise<void> {
    if (this.buttonDownSince.get(button) !== sinceMs) {
      return;
    }
    this.logger.warn(
      `Deadman auto-releasing mouse button held too long: ${button} (${this.deadmanMs}ms)`,
    );
    try {
      await this.nutService.mouseButtonEvent(button, false);
    } catch (error: any) {
      this.logger.error(
        `Deadman failed to release mouse button '${button}': ${error.message}`,
        error.stack,
      );
    } finally {
      this.markButtonUp(button);
    }
  }

  private computeAHash(buffer: Buffer): string {
    const width = 8;
    const height = 8;

    const png = PNG.sync.read(buffer);
    const pixels: number[] = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sampleX = Math.min(
          png.width - 1,
          Math.floor(((x + 0.5) * png.width) / width),
        );
        const sampleY = Math.min(
          png.height - 1,
          Math.floor(((y + 0.5) * png.height) / height),
        );
        const idx = (sampleY * png.width + sampleX) * 4;
        const r = png.data[idx];
        const g = png.data[idx + 1];
        const b = png.data[idx + 2];
        const lum = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        pixels.push(lum);
      }
    }

    const avg = pixels.reduce((sum, v) => sum + v, 0) / pixels.length;
    let bits = '';
    for (const v of pixels) {
      bits += v >= avg ? '1' : '0';
    }

    let hex = '';
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }

    return hex.padStart(16, '0');
  }

  private async application(action: ApplicationAction): Promise<void> {
    const execAsync = promisify(exec);

    // Helper to spawn a command and forget about it
    const spawnAndForget = (
      command: string,
      args: string[],
      options: Record<string, any> = {},
    ): void => {
      const child = spawn(command, args, {
        env: { ...process.env, DISPLAY: ':0.0' }, // ensure DISPLAY is set for GUI tools
        stdio: 'ignore',
        detached: true,
        ...options,
      });
      child.unref(); // Allow the parent process to exit independently
    };

    if (action.application === 'desktop') {
      spawnAndForget('sudo', ['-u', 'user', 'wmctrl', '-k', 'on']);
      return;
    }

    const commandMap: Record<string, string> = {
      firefox: 'firefox-esr',
      '1password': '1password',
      thunderbird: 'thunderbird',
      vscode: 'code',
      terminal: 'xfce4-terminal',
      directory: 'thunar',
    };

    const processMap: Record<Application, string> = {
      firefox: 'Navigator.firefox-esr',
      '1password': '1password.1Password',
      thunderbird: 'Mail.thunderbird',
      vscode: 'code.Code',
      terminal: 'xfce4-terminal.Xfce4-Terminal',
      directory: 'Thunar',
      desktop: 'xfdesktop.Xfdesktop',
    };

    // check if the application is already open using wmctrl -lx
    let appOpen = false;
    try {
      const { stdout } = await execAsync(
        `sudo -u user wmctrl -lx | grep ${processMap[action.application]}`,
        { timeout: 5000 }, // 5 second timeout
      );
      appOpen = stdout.trim().length > 0;
    } catch (error: any) {
      // grep returns exit code 1 when no match is found – treat as "not open"
      // Also handle timeout errors
      if (error.code !== 1 && !error.message?.includes('timeout')) {
        throw error;
      }
    }

    if (appOpen) {
      this.logger.log(`Application ${action.application} is already open`);

      // Fire and forget - activate window
      spawnAndForget('sudo', [
        '-u',
        'user',
        'wmctrl',
        '-x',
        '-a',
        processMap[action.application],
      ]);

      // Fire and forget - maximize window
      spawnAndForget('sudo', [
        '-u',
        'user',
        'wmctrl',
        '-x',
        '-r',
        processMap[action.application],
        '-b',
        'add,maximized_vert,maximized_horz',
      ]);

      return;
    }

    // application is not open, open it - fire and forget
    spawnAndForget('sudo', [
      '-u',
      'user',
      'nohup',
      commandMap[action.application],
    ]);

    this.logger.log(`Application ${action.application} launched`);

    // Just return immediately
    return;
  }

  private async writeFile(
    action: WriteFileAction,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const execAsync = promisify(exec);

      // Decode base64 data
      const buffer = Buffer.from(action.data, 'base64');

      // Resolve path - if relative, make it relative to user's home directory
      let targetPath = action.path;
      if (!path.isAbsolute(targetPath)) {
        targetPath = path.join('/home/user/Desktop', targetPath);
      }

      // Ensure directory exists using sudo
      const dir = path.dirname(targetPath);
      try {
        await execAsync(`sudo mkdir -p "${dir}"`);
      } catch (error) {
        // Directory might already exist, which is fine
        this.logger.debug(`Directory creation: ${error.message}`);
      }

      // Write to a temporary file first
      const tempFile = `/tmp/bytebot_temp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      await fs.writeFile(tempFile, buffer);

      // Move the file to the target location using sudo
      try {
        await execAsync(`sudo cp "${tempFile}" "${targetPath}"`);
        await execAsync(`sudo chown user:user "${targetPath}"`);
        await execAsync(`sudo chmod 644 "${targetPath}"`);
        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});
      } catch (error) {
        // Clean up temp file on error
        await fs.unlink(tempFile).catch(() => {});
        throw error;
      }

      this.logger.log(`File written successfully to: ${targetPath}`);
      return {
        success: true,
        message: `File written successfully to: ${targetPath}`,
      };
    } catch (error) {
      this.logger.error(`Error writing file: ${error.message}`, error.stack);
      return {
        success: false,
        message: `Error writing file: ${error.message}`,
      };
    }
  }

  private async readFile(action: ReadFileAction): Promise<{
    success: boolean;
    data?: string;
    name?: string;
    size?: number;
    mediaType?: string;
    message?: string;
  }> {
    try {
      const execAsync = promisify(exec);

      // Resolve path - if relative, make it relative to user's home directory
      let targetPath = action.path;
      if (!path.isAbsolute(targetPath)) {
        targetPath = path.join('/home/user/Desktop', targetPath);
      }

      // Copy file to temp location using sudo to read it
      const tempFile = `/tmp/bytebot_read_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      try {
        // Copy the file to a temporary location we can read
        await execAsync(`sudo cp "${targetPath}" "${tempFile}"`);
        await execAsync(`sudo chmod 644 "${tempFile}"`);

        // Read file as buffer from temp location
        const buffer = await fs.readFile(tempFile);

        // Get file stats for size using sudo
        const { stdout: statOutput } = await execAsync(
          `sudo stat -c "%s" "${targetPath}"`,
        );
        const fileSize = parseInt(statOutput.trim(), 10);

        // Clean up temp file
        await fs.unlink(tempFile).catch(() => {});

        // Convert to base64
        const base64Data = buffer.toString('base64');

        // Extract filename from path
        const fileName = path.basename(targetPath);

        // Determine media type based on file extension
        const ext = path.extname(targetPath).toLowerCase().slice(1);
        const mimeTypes: Record<string, string> = {
          pdf: 'application/pdf',
          docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          doc: 'application/msword',
          txt: 'text/plain',
          html: 'text/html',
          json: 'application/json',
          xml: 'text/xml',
          csv: 'text/csv',
          rtf: 'application/rtf',
          odt: 'application/vnd.oasis.opendocument.text',
          epub: 'application/epub+zip',
          png: 'image/png',
          jpg: 'image/jpeg',
          jpeg: 'image/jpeg',
          webp: 'image/webp',
          gif: 'image/gif',
          svg: 'image/svg+xml',
        };

        const mediaType = mimeTypes[ext] || 'application/octet-stream';

        this.logger.log(`File read successfully from: ${targetPath}`);
        return {
          success: true,
          data: base64Data,
          name: fileName,
          size: fileSize,
          mediaType: mediaType,
        };
      } catch (error) {
        // Clean up temp file on error
        await fs.unlink(tempFile).catch(() => {});
        throw error;
      }
    } catch (error) {
      this.logger.error(`Error reading file: ${error.message}`, error.stack);
      return {
        success: false,
        message: `Error reading file: ${error.message}`,
      };
    }
  }
}
