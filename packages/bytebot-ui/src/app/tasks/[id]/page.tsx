"use client";

import React, { useEffect, useRef, useState } from "react";
import { Header } from "@/components/layout/Header";
import { VncViewer } from "@/components/vnc/VncViewer";
import { ScreenshotViewer } from "@/components/screenshot/ScreenshotViewer";
import { ChatContainer } from "@/components/messages/ChatContainer";
import { ChatInput } from "@/components/messages/ChatInput";
import { useChatSession } from "@/hooks/useChatSession";
import { useScrollScreenshot } from "@/hooks/useScrollScreenshot";
import { useParams, useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Role, TaskStatus } from "@/types";

export default function TaskPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.id as string;

  const containerRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const {
    messages,
    taskStatus,
    control,
    input,
    setInput,
    isLoading,
    isLoadingSession,
    handleGuideTask,
    handleTakeOverTask,
    handleResumeTask,
    currentTaskId,
  } = useChatSession({ initialTaskId: taskId });

  const [isMounted, setIsMounted] = useState(false);

  // Determine if task is inactive (show screenshot) or active (show VNC)
  const isTaskInactive =
    taskStatus === TaskStatus.COMPLETED ||
    taskStatus === TaskStatus.FAILED ||
    taskStatus === TaskStatus.CANCELLED;

  // Determine if user can take control
  const canTakeOver =
    control === Role.ASSISTANT && taskStatus === TaskStatus.RUNNING;

  // Determine if user has control or is in takeover mode
  const hasUserControl =
    control === Role.USER && taskStatus === TaskStatus.RUNNING;

  // Determine VNC mode - interactive when user has control, view-only otherwise
  const vncViewOnly = !hasUserControl;

  // Use scroll screenshot hook for inactive tasks
  const { currentScreenshot, allScreenshots } = useScrollScreenshot({
    messages,
    scrollContainerRef: chatContainerRef,
  });

  // Set isMounted to true after component mounts
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Redirect if task ID doesn't match current task
  useEffect(() => {
    if (currentTaskId && currentTaskId !== taskId) {
      router.push(`/tasks/${currentTaskId}`);
    }
  }, [currentTaskId, taskId, router]);

  // Calculate the container size on mount and window resize
  useEffect(() => {
    if (!isMounted) return;

    const updateSize = () => {
      if (!containerRef.current) return;

      const parentWidth =
        containerRef.current.parentElement?.offsetWidth ||
        containerRef.current.offsetWidth;
      const parentHeight =
        containerRef.current.parentElement?.offsetHeight ||
        containerRef.current.offsetHeight;

      // Calculate the maximum size while maintaining 1280:960 aspect ratio
      let width, height;
      const aspectRatio = 1280 / 960;

      if (parentWidth / parentHeight > aspectRatio) {
        // Width is the limiting factor
        height = parentHeight;
        width = height * aspectRatio;
      } else {
        // Height is the limiting factor
        width = parentWidth;
        height = width / aspectRatio;
      }

      // Cap at maximum dimensions
      width = Math.min(width, 1280);
      height = Math.min(height, 960);

      setContainerSize({ width, height });
    };

    updateSize();
    window.addEventListener("resize", updateSize);
    return () => window.removeEventListener("resize", updateSize);
  }, [isMounted]);

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      <main className="m-2 flex-1 overflow-hidden px-2 py-4">
        <div className="grid h-full grid-cols-7 gap-4">
          {/* Main container */}
          <div className="col-span-4">
            <div
              ref={containerRef}
              className="border-bytebot-bronze-light-5 shadow-bytebot flex aspect-[4/3] w-full flex-col rounded-lg border"
            >
              {/* Status Header */}
              <div className="border-bytebot-bronze-light-5 bg-bytebot-bronze-light-1 flex items-center justify-between rounded-t-lg border-b px-4 py-2">
                <div className="flex items-center gap-2">
                  <div
                    className={`h-2 w-2 rounded-full ${
                      taskStatus === TaskStatus.COMPLETED
                        ? "bg-green-500"
                        : taskStatus === TaskStatus.FAILED
                          ? "bg-red-500"
                          : taskStatus === TaskStatus.CANCELLED
                            ? "bg-gray-500"
                            : taskStatus === TaskStatus.RUNNING
                              ? "animate-pulse bg-green-400"
                              : "bg-yellow-400"
                    }`}
                  />
                  <span className="text-bytebot-bronze-dark-8 text-sm font-medium">
                    {isTaskInactive
                      ? `Task ${taskStatus.toLowerCase()} - Screenshot View`
                      : hasUserControl
                        ? "User Control - Interactive"
                        : taskStatus === TaskStatus.RUNNING
                          ? "Agent Control - Live View"
                          : `Task ${taskStatus.toLowerCase()} - Live View`}
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {canTakeOver && (
                    <button
                      onClick={handleTakeOverTask}
                      className="cursor-pointer rounded bg-gray-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-600"
                    >
                      Take Over
                    </button>
                  )}
                  {hasUserControl && (
                    <button
                      onClick={handleResumeTask}
                      className="cursor-pointer rounded bg-gray-500 px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-gray-600"
                    >
                      Resume
                    </button>
                  )}
                  {isTaskInactive && currentScreenshot && (
                    <span className="text-bytebot-bronze-light-11 bg-bytebot-bronze-light-3 rounded px-2 py-1 text-xs">
                      Screenshot{" "}
                      {allScreenshots.findIndex(
                        (s) => s.id === currentScreenshot.id,
                      ) + 1}{" "}
                      of {allScreenshots.length}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex-1 rounded-b-[14px]">
                <div
                  style={{
                    width: `${containerSize.width}px`,
                    height: `${containerSize.height}px`,
                    maxWidth: "100%",
                  }}
                >
                  {isTaskInactive ? (
                    <ScreenshotViewer
                      screenshot={currentScreenshot}
                      className="shadow-bytebot h-full w-full"
                    />
                  ) : (
                    <VncViewer viewOnly={vncViewOnly} />
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Chat Area */}
          <div className="col-span-3 flex h-full flex-col overflow-scroll">
            {/* Messages scrollable area */}
            <div className="flex-1 px-4 pt-4 pb-2">
              <ChatContainer
                taskStatus={taskStatus}
                messages={messages}
                isLoadingSession={isLoadingSession}
                scrollRef={chatContainerRef}
                control={control}
              />
            </div>

            {/* Fixed chat input */}

            {taskStatus === TaskStatus.NEEDS_HELP && (
              <div className="bg-bytebot-bronze-light-2 border-bytebot-bronze-light-5 shadow-bytebot rounded-2xl border-[0.5px] p-2">
                <ChatInput
                  input={input}
                  isLoading={isLoading}
                  onInputChange={setInput}
                  onSend={handleGuideTask}
                  minLines={1}
                />
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
