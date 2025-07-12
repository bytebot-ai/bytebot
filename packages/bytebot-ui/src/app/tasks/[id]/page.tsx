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
import { Role, TaskStatus, Model } from "@/types";
import { HugeiconsIcon } from "@hugeicons/react";
import { MoreHorizontalIcon, WavingHand01Icon } from "@hugeicons/core-free-icons";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";

export default function TaskPage() {
  const params = useParams();
  const router = useRouter();
  const taskId = params.id as string;

  const containerRef = useRef<HTMLDivElement>(null);
  const chatContainerRef = useRef<HTMLDivElement>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [models, setModels] = useState<Model[]>([]);
  const [selectedModel, setSelectedModel] = useState<Model | null>(null);
  const {
    messages,
    groupedMessages,
    taskStatus,
    control,
    input,
    setInput,
    isLoading,
    isLoadingSession,
    isLoadingMoreMessages,
    hasMoreMessages,
    loadMoreMessages,
    handleGuideTask,
    handleTakeOverTask,
    handleResumeTask,
    handleCancelTask,
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

  // Determine if task can be cancelled
  const canCancel =
    taskStatus === TaskStatus.RUNNING || taskStatus === TaskStatus.NEEDS_HELP;

  // Determine VNC mode - interactive when user has control, view-only otherwise
  const vncViewOnly = !hasUserControl;

  // Use scroll screenshot hook for inactive tasks
  const { currentScreenshot, allScreenshots } = useScrollScreenshot({
    messages,
    scrollContainerRef: chatContainerRef,
  });

  useEffect(() => {
    fetch('/api/tasks/models')
      .then((res) => res.json())
      .then((data) => {
        setModels(data);
        if (data.length > 0) setSelectedModel(data[0]);
      })
      .catch((err) => console.error('Failed to load models', err));
  }, []);

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
                  {taskStatus === TaskStatus.RUNNING && (
                    <span className="relative flex size-2 ml-1">
                      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-fuchsia-400 opacity-75"></span>
                      <span className="relative inline-flex size-2 rounded-full bg-green-700"></span>
                    </span>
                  )}
                  <span className="text-bytebot-bronze-light-12 text-md font-medium">
                    Virtual Desktop
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  {canTakeOver && (
                    <Button
                      onClick={handleTakeOverTask}
                      variant="default"
                      size="sm"
                      icon={<HugeiconsIcon icon={WavingHand01Icon} className="h-5 w-5" />}
                    >
                      Take Over
                    </Button>
                  )}
                  {hasUserControl && (
                    <Button
                      onClick={handleResumeTask}
                      variant="default" 
                      size="sm"
                    >
                      Proceed
                    </Button>
                  )}
                  {canCancel && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="cursor-pointer rounded p-1 hover:bg-gray-100 transition-colors">
                          <HugeiconsIcon icon={MoreHorizontalIcon} className="h-5 w-5 text-gray-500" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={handleCancelTask} className="text-red-600 focus:bg-red-50">
                          Cancel
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
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
          <div
            ref={chatContainerRef}
            className="col-span-3 flex h-full flex-col overflow-scroll"
          >
            {/* Messages scrollable area */}
            <div className="flex-1 px-4 pb-2">
              <ChatContainer
                taskStatus={taskStatus}
                groupedMessages={groupedMessages}
                isLoadingSession={isLoadingSession}
                isLoadingMoreMessages={isLoadingMoreMessages}
                hasMoreMessages={hasMoreMessages}
                loadMoreMessages={loadMoreMessages}
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
                <div className="mt-2">
                  <Select
                    value={selectedModel?.name}
                    onValueChange={(val) =>
                      setSelectedModel(models.find((m) => m.name === val) || null)
                    }
                  >
                    <SelectTrigger className="w-auto">
                      <SelectValue placeholder="Select an model" />
                    </SelectTrigger>
                    <SelectContent>
                      {models.map((m) => (
                        <SelectItem key={m.name} value={m.name}>
                          {m.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
