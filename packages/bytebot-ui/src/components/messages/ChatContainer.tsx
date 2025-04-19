import React, { useRef, useEffect } from "react";
import { Message } from "@/types";
import { MessageItem } from "./MessageItem";

interface ChatContainerProps {
  messages: Message[];
  isLoadingSession: boolean;
}

export function ChatContainer({
  messages,
  isLoadingSession,
}: ChatContainerProps) {
  const chatContainerRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    if (chatContainerRef.current) {
      chatContainerRef.current.scrollTop =
        chatContainerRef.current.scrollHeight;
    }
  }, [messages]);

  return (
    <div 
      ref={chatContainerRef} 
      className="flex-1 overflow-auto p-3 space-y-4"
    >
      {isLoadingSession ? (
        <div className="flex justify-center items-center h-full">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-bronze-light-4 border-t-blue-light-6"></div>
        </div>
      ) : messages.length > 0 ? (
        messages.map((message) => (
          <MessageItem key={message.id} message={message} />
        ))
      ) : (
        <div className="flex flex-col justify-center items-center h-full space-y-3">
          <p className="text-sm text-bronze-light-7">Ask me to do something...</p>
        </div>
      )}
    </div>
  );
}
