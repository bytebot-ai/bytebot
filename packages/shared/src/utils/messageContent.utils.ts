import {
  MessageContentBlock,
  MessageContentType,
  TextContentBlock,
  ImageContentBlock,
  DocumentContentBlock,
  ToolUseContentBlock,
  ComputerToolUseContentBlock,
  ToolResultContentBlock,
  MoveMouseToolUseBlock,
  TraceMouseToolUseBlock,
  ClickMouseToolUseBlock,
  PressMouseToolUseBlock,
  TypeKeysToolUseBlock,
  PressKeysToolUseBlock,
  TypeTextToolUseBlock,
  WaitToolUseBlock,
  ScreenshotToolUseBlock,
  CursorPositionToolUseBlock,
  DragMouseToolUseBlock,
  ScrollToolUseBlock,
  ApplicationToolUseBlock,
  SetTaskStatusToolUseBlock,
  CreateTaskToolUseBlock,
  ThinkingContentBlock,
  RedactedThinkingContentBlock,
  PasteTextToolUseBlock,
  WriteFileToolUseBlock,
  ReadFileToolUseBlock,
  UserActionContentBlock,
} from "../types/messageContent.types";

/**
 * Type guard to check if an object is a TextContentBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is TextContentBlock
 */
export function isTextContentBlock(obj: unknown): obj is TextContentBlock {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const block = obj as Partial<TextContentBlock>;
  return (
    block.type === MessageContentType.Text && typeof block.text === "string"
  );
}

export function isThinkingContentBlock(
  obj: unknown
): obj is ThinkingContentBlock {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const block = obj as Partial<ThinkingContentBlock>;
  return (
    block.type === MessageContentType.Thinking &&
    typeof block.thinking === "string" &&
    typeof block.signature === "string"
  );
}

export function isRedactedThinkingContentBlock(
  obj: unknown
): obj is RedactedThinkingContentBlock {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const block = obj as Partial<RedactedThinkingContentBlock>;
  return (
    block.type === MessageContentType.RedactedThinking &&
    typeof block.data === "string"
  );
}

/**
 * Type guard to check if an object is an ImageContentBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is ImageContentBlock
 */
export function isImageContentBlock(obj: unknown): obj is ImageContentBlock {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const block = obj as Partial<ImageContentBlock>;
  return (
    block.type === MessageContentType.Image &&
    block.source !== undefined &&
    typeof block.source === "object" &&
    typeof block.source.media_type === "string" &&
    typeof block.source.type === "string" &&
    typeof block.source.data === "string"
  );
}

export function isUserActionContentBlock(
  obj: unknown
): obj is UserActionContentBlock {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const block = obj as Partial<UserActionContentBlock>;

  return block.type === MessageContentType.UserAction;
}

/**
 * Type guard to check if an object is a DocumentContentBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is DocumentContentBlock
 */
export function isDocumentContentBlock(
  obj: unknown
): obj is DocumentContentBlock {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const block = obj as Partial<DocumentContentBlock>;
  return (
    block.type === MessageContentType.Document &&
    block.source !== undefined &&
    typeof block.source === "object" &&
    typeof block.source.type === "string" &&
    typeof block.source.media_type === "string" &&
    typeof block.source.data === "string"
  );
}

/**
 * Type guard to check if an object is a ToolUseContentBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is ToolUseContentBlock
 */
export function isToolUseContentBlock(
  obj: unknown
): obj is ToolUseContentBlock {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const block = obj as Partial<ToolUseContentBlock>;
  return (
    block.type === MessageContentType.ToolUse &&
    typeof block.name === "string" &&
    typeof block.id === "string" &&
    block.input !== undefined &&
    typeof block.input === "object"
  );
}

/**
 * Type guard to check if an object is a ComputerToolUseContentBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is ComputerToolUseContentBlock
 */
export function isComputerToolUseContentBlock(
  obj: unknown
): obj is ComputerToolUseContentBlock {
  if (!isToolUseContentBlock(obj)) {
    return false;
  }

  return (obj as ToolUseContentBlock).name.startsWith("computer_");
}

/**
 * Type guard to check if an object is a ToolResultContentBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is ToolResultContentBlock
 */
export function isToolResultContentBlock(
  obj: unknown
): obj is ToolResultContentBlock {
  if (!obj || typeof obj !== "object") {
    return false;
  }

  const block = obj as Partial<ToolResultContentBlock>;
  return (
    block.type === MessageContentType.ToolResult &&
    typeof block.tool_use_id === "string"
  );
}

/**
 * Type guard to check if an object is any type of MessageContentBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is MessageContentBlock
 */
export function isMessageContentBlock(
  obj: unknown
): obj is MessageContentBlock {
  return (
    isTextContentBlock(obj) ||
    isImageContentBlock(obj) ||
    isDocumentContentBlock(obj) ||
    isToolUseContentBlock(obj) ||
    isToolResultContentBlock(obj) ||
    isThinkingContentBlock(obj) ||
    isRedactedThinkingContentBlock(obj) ||
    isUserActionContentBlock(obj)
  );
}

