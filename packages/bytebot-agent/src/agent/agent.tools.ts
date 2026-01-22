/**
 * Common schema definitions for reuse
 */
const coordinateSchema = {
  type: 'object' as const,
  properties: {
    x: {
      type: 'number' as const,
      description: 'The x-coordinate',
    },
    y: {
      type: 'number' as const,
      description: 'The y-coordinate',
    },
  },
  required: ['x', 'y'],
};

const holdKeysSchema = {
  type: 'array' as const,
  items: { type: 'string' as const },
  description: 'Optional array of keys to hold during the action',
  nullable: true,
};

const buttonSchema = {
  type: 'string' as const,
  enum: ['left', 'right', 'middle'],
  description: 'The mouse button',
};

/**
 * Tool definitions for mouse actions
 */
export const _moveMouseTool = {
  name: 'computer_move_mouse',
  description: 'Moves the mouse cursor to the specified coordinates',
  input_schema: {
    type: 'object' as const,
    properties: {
      coordinates: {
        ...coordinateSchema,
        description: 'Target coordinates for mouse movement',
      },
    },
    required: ['coordinates'],
  },
};

export const _traceMouseTool = {
  name: 'computer_trace_mouse',
  description: 'Moves the mouse cursor along a specified path of coordinates',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'array' as const,
        items: coordinateSchema,
        description: 'Array of coordinate objects representing the path',
      },
      holdKeys: holdKeysSchema,
    },
    required: ['path'],
  },
};

export const _clickMouseTool = {
  name: 'computer_click_mouse',
  description:
    'Performs a mouse click at the specified coordinates or current position',
  input_schema: {
    type: 'object' as const,
    properties: {
      coordinates: {
        ...coordinateSchema,
        description:
          'Optional click coordinates (defaults to current position)',
        nullable: true,
      },
      button: buttonSchema,
      holdKeys: holdKeysSchema,
      clickCount: {
        type: 'integer' as const,
        description: 'Number of clicks to perform (e.g., 2 for double-click)',
        default: 1,
      },
    },
    required: ['button', 'clickCount'],
  },
};

export const _pressMouseTool = {
  name: 'computer_press_mouse',
  description: 'Presses or releases a specified mouse button',
  input_schema: {
    type: 'object' as const,
    properties: {
      coordinates: {
        ...coordinateSchema,
        description: 'Optional coordinates (defaults to current position)',
        nullable: true,
      },
      button: buttonSchema,
      press: {
        type: 'string' as const,
        enum: ['up', 'down'],
        description: 'Whether to press down or release up',
      },
    },
    required: ['button', 'press'],
  },
};

export const _dragMouseTool = {
  name: 'computer_drag_mouse',
  description: 'Drags the mouse along a path while holding a button',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'array' as const,
        items: coordinateSchema,
        description: 'Array of coordinates representing the drag path',
      },
      button: buttonSchema,
      holdKeys: holdKeysSchema,
    },
    required: ['path', 'button'],
  },
};

export const _scrollTool = {
  name: 'computer_scroll',
  description: 'Scrolls the mouse wheel in the specified direction',
  input_schema: {
    type: 'object' as const,
    properties: {
      coordinates: {
        ...coordinateSchema,
        description: 'Coordinates where the scroll should occur',
      },
      direction: {
        type: 'string' as const,
        enum: ['up', 'down', 'left', 'right'],
        description: 'The direction to scroll',
      },
      scrollCount: {
        type: 'integer' as const,
        description: 'Number of scroll steps',
      },
      holdKeys: holdKeysSchema,
    },
    required: ['coordinates', 'direction', 'scrollCount'],
  },
};

/**
 * Tool definitions for keyboard actions
 */
export const _typeKeysTool = {
  name: 'computer_type_keys',
  description: 'Types a sequence of keys (useful for keyboard shortcuts)',
  input_schema: {
    type: 'object' as const,
    properties: {
      keys: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Array of key names to type in sequence',
      },
      delay: {
        type: 'number' as const,
        description: 'Optional delay in milliseconds between key presses',
        nullable: true,
      },
    },
    required: ['keys'],
  },
};

export const _pressKeysTool = {
  name: 'computer_press_keys',
  description:
    'Presses or releases specific keys (useful for holding modifiers). ' +
    'Only use this for modifier holds (Shift/Ctrl/Alt/Meta) and provide holdMs <= 750. ' +
    'For non-modifier keys like Enter/Tab/Escape/arrows, use computer_type_keys (tap/chord-tap) or computer_type_text (e.g. "\\n" for Enter).',
  input_schema: {
    type: 'object' as const,
    properties: {
      keys: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Array of key names to press or release',
      },
      press: {
        type: 'string' as const,
        enum: ['up', 'down'],
        description: 'Whether to press down or release up',
      },
      holdMs: {
        type: 'integer' as const,
        description:
          'Optional hold duration in milliseconds for press="down". ' +
          'Only valid for modifier keys and will be capped at 750ms by the agent.',
        nullable: true,
        minimum: 0,
        maximum: 750,
      },
    },
    required: ['keys', 'press'],
  },
};

export const _typeTextTool = {
  name: 'computer_type_text',
  description:
    'Types a string of text character by character. Use this tool for strings less than 25 characters, or passwords/sensitive form fields.',
  input_schema: {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string' as const,
        description: 'The text string to type',
      },
      delay: {
        type: 'number' as const,
        description: 'Optional delay in milliseconds between characters',
        nullable: true,
      },
      isSensitive: {
        type: 'boolean' as const,
        description: 'Flag to indicate sensitive information',
        nullable: true,
      },
    },
    required: ['text'],
  },
};

