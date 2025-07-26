import React, { useRef, useEffect, useCallback, Fragment } from "react";
import { Role, TaskStatus, GroupedMessages } from "@/types";
import { MessageGroup } from "./MessageGroup";
import { TextShimmer } from "../ui/text-shimmer";
import { MessageAvatar } from "./MessageAvatar";
import { Loader } from "../ui/loader";
import { useChatSession } from "@/hooks/useChatSession";
import { ChatInput } from "./ChatInput";

interface ChatContainerProps {
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  messageIdToIndex: Record<string, number>;
  taskId: string;
}


export function ChatContainer({
  scrollRef,
  taskId,
  messageIdToIndex,
}: ChatContainerProps) {
  const {
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
  } = useChatSession({ initialTaskId: taskId });

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
    <div className="bg-bytebot-bronze-light-2">
      {isLoadingSession ? (
        <div className="flex h-full items-center justify-center min-h-80 bg-bytebot-bronze-light-3">
          <Loader size={32} />
        </div>
      ) : groupedMessages.length > 0 ? (
        <>
          {groupedMessages.map((group, groupIndex) => (
            <Fragment key={groupIndex}>
              <MessageGroup group={group} taskStatus={taskStatus} messageIdToIndex={messageIdToIndex} />
            </Fragment>
          ))}

          {taskStatus === TaskStatus.RUNNING && control === Role.ASSISTANT && (
            <div className="flex items-center justify-start gap-4 px-4 py-3 bg-bytebot-bronze-light-3 border-x border-bytebot-bronze-light-7">
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

          {/* Fixed chat input */}
          {[TaskStatus.RUNNING, TaskStatus.NEEDS_HELP].includes(taskStatus) && (
            <div className="sticky bottom-0 z-10 bg-bytebot-bronze-light-3">
              <div className="p-2 border-x border-b border-bytebot-bronze-light-7 rounded-b-lg">
                <div className="bg-bytebot-bronze-light-2 border border-bytebot-bronze-light-7 rounded-lg p-2">
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
      {/* This empty div is the target for scrolling */}
      <div ref={messagesEndRef} />
    </div>
  );
}
