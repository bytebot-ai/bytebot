import React from "react";
import {
  MessageContentBlock,
  isTextContentBlock,
  isImageContentBlock,
  isComputerToolUseContentBlock,
  isToolResultContentBlock,
} from "@bytebot/shared";
import { TextContent } from "./TextContent";
import { ImageContent } from "./ImageContent";
import { ComputerToolContent } from "./ComputerToolContent";

interface MessageContentProps {
  content: MessageContentBlock[];
  isTakeOver?: boolean;
}

export function MessageContent({ content, isTakeOver = false }: MessageContentProps) {
  // Filter content blocks and check if any visible content remains
  const visibleBlocks = content.filter((block) => {
    // Filter logic from the original code
    if (
      isToolResultContentBlock(block) &&
      isImageContentBlock(block.content?.[0])
    ) {
      return true;
    }
    if (isToolResultContentBlock(block) && !block.is_error) {
      return false;
    }
    return true;
  });

  // Skip rendering if no visible content
  if (visibleBlocks.length === 0) {
    return null;
  }

  return (
    <div className="w-full">
      {visibleBlocks.map((block, index) => (
        <div key={index}>
          {isTextContentBlock(block) && <TextContent block={block} />}

          {isImageContentBlock(block.content?.[0]) && (
            <ImageContent block={block.content[0]} />
          )}

          {isComputerToolUseContentBlock(block) && (
            <ComputerToolContent block={block} isTakeOver={isTakeOver} />
          )}
        </div>
      ))}
    </div>
  );
}