export const _pasteTextTool = {
  name: 'computer_paste_text',
  description:
    'Copies text to the clipboard and pastes it. Use this tool for typing long text strings or special characters not on the standard keyboard.',
  input_schema: {
    type: 'object' as const,
    properties: {
      text: {
        type: 'string' as const,
        description: 'The text string to type',
      },
      isSensitive: {
        type: 'boolean' as const,
        description: 'Flag to indicate sensitive information',
        nullable: true,
      },
    },
    required: ['text'],
  },
};

/**
 * Tool definitions for utility actions
 */
export const _waitTool = {
  name: 'computer_wait',
  description: 'Pauses execution for a specified duration',
  input_schema: {
    type: 'object' as const,
    properties: {
      duration: {
        type: 'integer' as const,
        enum: [500],
        description: 'The duration to wait in milliseconds',
      },
    },
    required: ['duration'],
  },
};

export const _screenshotTool = {
  name: 'computer_screenshot',
  description: 'Captures a screenshot of the current screen',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
};

export const _cursorPositionTool = {
  name: 'computer_cursor_position',
  description: 'Gets the current (x, y) coordinates of the mouse cursor',
  input_schema: {
    type: 'object' as const,
    properties: {},
  },
};

export const _applicationTool = {
  name: 'computer_application',
  description: 'Opens or focuses an application and ensures it is fullscreen',
  input_schema: {
    type: 'object' as const,
    properties: {
      application: {
        type: 'string' as const,
        enum: [
          'firefox',
          '1password',
          'thunderbird',
          'vscode',
          'terminal',
          'desktop',
          'directory',
        ],
        description: 'The application to open or focus',
      },
    },
    required: ['application'],
  },
};

/**
 * Tool definitions for task management
 */
export const _setTaskStatusTool = {
  name: 'set_task_status',
  description: 'Sets the status of the current task',
  input_schema: {
    type: 'object' as const,
    properties: {
      status: {
        type: 'string' as const,
        enum: ['completed', 'needs_help'],
        description: 'The status of the task',
      },
      errorCode: {
        type: 'string' as const,
        description:
          'Optional structured reason code when status="needs_help". ' +
          'Use a specific code when external input or takeover is truly required; ' +
          'do not use needs_help for strategy decisions (pick a reasonable default and continue).',
        nullable: true,
        enum: [
          'GOAL_INTAKE_REQUIRED',
          'APPROVAL_REQUIRED',
          'DESKTOP_TAKEOVER_REQUIRED',
          'DISPATCHED_USER_PROMPT_STEP',
          'DESKTOP_NOT_ALLOWED',
          'LLM_EMPTY_RESPONSE',
          'TOOL_CONTRACT_VIOLATION',
          'LOOP_DETECTED_NO_PROGRESS',
          'UI_OBSERVATION_FAILED',
          'UI_BLOCKED_SIGNIN',
          'UI_BLOCKED_POPUP',
          'CAPABILITY_MISMATCH',
          'LLM_PROXY_DOWN',
          'MODEL_UNAVAILABLE',
          'WAITING_PROVIDER',
          // Contract violation codes are emitted by the agent when the model response is malformed.
          'CONTRACT_VIOLATION_UNTYPED_NEEDS_HELP',
          'CONTRACT_VIOLATION_STRATEGY_AS_HELP',
        ],
      },
      description: {
        type: 'string' as const,
        description:
          'If the task is completed, a summary of the task. If the task needs help, a description of the issue or clarification needed.',
      },
      details: {
        type: 'object' as const,
        description:
          'Optional structured details for status="needs_help". Must not include secrets.',
        nullable: true,
        additionalProperties: true,
      },
    },
    required: ['status', 'description'],
  },
};

export const _createTaskTool = {
  name: 'create_task',
  description: 'Creates a new task',
  input_schema: {
    type: 'object' as const,
    properties: {
      description: {
        type: 'string' as const,
        description: 'The description of the task',
      },
      type: {
        type: 'string' as const,
        enum: ['IMMEDIATE', 'SCHEDULED'],
        description: 'The type of the task (defaults to IMMEDIATE)',
      },
      scheduledFor: {
        type: 'string' as const,
        format: 'date-time',
        description: 'RFC 3339 / ISO 8601 datetime for scheduled tasks',
      },
      priority: {
        type: 'string' as const,
        enum: ['LOW', 'MEDIUM', 'HIGH', 'URGENT'],
        description: 'The priority of the task (defaults to MEDIUM)',
      },
    },
    required: ['description'],
  },
};

/**
 * Tool definition for reading files
 */
export const _readFileTool = {
  name: 'computer_read_file',
  description:
    'Reads a file from the specified path and returns it as a document content block with base64 encoded data',
  input_schema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string' as const,
        description: 'The file path to read from',
      },
    },
    required: ['path'],
  },
};

/**
 * Export all tools as an array
 */
export const agentTools = [
  _moveMouseTool,
  _traceMouseTool,
  _clickMouseTool,
  _pressMouseTool,
  _dragMouseTool,
  _scrollTool,
  _typeKeysTool,
  _pressKeysTool,
  _typeTextTool,
  _pasteTextTool,
  _waitTool,
  _screenshotTool,
  _applicationTool,
  _cursorPositionTool,
  _setTaskStatusTool,
  _createTaskTool,
  _readFileTool,
];
