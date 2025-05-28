// Content block types
export enum MessageContentType {
  Text = "text",
  Image = "image",
  ToolUse = "tool_use",
  ToolResult = "tool_result",
}

// Base type with only the discriminator
export type MessageContentBlockBase = {
  type: MessageContentType;
  content?: MessageContentBlock[];
};

export type TextContentBlock = {
  type: MessageContentType.Text;
  text: string;
} & MessageContentBlockBase;

export type ImageContentBlock = {
  type: MessageContentType.Image;
  source: {
    media_type: "image/png";
    type: "base64";
    data: string;
  };
} & MessageContentBlockBase;

export type ToolUseContentBlock = {
  type: MessageContentType.ToolUse;
  name: string;
  id: string;
  input: Record<string, any>;
} & MessageContentBlockBase;

export type Coordinates = { x: number; y: number };
export type Button = "left" | "right" | "middle";
export type Press = "up" | "down";

export type MoveMouseToolUseBlock = ToolUseContentBlock & {
  name: "computer_move_mouse";
  input: {
    coordinates: Coordinates;
  };
};

export type TraceMouseToolUseBlock = ToolUseContentBlock & {
  name: "computer_trace_mouse";
  input: {
    path: Coordinates[];
    holdKeys?: string[];
  };
};

export type ClickMouseToolUseBlock = ToolUseContentBlock & {
  name: "computer_click_mouse";
  input: {
    coordinates?: Coordinates;
    button: Button;
    holdKeys?: string[];
    numClicks?: number;
  };
};

export type PressMouseToolUseBlock = ToolUseContentBlock & {
  name: "computer_press_mouse";
  input: {
    coordinates?: Coordinates;
    button: Button;
    press: Press;
  };
};

export type DragMouseToolUseBlock = ToolUseContentBlock & {
  name: "computer_drag_mouse";
  input: {
    path: Coordinates[];
    button: Button;
    holdKeys?: string[];
  };
};

export type ScrollToolUseBlock = ToolUseContentBlock & {
  name: "computer_scroll";
  input: {
    coordinates?: Coordinates;
    direction: "up" | "down" | "left" | "right";
    numScrolls: number;
    holdKeys?: string[];
  };
};

export type TypeKeysToolUseBlock = ToolUseContentBlock & {
  name: "computer_type_keys";
  input: {
    keys: string[];
    delay?: number;
  };
};

export type PressKeysToolUseBlock = ToolUseContentBlock & {
  name: "computer_press_keys";
  input: {
    keys: string[];
    press: Press;
  };
};

export type TypeTextToolUseBlock = ToolUseContentBlock & {
  name: "computer_type_text";
  input: {
    text: string;
    isSensitive?: boolean;
    delay?: number;
  };
};

export type WaitToolUseBlock = ToolUseContentBlock & {
  name: "computer_wait";
  input: {
    duration: number;
  };
};

export type ScreenshotToolUseBlock = ToolUseContentBlock & {
  name: "computer_screenshot";
};

export type CursorPositionToolUseBlock = ToolUseContentBlock & {
  name: "computer_cursor_position";
};

export type ComputerToolUseContentBlock =
  | MoveMouseToolUseBlock
  | TraceMouseToolUseBlock
  | ClickMouseToolUseBlock
  | PressMouseToolUseBlock
  | TypeKeysToolUseBlock
  | PressKeysToolUseBlock
  | TypeTextToolUseBlock
  | WaitToolUseBlock
  | ScreenshotToolUseBlock
  | DragMouseToolUseBlock
  | ScrollToolUseBlock
  | TypeTextToolUseBlock
  | CursorPositionToolUseBlock;

export type SetTaskStatusToolUseBlock = ToolUseContentBlock & {
  name: "set_task_status";
  input: {
    status: "completed" | "failed" | "needs_help";
  };
};

export type CreateTaskToolUseBlock = ToolUseContentBlock & {
  name: "create_task";
  input: {
    name: string;
    description: string;
    type?: "immediate" | "scheduled";
    scheduledFor?: string;
    priority: "low" | "medium" | "high" | "urgent";
  };
};

export type ToolResultContentBlock = {
  type: MessageContentType.ToolResult;
  tool_use_id: string;
  content: MessageContentBlock[];
  is_error?: boolean;
} & MessageContentBlockBase;

// Union type of all possible content blocks
export type MessageContentBlock =
  | TextContentBlock
  | ImageContentBlock
  | ToolUseContentBlock
  | ComputerToolUseContentBlock
  | ToolResultContentBlock;
