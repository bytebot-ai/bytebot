"use client";

import React, { useEffect, useRef, useState } from "react";
import { Header } from "@/components/layout/Header";
import { VncViewer } from "@/components/vnc/VncViewer";
import { ChatContainer } from "@/components/messages/ChatContainer";
import { ChatInput } from "@/components/messages/ChatInput";
import { useChatSession } from "@/hooks/useChatSession";
import { ArrowLeftToLine, ArrowRightToLine, Move } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Home() {
  const vncContainerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const { messages, input, setInput, isLoading, isLoadingSession, handleSend } =
    useChatSession();

  const [isMounted, setIsMounted] = useState(false);
  const [chatPosition, setChatPosition] = useState<"left" | "right" | "free">("right");
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const [chatOffset, setChatOffset] = useState({ x: 0, y: 0 });

  // Set isMounted to true after component mounts
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Calculate the container size on mount and window resize
  useEffect(() => {
    if (!isMounted) return;

    const updateSize = () => {
      if (!vncContainerRef.current) return;

      // When in free mode, don't reserve space for the chat panel
      const chatWidth = chatPosition !== "free" ? 350 : 0;
      const availableWidth = window.innerWidth - chatWidth;
      const availableHeight = window.innerHeight - 80; // Account for header height

      // Calculate the maximum size while maintaining 1280:720 aspect ratio
      let width, height;
      const aspectRatio = 1280 / 720;

      if (availableWidth / availableHeight > aspectRatio) {
        // Height is the limiting factor
        height = availableHeight;
        width = height * aspectRatio;
      } else {
        // Width is the limiting factor
        width = availableWidth;
        height = width / aspectRatio;
      }

      // Cap at maximum dimensions if needed
      width = Math.min(width, 1280);
      height = Math.min(height, 720);

      setContainerSize({ width, height });
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, [isMounted, chatPosition]);

  // Handle dragging
  useEffect(() => {
    if (!isMounted || chatPosition !== "free") return;

    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const newX = e.clientX - dragStartRef.current.x;
        const newY = e.clientY - dragStartRef.current.y;
        
        // Ensure the chat stays within viewport bounds
        const maxX = window.innerWidth - 320;
        const maxY = window.innerHeight - 200;
        
        setChatOffset({
          x: Math.max(0, Math.min(newX, maxX)),
          y: Math.max(0, Math.min(newY, maxY))
        });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    }

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, isMounted, chatPosition]);

  // Handle drag start
  const handleDragStart = (e: React.MouseEvent) => {
    if (chatPosition === "free") {
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX - chatOffset.x,
        y: e.clientY - chatOffset.y,
      };
    }
  };

  // Handle position change
  const handlePositionChange = (newPosition: "left" | "right" | "free") => {
    setChatPosition(newPosition);
    
    if (newPosition === "free" && chatOffset.x === 0 && chatOffset.y === 0) {
      // Initialize free position if it hasn't been set yet
      setChatOffset({
        x: window.innerWidth - 350,
        y: 100
      });
    }
  };

  return (
    <div className="flex flex-col h-screen bg-bronze-light-3">
      {/* Header */}
      <Header />
      
      {/* Main content area */}
      <main className="flex flex-1 p-4 overflow-hidden">
        <div className="flex w-full h-full">
          {/* Left side: Chat UI when position is left */}
          {chatPosition === "left" && (
            <div className="w-80 mr-4 flex flex-col bg-bronze-light-1 border border-bronze-light-4/30 rounded-xl shadow-md overflow-hidden">
              <ChatHeader 
                position={chatPosition} 
                onPositionChange={handlePositionChange} 
                onDragStart={handleDragStart} 
              />
              <div className="flex-1 flex flex-col min-h-0">
                <ChatContent messages={messages} input={input} isLoading={isLoading} 
                  isLoadingSession={isLoadingSession} setInput={setInput} handleSend={handleSend} />
              </div>
            </div>
          )}
          
          {/* Center: VNC Viewer */}
          <div className={cn(
            "flex-1 flex items-center justify-center",
            chatPosition === "free" && "w-full"
          )}>
            <div
              ref={vncContainerRef}
              className="relative bg-bronze-light-3/10 rounded-xl overflow-hidden shadow-sm mx-auto"
              style={{
                width: `${containerSize.width}px`,
                height: `${containerSize.height}px`,
              }}
            >
              <VncViewer />
            </div>
          </div>
          
          {/* Right side: Chat UI when position is right */}
          {chatPosition === "right" && (
            <div className="w-80 ml-4 flex flex-col bg-bronze-light-1 border border-bronze-light-4/30 rounded-xl shadow-md overflow-hidden">
              <ChatHeader 
                position={chatPosition} 
                onPositionChange={handlePositionChange} 
                onDragStart={handleDragStart} 
              />
              <div className="flex-1 flex flex-col min-h-0">
                <ChatContent messages={messages} input={input} isLoading={isLoading} 
                  isLoadingSession={isLoadingSession} setInput={setInput} handleSend={handleSend} />
              </div>
            </div>
          )}
          
          {/* Freely positioned chat UI - absolute positioning */}
          {chatPosition === "free" && (
            <div 
              className="fixed w-80 flex flex-col bg-bronze-light-1 border border-bronze-light-4/30 rounded-xl shadow-md overflow-hidden z-50"
              style={{
                position: 'fixed',
                top: `${chatOffset.y}px`,
                left: `${chatOffset.x}px`,
                height: 'calc(100vh - 120px)'
              }}
            >
              <ChatHeader 
                position={chatPosition} 
                onPositionChange={handlePositionChange} 
                onDragStart={handleDragStart} 
              />
              <div className="flex-1 flex flex-col min-h-0">
                <ChatContent messages={messages} input={input} isLoading={isLoading} 
                  isLoadingSession={isLoadingSession} setInput={setInput} handleSend={handleSend} />
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

// Chat header component with position controls
function ChatHeader({ 
  position, 
  onPositionChange,
  onDragStart
}: { 
  position: "left" | "right" | "free"; 
  onPositionChange: (position: "left" | "right" | "free") => void;
  onDragStart: (e: React.MouseEvent) => void;
}) {
  return (
    <div 
      className="flex items-center justify-between px-4 py-2 bg-bronze-light-1 border-b border-bronze-light-4/30 cursor-move"
      onMouseDown={onDragStart}
    >
      <div className="flex items-center gap-2">
        <div className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-light-6 flex items-center justify-center">
          <span className="text-bronze-light-1 text-xs font-medium">B</span>
        </div>
        <h3 className="text-sm font-medium text-bronze-light-12">Chat</h3>
      </div>
      
      <div className="flex items-center space-x-1">
        {/* Position controls */}
        <button
          onClick={() => onPositionChange("left")}
          className={cn(
            "p-1 rounded-sm transition-colors",
            position === "left"
              ? "bg-bronze-light-3 text-blue-light-6"
              : "hover:bg-bronze-light-3/40 text-bronze-light-8"
          )}
          aria-label="Snap to left"
        >
          <ArrowLeftToLine className="h-4 w-4" />
        </button>
        <button
          onClick={() => onPositionChange("free")}
          className={cn(
            "p-1 rounded-sm transition-colors",
            position === "free"
              ? "bg-bronze-light-3 text-blue-light-6"
              : "hover:bg-bronze-light-3/40 text-bronze-light-8"
          )}
          aria-label="Free positioning"
        >
          <Move className="h-4 w-4" />
        </button>
        <button
          onClick={() => onPositionChange("right")}
          className={cn(
            "p-1 rounded-sm transition-colors",
            position === "right"
              ? "bg-bronze-light-3 text-blue-light-6"
              : "hover:bg-bronze-light-3/40 text-bronze-light-8"
          )}
          aria-label="Snap to right"
        >
          <ArrowRightToLine className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function ChatContent({ 
  messages, 
  input, 
  isLoading, 
  isLoadingSession, 
  setInput, 
  handleSend 
}: { 
  messages: any;
  input: string; 
  isLoading: boolean; 
  isLoadingSession: boolean; 
  setInput: (input: string) => void; 
  handleSend: () => void;
}) {
  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 min-h-0 overflow-auto">
        <ChatContainer
          messages={messages}
          isLoadingSession={isLoadingSession}
        />
      </div>
      <div className="mt-auto">
        <ChatInput
          input={input}
          isLoading={isLoading}
          onInputChange={setInput}
          onSend={handleSend}
        />
      </div>
    </div>
  );
}
