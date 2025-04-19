// Local copy of the utility functions for message content types
import {
  MessageContentType,
  TextContentBlock,
  ImageContentBlock,
  ToolUseContentBlock,
  ToolResultContentBlock,
  MessageContentBlock,
} from "@/types/messageContent.types";

export function isTextContentBlock(
  block: MessageContentBlock
): block is TextContentBlock {
  return block.type === MessageContentType.Text;
}

export function isImageContentBlock(
  block: MessageContentBlock
): block is ImageContentBlock {
  return block.type === MessageContentType.Image;
}

export function isToolUseContentBlock(
  block: MessageContentBlock
): block is ToolUseContentBlock {
  return block.type === MessageContentType.ToolUse;
}

export function isToolResultContentBlock(
  block: MessageContentBlock
): block is ToolResultContentBlock {
  return block.type === MessageContentType.ToolResult;
}
