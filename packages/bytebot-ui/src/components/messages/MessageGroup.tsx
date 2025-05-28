import React from "react";
import ReactMarkdown from "react-markdown";
import { Message, Role } from "@/types";
import {
  isImageContentBlock,
  isTextContentBlock,
  isToolResultContentBlock,
  isComputerToolUseContentBlock,
  isScreenshotToolUseBlock,
  isWaitToolUseBlock,
  isMoveMouseToolUseBlock,
  isCursorPositionToolUseBlock,
  isScrollToolUseBlock,
  isClickMouseToolUseBlock,
  isDragMouseToolUseBlock,
  isPressMouseToolUseBlock,
  isTraceMouseToolUseBlock,
  isTypeKeysToolUseBlock,
  isTypeTextToolUseBlock,
  isPressKeysToolUseBlock,
} from "@bytebot/shared";
import Image from "next/image";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Camera01Icon,
  User03Icon,
  Cursor02Icon,
  TypeCursorIcon,
  MouseRightClick06Icon,
  TimeQuarter02Icon,
} from "@hugeicons/core-free-icons";
import { ComputerToolUseContentBlock } from "@bytebot/shared";
import { GroupedMessages } from "./ChatContainer";

// Define the IconType for proper type checking
type IconType =
  | typeof Camera01Icon
  | typeof User03Icon
  | typeof Cursor02Icon
  | typeof TypeCursorIcon
  | typeof MouseRightClick06Icon
  | typeof TimeQuarter02Icon;

interface MessageGroupProps {
  group: GroupedMessages;
  messages?: Message[];
}

function getIcon(block: ComputerToolUseContentBlock): IconType {
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

  return User03Icon;
}

function getLabel(block: ComputerToolUseContentBlock) {
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
      if (block.input.numClicks === 2) {
        return "Double Click";
      }

      if (block.input.numClicks === 3) {
        return "Triple Click";
      }

      return "Click";
    }

    return `${block.input.button.charAt(0).toUpperCase() + block.input.button.slice(1)} Click`;
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

  return "Unknown";
}

export function MessageGroup({ group, messages = [] }: MessageGroupProps) {
  if (group.role === Role.ASSISTANT) {
    return <AssistantMessage group={group} messages={messages} />;
  }

  return <UserMessage group={group} messages={messages} />;
}

