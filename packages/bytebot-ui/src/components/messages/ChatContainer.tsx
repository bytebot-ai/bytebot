import React, { useRef, useEffect } from "react";
import { Message, Role, TaskStatus } from "@/types";
import { MessageGroup } from "./MessageGroup";
import { isToolResultContentBlock } from "@bytebot/shared";
import { TextShimmer } from "../ui/text-shimmer";

interface ChatContainerProps {
  taskStatus: TaskStatus;
  messages: Message[];
  isLoadingSession: boolean;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

export interface GroupedMessages {
  role: Role;
  messages: Message[];
}

/**
 * Groups back-to-back messages from the same role in a conversation JSON
 *
 * @param {Object} conversation - The conversation JSON object with messages array
 * @returns {Object} A new conversation object with grouped messages
 */
function groupBackToBackMessages(messages: Message[]): GroupedMessages[] {
  const groupedConversation: GroupedMessages[] = [];

  let currentGroup: GroupedMessages | null = null;

  for (const message of messages) {
    const role = message.role;

    // If this is the first message or role is different from the previous group
    if (!currentGroup || currentGroup.role !== role) {
      // Save the previous group if it exists
      if (currentGroup) {
        groupedConversation.push(currentGroup);
      }

      // Start a new group
      currentGroup = {
        role: role,
        messages: [message],
      };
    } else {
      // Same role as previous, merge the content
      currentGroup.messages.push(message);
    }
  }

  // Add the last group
  if (currentGroup) {
    groupedConversation.push(currentGroup);
  }

  return groupedConversation;
}

function filterMessages(messages: Message[]): Message[] {
  const filteredMessages: Message[] = [];
  for (const message of messages) {
    const contentBlocks = message.content;

    // If the role is a user message and all the content blocks are tool result blocks
    if (
      message.role === Role.USER &&
      contentBlocks.every((block) => isToolResultContentBlock(block))
    ) {
      message.role = Role.ASSISTANT;
    }

    filteredMessages.push(message);
  }
  return filteredMessages;
}

export function ChatContainer({
  taskStatus,
  messages,
  isLoadingSession,
  scrollRef,
}: ChatContainerProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Group back-to-back messages from the same role
  const groupedConversation = groupBackToBackMessages(filterMessages(messages));

  // This effect runs whenever the messages array changes
  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Function to scroll to the bottom of the messages
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div ref={scrollRef} className="flex-1 overflow-auto p-4">
      {isLoadingSession ? (
        <div className="flex h-full items-center justify-center">
          <div className="border-t-primary h-8 w-8 animate-spin rounded-full border-4 border-gray-300"></div>
        </div>
      ) : messages.length > 0 ? (
        <>
          {groupedConversation.map((group, groupIndex) => (
            <div key={groupIndex}>
              <MessageGroup group={group} messages={messages} />
            </div>
          ))}
          {taskStatus === TaskStatus.RUNNING && (
            <TextShimmer className="text-sm" duration={2}>
              Bytebot is working...
            </TextShimmer>
          )}
        </>
      ) : (
        <div className="flex h-full items-center justify-center">
          <p className="">No messages yet...</p>
        </div>
      )}
      {/* This empty div is the target for scrolling */}
      <div ref={messagesEndRef} />
    </div>
  );
}
