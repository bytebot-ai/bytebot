import React from "react";
import ReactMarkdown from "react-markdown";
import { GroupedMessages } from "@/types";
import { MessageAvatar } from "./MessageAvatar";
import { isTextContentBlock } from "@bytebot/shared";

interface UserMessageProps {
  group: GroupedMessages;
}

export function UserMessage({ group }: UserMessageProps) {
  return (
    <div className="mb-4 flex items-start justify-start gap-2 px-4 py-3">
      <MessageAvatar role={group.role} />
      
      <div>
        {group.messages.map((message) => (
          <div key={message.id}>
            <div className="max-w-4/5 space-y-2 bg-bytebot-bronze-light-4 rounded-md px-2 py-1">
              {message.content.map((block, index) => (
                <div key={index} className="text-bytebot-bronze-light-12 text-xs">
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
  );
}