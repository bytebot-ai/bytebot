import Anthropic from '@anthropic-ai/sdk';

// Tool definition for moving the mouse
export const moveMouseTool: Anthropic.Tool = {
  name: 'computer_move_mouse',
  description: 'Moves the mouse cursor to the specified coordinates.',
  input_schema: {
    type: 'object',
    properties: {
      coordinates: {
        type: 'object',
        properties: {
          x: {
            type: 'number',
            description: 'The x-coordinate to move the mouse to.',
          },
          y: {
            type: 'number',
            description: 'The y-coordinate to move the mouse to.',
          },
        },
        required: ['x', 'y'],
      },
    },
    required: ['coordinates'],
  },
};

// Tool definition for tracing a mouse path
export const traceMouseTool: Anthropic.Tool = {
  name: 'computer_trace_mouse',
  description: 'Moves the mouse cursor along a specified path of coordinates.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            x: {
              type: 'number',
              description: 'The x-coordinate of a point in the path.',
            },
            y: {
              type: 'number',
              description: 'The y-coordinate of a point in the path.',
            },
          },
          required: ['x', 'y'],
        },
        description: 'An array of coordinate objects representing the path.',
      },
      holdKeys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional array of keys to hold during the trace.',
        nullable: true,
      },
    },
    required: ['path'],
  },
};

// Tool definition for clicking the mouse
export const clickMouseTool: Anthropic.Tool = {
  name: 'computer_click_mouse',
  description:
    'Performs a mouse click at the specified coordinates or current position.',
  input_schema: {
    type: 'object',
    properties: {
      coordinates: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'The x-coordinate for the click.' },
          y: { type: 'number', description: 'The y-coordinate for the click.' },
        },
        required: ['x', 'y'],
        description:
          'Optional coordinates for the click. If not provided, clicks at the current mouse position.',
        nullable: true,
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'The mouse button to click.',
      },
      holdKeys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional array of keys to hold during the click.',
        nullable: true,
      },
      numClicks: {
        type: 'integer',
        description:
          'Optional number of clicks to perform (e.g., 2 for double-click). Defaults to 1.',
        nullable: true,
      },
    },
    required: ['button'],
  },
};

// Tool definition for pressing or releasing a mouse button
export const pressMouseTool: Anthropic.Tool = {
  name: 'computer_press_mouse',
  description:
    'Presses or releases a specified mouse button at the given coordinates or current position.',
  input_schema: {
    type: 'object',
    properties: {
      coordinates: {
        type: 'object',
        properties: {
          x: {
            type: 'number',
            description: 'The x-coordinate for the mouse action.',
          },
          y: {
            type: 'number',
            description: 'The y-coordinate for the mouse action.',
          },
        },
        required: ['x', 'y'],
        description:
          'Optional coordinates for the mouse press/release. If not provided, uses the current mouse position.',
        nullable: true,
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'The mouse button to press or release.',
      },
      press: {
        type: 'string',
        enum: ['up', 'down'],
        description: 'Whether to press the button down or release it up.',
      },
    },
    required: ['button', 'press'],
  },
};

// Tool definition for dragging the mouse
export const dragMouseTool: Anthropic.Tool = {
  name: 'computer_drag_mouse',
  description:
    'Drags the mouse from a starting point along a path while holding a specified button.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            x: {
              type: 'number',
              description: 'The x-coordinate of a point in the drag path.',
            },
            y: {
              type: 'number',
              description: 'The y-coordinate of a point in the drag path.',
            },
          },
          required: ['x', 'y'],
        },
        description:
          'An array of coordinate objects representing the drag path. The first coordinate is the start point.',
      },
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'],
        description: 'The mouse button to hold during the drag.',
      },
      holdKeys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional array of other keys to hold during the drag.',
        nullable: true,
      },
    },
    required: ['path', 'button'],
  },
};

// Tool definition for scrolling the mouse wheel
export const scrollTool: Anthropic.Tool = {
  name: 'computer_scroll',
  description: 'Scrolls the mouse wheel up, down, left, or right.',
  input_schema: {
    type: 'object',
    properties: {
      coordinates: {
        type: 'object',
        properties: {
          x: {
            type: 'number',
            description:
              'The x-coordinate for the scroll action (if applicable).',
          },
          y: {
            type: 'number',
            description:
              'The y-coordinate for the scroll action (if applicable).',
          },
        },
        required: ['x', 'y'],
        description:
          'Coordinates for where the scroll should occur. Behavior might depend on the OS/application.',
      },
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: 'The direction to scroll.',
      },
      numScrolls: {
        type: 'integer',
        description: 'The number of scroll steps or amount to scroll.',
      },
      holdKeys: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional array of keys to hold during the scroll.',
        nullable: true,
      },
    },
    required: ['coordinates', 'direction', 'numScrolls'],
  },
};