/**
 * Determines the specific type of MessageContentBlock for a given object.
 * This doesn't narrow the type but can be useful for debugging or logging.
 * @param obj The object to check (should be a MessageContentBlock)
 * @returns A string indicating the specific type, or null if not a valid MessageContentBlock
 */
export function getMessageContentBlockType(obj: unknown): string | null {
  if (!obj || typeof obj !== "object") {
    return null;
  }

  if (isTextContentBlock(obj)) {
    return "TextContentBlock";
  }

  if (isImageContentBlock(obj)) {
    return "ImageContentBlock";
  }

  if (isDocumentContentBlock(obj)) {
    return "DocumentContentBlock";
  }

  if (isThinkingContentBlock(obj)) {
    return "ThinkingContentBlock";
  }

  if (isRedactedThinkingContentBlock(obj)) {
    return "RedactedThinkingContentBlock";
  }

  if (isComputerToolUseContentBlock(obj)) {
    const computerBlock = obj as ComputerToolUseContentBlock;
    if (computerBlock.input && typeof computerBlock.input === "object") {
      return `ComputerToolUseContentBlock:${computerBlock.name.replace(
        "computer_",
        ""
      )}`;
    }
    return "ComputerToolUseContentBlock";
  }

  if (isToolUseContentBlock(obj)) {
    return "ToolUseContentBlock";
  }

  if (isToolResultContentBlock(obj)) {
    return "ToolResultContentBlock";
  }

  return null;
}

/**
 * Type guard to check if an object is a MoveMouseToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is MoveMouseToolUseBlock
 */
export function isMoveMouseToolUseBlock(
  obj: unknown
): obj is MoveMouseToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_move_mouse";
}

/**
 * Type guard to check if an object is a TraceMouseToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is TraceMouseToolUseBlock
 */
export function isTraceMouseToolUseBlock(
  obj: unknown
): obj is TraceMouseToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_trace_mouse";
}

/**
 * Type guard to check if an object is a ClickMouseToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is ClickMouseToolUseBlock
 */
export function isClickMouseToolUseBlock(
  obj: unknown
): obj is ClickMouseToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_click_mouse";
}

/**
 * Type guard to check if an object is a CursorPositionToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is CursorPositionToolUseBlock
 */
export function isCursorPositionToolUseBlock(
  obj: unknown
): obj is CursorPositionToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_cursor_position";
}

/**
 * Type guard to check if an object is a PressMouseToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is PressMouseToolUseBlock
 */
export function isPressMouseToolUseBlock(
  obj: unknown
): obj is PressMouseToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_press_mouse";
}

/**
 * Type guard to check if an object is a DragMouseToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is DragMouseToolUseBlock
 */
export function isDragMouseToolUseBlock(
  obj: unknown
): obj is DragMouseToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_drag_mouse";
}

/**
 * Type guard to check if an object is a ScrollToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is ScrollToolUseBlock
 */
export function isScrollToolUseBlock(obj: unknown): obj is ScrollToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_scroll";
}

/**
 * Type guard to check if an object is a TypeKeysToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is TypeKeysToolUseBlock
 */
export function isTypeKeysToolUseBlock(
  obj: unknown
): obj is TypeKeysToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_type_keys";
}

/**
 * Type guard to check if an object is a PressKeysToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is PressKeysToolUseBlock
 */
export function isPressKeysToolUseBlock(
  obj: unknown
): obj is PressKeysToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_press_keys";
}

/**
 * Type guard to check if an object is a TypeTextToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is TypeTextToolUseBlock
 */
export function isTypeTextToolUseBlock(
  obj: unknown
): obj is TypeTextToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_type_text";
}

export function isPasteTextToolUseBlock(
  obj: unknown
): obj is PasteTextToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_paste_text";
}

/**
 * Type guard to check if an object is a WaitToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is WaitToolUseBlock
 */
export function isWaitToolUseBlock(obj: unknown): obj is WaitToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_wait";
}

/**
 * Type guard to check if an object is a ScreenshotToolUseBlock
 * @param obj The object to validate
 * @returns Type predicate indicating obj is ScreenshotToolUseBlock
 */
export function isScreenshotToolUseBlock(
  obj: unknown
): obj is ScreenshotToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_screenshot";
}

export function isApplicationToolUseBlock(
  obj: unknown
): obj is ApplicationToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_application";
}

export function isSetTaskStatusToolUseBlock(
  obj: unknown
): obj is SetTaskStatusToolUseBlock {
  if (!isToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "set_task_status";
}

export function isCreateTaskToolUseBlock(
  obj: unknown
): obj is CreateTaskToolUseBlock {
  if (!isToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "create_task";
}

export function isWriteFileToolUseBlock(
  obj: unknown
): obj is WriteFileToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_write_file";
}

export function isReadFileToolUseBlock(
  obj: unknown
): obj is ReadFileToolUseBlock {
  if (!isComputerToolUseContentBlock(obj)) {
    return false;
  }

  const block = obj as Record<string, any>;
  return block.name === "computer_read_file";
}