export function AssistantMessage({ group, messages = [] }: MessageGroupProps) {
  return (
    <div className="mb-4">
      {group.messages.map((message) => {
        const messageIndex = messages.findIndex((m) => m.id === message.id);

        // Filter content blocks and check if any visible content remains
        const visibleBlocks = message.content.filter((block) => {
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
          <div
            key={message.id}
            data-message-index={messageIndex}
            className="mb-2 flex items-start gap-2"
          >
            <div className="border-bytebot-bronze-light-7 flex h-[28px] w-[28px] flex-shrink-0 items-center justify-center rounded-sm border bg-white">
              <Image
                src="/bytebot_square_light.svg"
                alt="Bytebot"
                width={16}
                height={16}
                className="h-4 w-4"
              />
            </div>
            <div className="w-full space-y-2">
              {visibleBlocks.map((block, index) => (
                <div key={index}>
                  {isTextContentBlock(block) && (
                    <div className="text-bytebot-bronze-dark-8 text-sm">
                      <ReactMarkdown>{block.text}</ReactMarkdown>
                    </div>
                  )}

                  {isImageContentBlock(block.content?.[0]) && (
                    <div className="bg-bytebot-bronze-light-2 border-bytebot-bronze-light-7 shadow-bytebot max-w-4/5 overflow-hidden rounded-md border">
                      <div className="border-bytebot-bronze-light-7 flex items-center gap-2 border-b px-3 py-2">
                        <HugeiconsIcon
                          icon={Camera01Icon}
                          className="text-bytebot-bronze-dark-9 h-4 w-4"
                        />
                        <p className="text-bytebot-bronze-light-11 text-xs">
                          Screenshot taken
                        </p>
                      </div>
                      <div className="relative h-48 w-full">
                        <Image
                          src={`data:image/png;base64,${block.content[0].source.data}`}
                          alt="Screenshot"
                          fill
                          className="object-contain"
                        />
                      </div>
                    </div>
                  )}

                  {isComputerToolUseContentBlock(block) && (
                    <div className="bg-bytebot-bronze-light-2 border-bytebot-bronze-light-7 shadow-bytebot max-w-4/5 rounded-md border px-3 py-2">
                      <div className="flex items-center gap-2">
                        <HugeiconsIcon
                          icon={getIcon(block)}
                          className="text-bytebot-bronze-dark-9 h-4 w-4"
                        />
                        <p className="text-bytebot-bronze-light-11 text-xs">
                          {getLabel(block)}
                        </p>
                        {/* Text for type and key actions */}
                        {(isTypeKeysToolUseBlock(block) ||
                          isPressKeysToolUseBlock(block)) && (
                          <p className="bg-bytebot-bronze-light-1 border-bytebot-bronze-light-7 text-bytebot-bronze-light-11 rounded-md border px-1 py-0.5 text-xs">
                            {String(block.input.keys.join("+"))}
                          </p>
                        )}
                        {isTypeTextToolUseBlock(block) && (
                          <p className="bg-bytebot-bronze-light-1 border-bytebot-bronze-light-7 text-bytebot-bronze-light-11 rounded-md border px-1 py-0.5 text-xs">
                            {String(
                              block.input.isSensitive
                                ? "●".repeat(block.input.text.length)
                                : block.input.text,
                            )}
                          </p>
                        )}
                        {/* Duration for wait and hold_key actions */}
                        {isWaitToolUseBlock(block) && (
                          <p className="bg-bytebot-bronze-light-1 border-bytebot-bronze-light-7 text-bytebot-bronze-light-11 rounded-md border px-1 py-0.5 text-xs">
                            {`${block.input.duration}ms`}
                          </p>
                        )}
                        {/* Coordinates for click/mouse actions */}
                        {block.input.coordinates && (
                          <p className="bg-bytebot-bronze-light-1 border-bytebot-bronze-light-7 text-bytebot-bronze-light-11 rounded-md border px-1 py-0.5 text-xs">
                            {
                              (
                                block.input.coordinates as {
                                  x: number;
                                  y: number;
                                }
                              ).x
                            }
                            ,{" "}
                            {
                              (
                                block.input.coordinates as {
                                  x: number;
                                  y: number;
                                }
                              ).y
                            }
                          </p>
                        )}
                        {/* Start and end coordinates for path actions */}
                        {"path" in block.input &&
                          Array.isArray(block.input.path) &&
                          block.input.path.every(
                            (point) =>
                              point.x !== undefined && point.y !== undefined,
                          ) && (
                            <p className="bg-bytebot-bronze-light-1 border-bytebot-bronze-light-7 text-bytebot-bronze-light-11 rounded-md border px-1 py-0.5 text-xs">
                              From: {block.input.path[0].x},{" "}
                              {block.input.path[0].y} → To:{" "}
                              {block.input.path[block.input.path.length - 1].x},{" "}
                              {block.input.path[block.input.path.length - 1].y}
                            </p>
                          )}
                        {/* Scroll information */}
                        {isScrollToolUseBlock(block) && (
                          <p className="bg-bytebot-bronze-light-1 border-bytebot-bronze-light-7 text-bytebot-bronze-light-11 rounded-md border px-1 py-0.5 text-xs">
                            {String(block.input.direction)}{" "}
                            {Number(block.input.numScrolls)}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function UserMessage({ group, messages = [] }: MessageGroupProps) {
  return (
    <div className="mb-4">
      {group.messages.map((message) => {
        const messageIndex = messages.findIndex((m) => m.id === message.id);
        return (
          <div
            key={message.id}
            data-message-index={messageIndex}
            className="mb-2 flex flex-row-reverse items-start gap-2"
          >
            <div className="border-bytebot-bronze-light-7 bg-muted flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-sm border">
              <HugeiconsIcon
                icon={User03Icon}
                className="text-bytebot-bronze-dark-9 h-4 w-4"
              />
            </div>
            <div className="bg-bytebot-bronze-light-2 border-bytebot-bronze-light-7 shadow-bytebot max-w-4/5 space-y-2 rounded-md border px-3 py-2">
              {message.content.map((block, index) => (
                <div key={index} className="text-bytebot-bronze-dark-9 text-xs">
                  {isTextContentBlock(block) && (
                    <ReactMarkdown>{block.text}</ReactMarkdown>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