// Tool definition for typing a sequence of keys (e.g., modifiers + key)
export const typeKeysTool: Anthropic.Tool = {
  name: 'computer_type_keys',
  description:
    'Simulates typing a sequence of keys, often used for shortcuts involving modifier keys (e.g., Ctrl+C). Presses and releases each key in order.',
  input_schema: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string' },
        description:
          'An array of key names to type in sequence (e.g., ["control", "c"]).',
      },
      delay: {
        type: 'number',
        description: 'Optional delay in milliseconds between key presses.',
        nullable: true,
      },
    },
    required: ['keys'],
  },
};

// Tool definition for pressing or releasing specific keys
export const pressKeysTool: Anthropic.Tool = {
  name: 'computer_press_keys',
  description:
    'Simulates pressing down or releasing specific keys. Useful for holding modifier keys.',
  input_schema: {
    type: 'object',
    properties: {
      keys: {
        type: 'array',
        items: { type: 'string' },
        description:
          'An array of key names to press or release (e.g., ["shift"]).',
      },
      press: {
        type: 'string',
        enum: ['up', 'down'],
        description: 'Whether to press the keys down or release them up.',
      },
    },
    required: ['keys', 'press'],
  },
};

// Tool definition for typing a string of text
export const typeTextTool: Anthropic.Tool = {
  name: 'computer_type_text',
  description: 'Simulates typing a string of text character by character.',
  input_schema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text string to type.',
      },
      delay: {
        type: 'number',
        description:
          'Optional delay in milliseconds between character presses.',
        nullable: true,
      },
      isSensitive: {
        type: 'boolean',
        description:
          'Optional flag to indicate if the text contains sensitive information.',
        nullable: true,
      },
    },
    required: ['text'],
  },
};

// Tool definition for waiting a specified duration
export const waitTool: Anthropic.Tool = {
  name: 'computer_wait',
  description: 'Pauses execution for a specified duration.',
  input_schema: {
    type: 'object',
    properties: {
      duration: {
        type: 'number',
        description: 'The duration to wait in milliseconds.',
      },
    },
    required: ['duration'],
  },
};

// Tool definition for taking a screenshot
export const screenshotTool: Anthropic.Tool = {
  name: 'computer_screenshot',
  description: 'Captures a screenshot of the current screen.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

// Tool definition for getting the current cursor position
export const cursorPositionTool: Anthropic.Tool = {
  name: 'computer_cursor_position',
  description: 'Gets the current (x, y) coordinates of the mouse cursor.',
  input_schema: {
    type: 'object',
    properties: {},
  },
};

// Tool definition for ending a task
export const setTaskStatusTool: Anthropic.Tool = {
  name: 'set_task_status',
  description: 'Sets the status of the current task.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'string',
        enum: ['completed', 'failed', 'needs_help'],
        description: 'The status of the task.',
      },
    },
    required: ['status'],
  },
};

export const createTaskTool: Anthropic.Tool = {
  name: 'create_task',
  description: 'Creates a new task.',
  input_schema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'The description of the task.',
      },
      type: {
        type: 'string',
        enum: ['IMMEDIATE', 'SCHEDULED'],
        description: 'The type of the task. Default is immediate.',
      },
      scheduledFor: {
        type: 'string',
        format: 'date-time',
        description:
          'The scheduled time for the task, as an RFC 3339 / ISO 8601 combined date and time in UTC or with offset. Only used if type is scheduled.',
      },
      priority: {
        type: 'string',
        enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
        description: 'The priority of the task. Default is medium.',
      },
    },
    required: ['description'],
  },
};

// Array of all tools
export const anthropicTools: Anthropic.Tool[] = [
  moveMouseTool,
  traceMouseTool,
  clickMouseTool,
  pressMouseTool,
  dragMouseTool,
  scrollTool,
  typeKeysTool,
  pressKeysTool,
  typeTextTool,
  waitTool,
  screenshotTool,
  cursorPositionTool,
  setTaskStatusTool,
  createTaskTool,
];
