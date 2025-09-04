import React, { useRef, useEffect, useCallback, Fragment } from "react";
import { Role, TaskStatus, GroupedMessages } from "@/types";
import { MessageGroup } from "./MessageGroup";
import { TextShimmer } from "../ui/text-shimmer";
import { MessageAvatar } from "./MessageAvatar";
import { Loader } from "../ui/loader";
import { ChatInput } from "./ChatInput";

interface ChatContainerProps {
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  messageIdToIndex: Record<string, number>;
  taskId: string;
  input: string;
  setInput: (value: string) => void;
  isLoading: boolean;
  handleAddMessage: () => Promise<void>;
  groupedMessages: GroupedMessages[];
  taskStatus: TaskStatus;
  control: Role;
  isLoadingSession: boolean;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  loadMoreMessages: () => Promise<void>;
}

export function ChatContainer({
  scrollRef,
  messageIdToIndex,
  input,
  setInput,
  isLoading,
  handleAddMessage,
  groupedMessages,
  taskStatus,
  control,
  isLoadingSession,
  isLoadingMoreMessages,
  hasMoreMessages,
  loadMoreMessages,
}: ChatContainerProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Infinite scroll handler
  const handleScroll = useCallback(() => {
    if (!scrollRef?.current || !loadMoreMessages) {
      return;
    }

    const container = scrollRef.current;
    // Check if user scrolled to the bottom (within 20px - much more sensitive)
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

    if (distanceFromBottom <= 20 && hasMoreMessages && !isLoadingMoreMessages) {
      loadMoreMessages();
    }
  }, [scrollRef, loadMoreMessages, hasMoreMessages, isLoadingMoreMessages]);

  // Add scroll event listener
  useEffect(() => {
    const container = scrollRef?.current;
    if (container) {
      container.addEventListener("scroll", handleScroll);
      return () => container.removeEventListener("scroll", handleScroll);
    }
  }, [handleScroll, scrollRef]);

  // This effect runs whenever the grouped messages array changes
  useEffect(() => {
    if (
      taskStatus === TaskStatus.RUNNING ||
      taskStatus === TaskStatus.NEEDS_HELP
    ) {
      scrollToBottom();
    }
  }, [taskStatus, groupedMessages]);

  // Function to scroll to the bottom of the messages
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <div className="bg-bytebot-bronze-light-3 flex h-full flex-col">
      {isLoadingSession ? (
        <div className="bg-bytebot-bronze-light-3 border-bytebot-bronze-light-7 flex h-full min-h-80 items-center justify-center overflow-hidden rounded-lg border">
          <Loader size={32} />
        </div>
      ) : groupedMessages.length > 0 ? (
        <>
          {/* Content area - scrolling handled by parent */}
          <div className="flex-1">
            {groupedMessages.map((group, groupIndex) => (
              <Fragment key={groupIndex}>
                <MessageGroup
                  group={group}
                  messageIdToIndex={messageIdToIndex}
                  taskStatus={taskStatus}
                />
              </Fragment>
            ))}

            {taskStatus === TaskStatus.RUNNING &&
              control === Role.ASSISTANT && (
                <div className="bg-bytebot-bronze-light-3 border-bytebot-bronze-light-7 flex items-center justify-start gap-4 border-x px-4 py-3">
                  <MessageAvatar role={Role.ASSISTANT} />
                  <div className="flex items-center justify-start gap-2">
                    <div className="flex h-full items-center justify-center py-2">
                      <Loader size={20} />
                    </div>
                    <TextShimmer className="text-sm" duration={2}>
                      Bytebot is working...
                    </TextShimmer>
                  </div>
                </div>
              )}

            {/* Loading indicator for infinite scroll at bottom */}
            {isLoadingMoreMessages && (
              <div className="flex justify-center py-4">
                <Loader size={24} />
              </div>
            )}

            {/* This empty div is the target for scrolling */}
            <div ref={messagesEndRef} />
          </div>

          {/* Fixed chat input at bottom */}
          {[TaskStatus.RUNNING, TaskStatus.NEEDS_HELP].includes(taskStatus) && (
            <div className="bg-bytebot-bronze-light-3 z-10 flex-shrink-0">
              <div className="border-bytebot-bronze-light-7 rounded-b-lg border-x border-b p-2">
                <div className="bg-bytebot-bronze-light-2 border-bytebot-bronze-light-7 rounded-lg border p-2">
                  <ChatInput
                    input={input}
                    isLoading={isLoading}
                    onInputChange={setInput}
                    onSend={handleAddMessage}
                    minLines={1}
                    placeholder="Add more details to your task..."
                  />
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full items-center justify-center">
          <p className="">No messages yet...</p>
        </div>
      )}
    </div>
  );
}
