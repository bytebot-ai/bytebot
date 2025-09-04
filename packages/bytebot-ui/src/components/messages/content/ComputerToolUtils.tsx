import {
  Camera01Icon,
  User03Icon,
  Cursor02Icon,
  TypeCursorIcon,
  MouseRightClick06Icon,
  TimeQuarter02Icon,
  BrowserIcon,
  FilePasteIcon,
  FileIcon,
} from "@hugeicons/core-free-icons";
import {
  ComputerToolUseContentBlock,
  isScreenshotToolUseBlock,
  isWaitToolUseBlock,
  isTypeKeysToolUseBlock,
  isTypeTextToolUseBlock,
  isPressKeysToolUseBlock,
  isMoveMouseToolUseBlock,
  isScrollToolUseBlock,
  isCursorPositionToolUseBlock,
  isClickMouseToolUseBlock,
  isDragMouseToolUseBlock,
  isPressMouseToolUseBlock,
  isTraceMouseToolUseBlock,
  isApplicationToolUseBlock,
  isPasteTextToolUseBlock,
  isReadFileToolUseBlock,
} from "@bytebot/shared";

// Define the IconType for proper type checking
export type IconType =
  | typeof Camera01Icon
  | typeof User03Icon
  | typeof Cursor02Icon
  | typeof TypeCursorIcon
  | typeof MouseRightClick06Icon
  | typeof TimeQuarter02Icon
  | typeof BrowserIcon
  | typeof FilePasteIcon
  | typeof FileIcon;

export function getIcon(block: ComputerToolUseContentBlock): IconType {
  if (isScreenshotToolUseBlock(block)) {
    return Camera01Icon;
  }

  if (isWaitToolUseBlock(block)) {
    return TimeQuarter02Icon;
  }

  if (
    isTypeKeysToolUseBlock(block) ||
    isTypeTextToolUseBlock(block) ||
    isPressKeysToolUseBlock(block)
  ) {
    return TypeCursorIcon;
  }

  if (isPasteTextToolUseBlock(block)) {
    return FilePasteIcon;
  }

  if (
    isMoveMouseToolUseBlock(block) ||
    isScrollToolUseBlock(block) ||
    isCursorPositionToolUseBlock(block) ||
    isClickMouseToolUseBlock(block) ||
    isDragMouseToolUseBlock(block) ||
    isPressMouseToolUseBlock(block) ||
    isTraceMouseToolUseBlock(block)
  ) {
    if (block.input.button === "right") {
      return MouseRightClick06Icon;
    }

    return Cursor02Icon;
  }

  if (isApplicationToolUseBlock(block)) {
    return BrowserIcon;
  }

  if (isReadFileToolUseBlock(block)) {
    return FileIcon;
  }

  return User03Icon;
}

export function getLabel(block: ComputerToolUseContentBlock) {
  if (isScreenshotToolUseBlock(block)) {
    return "Screenshot";
  }

  if (isWaitToolUseBlock(block)) {
    return "Wait";
  }

  if (isTypeKeysToolUseBlock(block)) {
    return "Keys";
  }

  if (isTypeTextToolUseBlock(block)) {
    return "Type";
  }

  if (isPasteTextToolUseBlock(block)) {
    return "Paste";
  }

  if (isPressKeysToolUseBlock(block)) {
    return "Press Keys";
  }

  if (isMoveMouseToolUseBlock(block)) {
    return "Move Mouse";
  }

  if (isScrollToolUseBlock(block)) {
    return "Scroll";
  }

  if (isCursorPositionToolUseBlock(block)) {
    return "Cursor Position";
  }

  if (isClickMouseToolUseBlock(block)) {
    const button = block.input.button;
    if (button === "left") {
      if (block.input.clickCount === 2) {
        return "Double Click";
      }

      if (block.input.clickCount === 3) {
        return "Triple Click";
      }

      return "Click";
    }

    return `${block.input.button?.charAt(0).toUpperCase() + block.input.button?.slice(1)} Click`;
  }

  if (isDragMouseToolUseBlock(block)) {
    return "Drag";
  }

  if (isPressMouseToolUseBlock(block)) {
    return "Press Mouse";
  }

  if (isTraceMouseToolUseBlock(block)) {
    return "Trace Mouse";
  }

  if (isApplicationToolUseBlock(block)) {
    return "Open Application";
  }

  if (isReadFileToolUseBlock(block)) {
    return "Read File";
  }

  return "Unknown";
}
