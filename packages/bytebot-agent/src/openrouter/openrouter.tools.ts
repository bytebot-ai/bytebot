// OpenRouter uses OpenAI-compatible tools format
export const openrouterTools = [
  {
    type: 'function',
    function: {
      name: 'computer_screenshot',
      description: 'Take a screenshot of the current desktop',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_click',
      description: 'Click at the specified coordinates',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: 'X coordinate to click' },
          y: { type: 'number', description: 'Y coordinate to click' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_type_text',
      description: 'Type text at the current cursor position',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to type' },
          isSensitive: { 
            type: 'boolean', 
            description: 'Whether the text contains sensitive information',
            default: false,
          },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_press_keys',
      description: 'Press specified keyboard keys',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'array',
            items: { type: 'string' },
            description: 'Array of keys to press',
          },
        },
        required: ['keys'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'computer_application',
      description: 'Switch to or open a specific application',
      parameters: {
        type: 'object',
        properties: {
          application: {
            type: 'string',
            description: 'Application to open/switch to',
            enum: ['firefox', 'thunderbird', '1password', 'vscode', 'terminal', 'directory', 'desktop'],
          },
        },
        required: ['application'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_task_status',
      description: 'Set the status of the current task',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['completed', 'needs_help', 'failed'],
            description: 'The status to set for the task',
          },
          description: {
            type: 'string',
            description: 'Description of the status or help needed',
          },
        },
        required: ['status', 'description'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a new task',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'Description of the task to create',
          },
          type: {
            type: 'string',
            enum: ['IMMEDIATE', 'SCHEDULED'],
            description: 'Type of task to create',
          },
          priority: {
            type: 'string',
            enum: ['LOW', 'MEDIUM', 'HIGH'],
            description: 'Priority of the task',
          },
          scheduledFor: {
            type: 'string',
            description: 'ISO date string for when to schedule the task (required for SCHEDULED type)',
          },
        },
        required: ['description', 'type', 'priority'],
      },
    },
  },
];