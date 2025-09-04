import { Injectable } from '@nestjs/common';
import { Tool } from '@rekog/mcp-nest';
import { z } from 'zod';
import { ComputerUseService } from '../computer-use/computer-use.service';
import { compressPngBase64Under1MB } from './compressor';

@Injectable()
export class ComputerUseTools {
  constructor(private readonly computerUse: ComputerUseService) {}

  @Tool({
    name: 'computer_move_mouse',
    description: 'Moves the mouse cursor to the specified coordinates.',
    parameters: z.object({
      coordinates: z.object({
        x: z.number().describe('The x-coordinate to move the mouse to.'),
        y: z.number().describe('The y-coordinate to move the mouse to.'),
      }),
    }),
  })
  async moveMouse({ coordinates }: { coordinates: { x: number; y: number } }) {
    try {
      await this.computerUse.action({ action: 'move_mouse', coordinates });
      return { content: [{ type: 'text', text: 'mouse moved' }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error moving mouse: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_trace_mouse',
    description:
      'Moves the mouse cursor along a specified path of coordinates.',
    parameters: z.object({
      path: z
        .array(
          z.object({
            x: z.number().describe('The x-coordinate to move the mouse to.'),
            y: z.number().describe('The y-coordinate to move the mouse to.'),
          }),
        )
        .describe('An array of coordinate objects representing the path.'),
      holdKeys: z
        .array(z.string())
        .optional()
        .describe('Optional array of keys to hold during the trace.'),
    }),
  })
  async traceMouse({
    path,
    holdKeys,
  }: {
    path: { x: number; y: number }[];
    holdKeys?: string[];
  }) {
    try {
      await this.computerUse.action({ action: 'trace_mouse', path, holdKeys });
      return {
        content: [{ type: 'text', text: 'mouse traced' }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error tracing mouse: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_click_mouse',
    description:
      'Performs a mouse click at the specified coordinates or current position.',
    parameters: z.object({
      coordinates: z
        .object({
          x: z.number().describe('The x-coordinate to move the mouse to.'),
          y: z.number().describe('The y-coordinate to move the mouse to.'),
        })
        .optional()
        .describe(
          'Optional coordinates for the click. If not provided, clicks at the current mouse position.',
        ),
      button: z
        .enum(['left', 'right', 'middle'])
        .describe('The mouse button to click.'),
      holdKeys: z
        .array(z.string())
        .optional()
        .describe('Optional array of keys to hold during the click.'),
      clickCount: z
        .number()
        .describe('Number of clicks to perform (e.g., 2 for double-click).'),
    }),
  })
  async clickMouse({
    coordinates,
    button,
    holdKeys,
    clickCount,
  }: {
    coordinates?: { x: number; y: number };
    button: 'left' | 'right' | 'middle';
    holdKeys?: string[];
    clickCount: number;
  }) {
    try {
      await this.computerUse.action({
        action: 'click_mouse',
        coordinates,
        button,
        holdKeys,
        clickCount,
      });
      return {
        content: [{ type: 'text', text: 'mouse clicked' }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error clicking mouse: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_press_mouse',
    description:
      'Presses or releases a specified mouse button at the given coordinates or current position.',
    parameters: z.object({
      coordinates: z
        .object({
          x: z.number().describe('The x-coordinate for the mouse action.'),
          y: z.number().describe('The y-coordinate for the mouse action.'),
        })
        .optional()
        .describe(
          'Optional coordinates for the mouse press/release. If not provided, uses the current mouse position.',
        ),
      button: z
        .enum(['left', 'right', 'middle'])
        .describe('The mouse button to press or release.'),
      press: z
        .enum(['down', 'up'])
        .describe('The action to perform (press or release).'),
    }),
  })
  async pressMouse({
    coordinates,
    button,
    press,
  }: {
    coordinates?: { x: number; y: number };
    button: 'left' | 'right' | 'middle';
    press: 'down' | 'up';
  }) {
    try {
      await this.computerUse.action({
        action: 'press_mouse',
        coordinates,
        button,
        press,
      });
      return {
        content: [{ type: 'text', text: 'mouse pressed' }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error pressing mouse: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_drag_mouse',
    description:
      'Drags the mouse from a starting point along a path while holding a specified button.',
    parameters: z.object({
      path: z
        .array(
          z.object({
            x: z
              .number()
              .describe('The x-coordinate of a point in the drag path.'),
            y: z
              .number()
              .describe('The y-coordinate of a point in the drag path.'),
          }),
        )
        .describe(
          'An array of coordinate objects representing the drag path. The first coordinate is the start point.',
        ),
      button: z
        .enum(['left', 'right', 'middle'])
        .describe('The mouse button to hold while dragging.'),
      holdKeys: z
        .array(z.string())
        .optional()
        .describe('Optional array of keys to hold during the drag.'),
    }),
  })
  async dragMouse({
    path,
    button,
    holdKeys,
  }: {
    path: { x: number; y: number }[];
    button: 'left' | 'right' | 'middle';
    holdKeys?: string[];
  }) {
    try {
      await this.computerUse.action({
        action: 'drag_mouse',
        path,
        button,
        holdKeys,
      });
      return {
        content: [{ type: 'text', text: 'mouse dragged' }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error dragging mouse: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_scroll',
    description: 'Scrolls the mouse wheel up, down, left, or right.',
    parameters: z.object({
      coordinates: z
        .object({
          x: z
            .number()
            .describe(
              'The x-coordinate for the scroll action (if applicable).',
            ),
          y: z
            .number()
            .describe(
              'The y-coordinate for the scroll action (if applicable).',
            ),
        })
        .optional()
        .describe(
          'Coordinates for where the scroll should occur. Behavior might depend on the OS/application.',
        ),
      direction: z
        .enum(['up', 'down', 'left', 'right'])
        .describe('The direction to scroll the mouse wheel.'),
      scrollCount: z
        .number()
        .describe('The number of times to scroll the mouse wheel.'),
      holdKeys: z
        .array(z.string())
        .optional()
        .describe('Optional array of keys to hold during the scroll.'),
    }),
  })
  async scroll({
    coordinates,
    direction,
    scrollCount,
    holdKeys,
  }: {
    coordinates?: { x: number; y: number };
    direction: 'up' | 'down' | 'left' | 'right';
    scrollCount: number;
    holdKeys?: string[];
  }) {
    try {
      await this.computerUse.action({
        action: 'scroll',
        coordinates,
        direction,
        scrollCount,
        holdKeys,
      });
      return { content: [{ type: 'text', text: 'scrolled' }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error scrolling: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_type_keys',
    description: `Simulates typing a sequence of keys, often used for shortcuts involving modifier keys (e.g., Ctrl+C). Presses and releases each key in order.
    
────────────────────────
VALID KEYS
────────────────────────
A, Add, AudioForward, AudioMute, AudioNext, AudioPause, AudioPlay, AudioPrev, AudioRandom, AudioRepeat, AudioRewind, AudioStop, AudioVolDown, AudioVolUp,  
B, Backslash, Backspace,  
C, CapsLock, Clear, Comma,  
D, Decimal, Delete, Divide, Down,  
E, End, Enter, Equal, Escape, F,  
F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, F13, F14, F15, F16, F17, F18, F19, F20, F21, F22, F23, F24,  
Fn,  
G, Grave,  
H, Home,  
I, Insert,  
J, K, L, Left, LeftAlt, LeftBracket, LeftCmd, LeftControl, LeftShift, LeftSuper, LeftWin,  
M, Menu, Minus, Multiply,  
N, Num0, Num1, Num2, Num3, Num4, Num5, Num6, Num7, Num8, Num9, NumLock,  
NumPad0, NumPad1, NumPad2, NumPad3, NumPad4, NumPad5, NumPad6, NumPad7, NumPad8, NumPad9,  
O, P, PageDown, PageUp, Pause, Period, Print,  
Q, Quote,  
R, Return, Right, RightAlt, RightBracket, RightCmd, RightControl, RightShift, RightSuper, RightWin,  
S, ScrollLock, Semicolon, Slash, Space, Subtract,  
T, Tab,  
U, Up,  
V, W, X, Y, Z`,
    parameters: z.object({
      keys: z
        .array(z.string())
        .describe(
          'An array of key names to type in sequence (e.g., ["control", "c"]).',
        ),
      delay: z
        .number()
        .optional()
        .describe('Optional delay in milliseconds between key presses.'),
    }),
  })
  async typeKeys({ keys, delay }: { keys: string[]; delay?: number }) {
    try {
      await this.computerUse.action({ action: 'type_keys', keys, delay });
      return { content: [{ type: 'text', text: 'keys typed' }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error typing keys: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_press_keys',
    description: `Simulates pressing down or releasing specific keys. Useful for holding modifier keys.     
────────────────────────
VALID KEYS
────────────────────────
A, Add, AudioForward, AudioMute, AudioNext, AudioPause, AudioPlay, AudioPrev, AudioRandom, AudioRepeat, AudioRewind, AudioStop, AudioVolDown, AudioVolUp,  
B, Backslash, Backspace,  
C, CapsLock, Clear, Comma,  
D, Decimal, Delete, Divide, Down,  
E, End, Enter, Equal, Escape, F,  
F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, F13, F14, F15, F16, F17, F18, F19, F20, F21, F22, F23, F24,  
Fn,  
G, Grave,  
H, Home,  
I, Insert,  
J, K, L, Left, LeftAlt, LeftBracket, LeftCmd, LeftControl, LeftShift, LeftSuper, LeftWin,  
M, Menu, Minus, Multiply,  
N, Num0, Num1, Num2, Num3, Num4, Num5, Num6, Num7, Num8, Num9, NumLock,  
NumPad0, NumPad1, NumPad2, NumPad3, NumPad4, NumPad5, NumPad6, NumPad7, NumPad8, NumPad9,  
O, P, PageDown, PageUp, Pause, Period, Print,  
Q, Quote,  
R, Return, Right, RightAlt, RightBracket, RightCmd, RightControl, RightShift, RightSuper, RightWin,  
S, ScrollLock, Semicolon, Slash, Space, Subtract,  
T, Tab,  
U, Up,  
V, W, X, Y, Z  
      `,
    parameters: z.object({
      keys: z
        .array(z.string())
        .describe(
          'An array of key names to press or release (e.g., ["shift"]).',
        ),
      press: z
        .enum(['down', 'up'])
        .describe('Whether to press the keys down or release them up.'),
    }),
  })
  async pressKeys({ keys, press }: { keys: string[]; press: 'down' | 'up' }) {
    try {
      await this.computerUse.action({ action: 'press_keys', keys, press });
      return { content: [{ type: 'text', text: 'keys pressed' }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error pressing keys: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_type_text',
    description:
      'Types a string of text character by character. Use this tool for strings less than 25 characters, or passwords/sensitive form fields.',
    parameters: z.object({
      text: z.string().describe('The text string to type.'),
      delay: z
        .number()
        .optional()
        .describe('Optional delay in milliseconds between key presses.'),
    }),
  })
  async typeText({ text, delay }: { text: string; delay?: number }) {
    try {
      await this.computerUse.action({ action: 'type_text', text, delay });
      return { content: [{ type: 'text', text: 'text typed' }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error typing text: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_paste_text',
    description:
      'Copies text to the clipboard and pastes it. Use this tool for typing long text strings or special characters not on the standard keyboard.',
    parameters: z.object({
      text: z.string().describe('The text string to paste.'),
    }),
  })
  async pasteText({ text }: { text: string }) {
    try {
      await this.computerUse.action({ action: 'paste_text', text });
      return { content: [{ type: 'text', text: 'text pasted' }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error pasting text: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_wait',
    description: 'Pauses execution for a specified duration.',
    parameters: z.object({
      duration: z
        .number()
        .default(500)
        .describe('The duration to wait in milliseconds.'),
    }),
  })
  async wait({ duration }: { duration: number }) {
    try {
      await this.computerUse.action({ action: 'wait', duration });
      return { content: [{ type: 'text', text: 'waiting done' }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error waiting: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_application',
    description:
      'Opens or switches to the specified application and maximizes it.',
    parameters: z.object({
      application: z.enum([
        'firefox',
        '1password',
        'thunderbird',
        'vscode',
        'terminal',
        'desktop',
        'directory',
      ]),
    }),
  })
  async application({
    application,
  }: {
    application:
      | 'firefox'
      | '1password'
      | 'thunderbird'
      | 'vscode'
      | 'terminal'
      | 'desktop'
      | 'directory';
  }) {
    try {
      await this.computerUse.action({ action: 'application', application });
      return { content: [{ type: 'text', text: 'application opened' }] };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error opening application: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_screenshot',
    description: 'Captures a screenshot of the current screen.',
  })
  async screenshot() {
    try {
      const shot = (await this.computerUse.action({
        action: 'screenshot',
      })) as { image: string };
      return {
        content: [
          {
            type: 'image',
            data: await compressPngBase64Under1MB(shot.image),
            mimeType: 'image/png',
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error taking screenshot: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_cursor_position',
    description: 'Gets the current (x, y) coordinates of the mouse cursor.',
  })
  async cursorPosition() {
    try {
      const pos = (await this.computerUse.action({
        action: 'cursor_position',
      })) as { x: number; y: number };
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(pos),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error getting cursor position: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_write_file',
    description:
      'Writes a file to the specified path with base64 encoded data.',
    parameters: z.object({
      path: z
        .string()
        .describe('The file path where the file should be written.'),
      data: z.string().describe('Base64 encoded file data to write.'),
    }),
  })
  async writeFile({ path, data }: { path: string; data: string }) {
    try {
      const result = await this.computerUse.action({
        action: 'write_file',
        path,
        data,
      });
      return {
        content: [
          {
            type: 'text',
            text: result.message || 'File written successfully',
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error writing file: ${(err as Error).message}`,
          },
        ],
      };
    }
  }

  @Tool({
    name: 'computer_read_file',
    description:
      'Reads a file from the specified path and returns it as a document content block with base64 encoded data.',
    parameters: z.object({
      path: z.string().describe('The file path to read from.'),
    }),
  })
  async readFile({ path }: { path: string }) {
    try {
      const result = await this.computerUse.action({
        action: 'read_file',
        path,
      });

      if (result.success && result.data) {
        // Return document content block
        return {
          content: [
            {
              type: 'document',
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
        return {
          content: [
            {
              type: 'text',
              text: result.message || 'Error reading file',
            },
          ],
        };
      }
    } catch (err) {
      return {
        content: [
          {
            type: 'text',
            text: `Error reading file: ${(err as Error).message}`,
          },
        ],
      };
    }
  }
}
