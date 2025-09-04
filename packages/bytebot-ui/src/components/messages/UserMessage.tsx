import React from "react";
import ReactMarkdown from "react-markdown";
import { GroupedMessages } from "@/types";
import { MessageAvatar } from "./MessageAvatar";
import {
  isTextContentBlock,
  isToolResultContentBlock,
  isImageContentBlock,
} from "@bytebot/shared";

interface UserMessageProps {
  group: GroupedMessages;
  messageIdToIndex: Record<string, number>;
}

export function UserMessage({ group, messageIdToIndex }: UserMessageProps) {
  if (messageIdToIndex[group.messages[0].id] === 0) {
    return (
      <div className="sticky top-0 z-10 bg-bytebot-bronze-light-4">
        <div className="border-bytebot-bronze-light-7 flex items-start justify-start gap-2 border px-4 py-3 bg-bytebot-bronze-light-2 rounded-t-lg">
          <MessageAvatar role={group.role} />

          <div>
            {group.messages.map((message) => (
              <div
                key={message.id}
                data-message-index={messageIdToIndex[message.id]}
              >
                {/* Render hidden divs for each screenshot block */}
                {message.content.map((block, blockIndex) => {
                  if (
                    isToolResultContentBlock(block) &&
                    block.content &&
                    block.content.length > 0
                  ) {
                    // Check ALL content items in the tool result, not just the first one
                    const markers: React.ReactNode[] = [];
                    block.content.forEach((contentItem, contentIndex) => {
                      if (isImageContentBlock(contentItem)) {
                        markers.push(
                          <div
                            key={`${blockIndex}-${contentIndex}`}
                            data-message-index={messageIdToIndex[message.id]}
                            data-block-index={blockIndex}
                            data-content-index={contentIndex}
                            style={{
                              position: "absolute",
                              width: 0,
                              height: 0,
                              overflow: "hidden",
                            }}
                          />
                        );
                      }
                    });
                    return markers;
                  }
                  return null;
                })}
                <div className="bg-bytebot-bronze-light-4 space-y-2 rounded-md px-2 py-1">
                  {message.content.map((block, index) => (
                    <div
                      key={index}
                      className="text-bytebot-bronze-light-12 text-sm"
                    >
                      {isTextContentBlock(block) && (
                        <ReactMarkdown>{block.text}</ReactMarkdown>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-bytebot-bronze-light-3 flex items-start justify-end gap-2 px-4 py-3 border-x border-bytebot-bronze-light-7">
      <div>
        {group.messages.map((message) => (
          <div
            key={message.id}
            data-message-index={messageIdToIndex[message.id]}
          >
            {/* Render hidden divs for each screenshot block */}
            {message.content.map((block, blockIndex) => {
              if (
                isToolResultContentBlock(block) &&
                block.content &&
                block.content.length > 0
              ) {
                // Check ALL content items in the tool result, not just the first one
                const markers: React.ReactNode[] = [];
                block.content.forEach((contentItem, contentIndex) => {
                  if (isImageContentBlock(contentItem)) {
                    markers.push(
                      <div
                        key={`${blockIndex}-${contentIndex}`}
                        data-message-index={messageIdToIndex[message.id]}
                        data-block-index={blockIndex}
                        data-content-index={contentIndex}
                        style={{
                          position: "absolute",
                          width: 0,
                          height: 0,
                          overflow: "hidden",
                        }}
                      />
                    );
                  }
                });
                return markers;
              }
              return null;
            })}
            <div className="space-y-2 rounded-md text-fuchsia-600">
              {message.content.map((block, index) => (
                <div key={index} className="prose prose-sm max-w-none text-sm">
                  {isTextContentBlock(block) && (
                    <ReactMarkdown>{block.text}</ReactMarkdown>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <MessageAvatar role={group.role} />
    </div>
  );
}
