"use client";

import React, { useState, useEffect, useRef } from "react";
import Image from "next/image";
import { motion, AnimatePresence } from "motion/react";
import { Header } from "@/components/layout/Header";
import { ChatInput } from "@/components/messages/ChatInput";
import { useRouter } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { startTask } from "@/utils/taskUtils";
import { TaskList } from "@/components/tasks/TaskList";
import { SUPPORTED_MODELS, DEFAULT_MODEL } from "@/constants/models";

// Stock photo component for easy image switching
interface StockPhotoProps {
  src: string;
  alt?: string;
}

const StockPhoto: React.FC<StockPhotoProps> = ({
  src,
  alt = "Decorative image",
}) => {
  return (
    <div className="h-full w-full overflow-hidden rounded-lg bg-white">
      <div className="relative h-full w-full">
        <Image src={src} alt={alt} fill className="object-cover" priority />
      </div>
    </div>
  );
};

export default function Home() {
  const [input, setInput] = useState("");
  const [selectedModel, setSelectedModel] = useState<string>(DEFAULT_MODEL);
  const [isLoading, setIsLoading] = useState(false);
  const router = useRouter();
  const [activePopoverIndex, setActivePopoverIndex] = useState<number | null>(
    null,
  );
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef<HTMLDivElement>(null);

  // Close popover when clicking outside or pressing ESC
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        popoverRef.current && 
        !popoverRef.current.contains(event.target as Node) &&
        buttonsRef.current &&
        !buttonsRef.current.contains(event.target as Node)
      ) {
        setActivePopoverIndex(null);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setActivePopoverIndex(null);
      }
    };

    if (activePopoverIndex !== null) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("keydown", handleKeyDown);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [activePopoverIndex]);

  const handleSend = async () => {
    if (!input.trim()) return;

    setIsLoading(true);

    try {
      // Send request to start a new task
      const task = await startTask(input, selectedModel);

      if (task && task.id) {
        // Redirect to the task page
        router.push(`/tasks/${task.id}`);
      } else {
        // Handle error
        console.error("Failed to create task");
      }
    } catch (error) {
      console.error("Error sending message:", error);
    } finally {
      setIsLoading(false);
    }
  };

  // Handle popover open state change
  const handleOpenChange = (isOpen: boolean, index: number) => {
    setActivePopoverIndex(isOpen ? index : null);
  };

  // Handle selecting a use case
  const handleSelectUseCase = (useCase: string) => {
    setInput(useCase);
    setActivePopoverIndex(null);
  };

  // Topic use cases for popovers
  const topicUseCases = {
    Research: [
      "Create a comprehensive report on computer use agents",
      "Find market trends for my industry",
      "Analyze competitor strategies",
    ],
    Create: [
      "Draft a blog post about AI trends",
      "Design a marketing campaign",
      "Create a content calendar",
    ],
    Plan: [
      "Develop a project timeline",
      "Create a business strategy",
      "Plan a product launch",
    ],
    Analyze: [
      "Analyze trending startup keywords on Product Hunt",
      "Review my website analytics",
      "Evaluate marketing campaign performance",
    ],
    Learn: [
      "Summarize the top blog posts from Hacker News",
      "Fetch YouTube videos about AI tools",
      "Collect insights from Reddit",
    ],
  };

  const renderTopicButtons = () => {
    const topicNames = Object.keys(topicUseCases) as Array<
      keyof typeof topicUseCases
    >;

    return (
      <div className="relative mt-6 flex w-full flex-wrap justify-start gap-1" ref={popoverRef}>
        {/* Container for buttons */}
        <div className="flex w-full flex-wrap gap-1" ref={buttonsRef}>
          {topicNames.map((topic, index) => (
            <div key={topic} className="relative">
              <button
                className={`shadow-bytebot cursor-pointer px-3 py-[5px] text-sm ${activePopoverIndex === index ? "text-bytebot-bronze-light-12" : "text-bytebot-bronze-light-11"} bg-bytebot-bronze-light-3 border-bytebot-bronze-light-a7 hover:bg-bytebot-bronze-light-2 rounded-full border transition-colors`}
                onClick={() =>
                  handleOpenChange(activePopoverIndex !== index, index)
                }
              >
                {topic}
              </button>
            </div>
          ))}
        </div>

        {/* Popover container positioned relative to the parent */}
        <AnimatePresence>
          {activePopoverIndex !== null && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ 
                duration: 0.3, 
                ease: [0.4, 0.0, 0.2, 1] 
              }}
              className="bg-bytebot-bronze-light-3 shadow-bytebot border-bytebot-bronze-light-7 absolute top-full left-0 z-40 mt-1 w-[500px] overflow-hidden rounded-xl border p-1.5"
            >
              <div className="max-h-[300px] space-y-1 overflow-y-auto">
                {topicUseCases[topicNames[activePopoverIndex]].map(
                  (useCase: string, idx: number) => (
                    <motion.div
                      key={idx}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ 
                        duration: 0.2, 
                        delay: idx * 0.03,
                        ease: [0.4, 0.0, 0.2, 1] 
                      }}
                      className="text-bytebot-bronze-light-12 hover:bg-bytebot-bronze-light-2 cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors"
                      onClick={() => {
                        console.log("Clicked use case:", useCase);
                        handleSelectUseCase(useCase);
                      }}
                    >
                      {useCase}
                    </motion.div>
                  ),
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      <Header />

      <main className="flex flex-1 flex-col overflow-hidden">
        {/* Desktop grid layout (50/50 split) - only visible on large screens */}
        <div className="hidden h-full p-8 lg:grid lg:grid-cols-2 lg:gap-8">
          {/* Main content area */}
          <div className="flex flex-col items-center overflow-y-auto">
            <div className="flex w-full max-w-xl flex-col items-center">
              <div className="mb-6 flex w-full flex-col items-start justify-start">
                <h1 className="text-bytebot-bronze-light-12 mb-1 text-2xl">
                  Got something brewing?
                </h1>
                <p className="text-bytebot-bronze-light-10 text-2xl">
                  Let&apos;s dive in!
                </p>
              </div>

              <div className="bg-bytebot-bronze-light-2 border-bytebot-bronze-light-5 shadow-bytebot w-full rounded-2xl border-[0.5px] p-3">
                <ChatInput
                  input={input}
                  isLoading={isLoading}
                  onInputChange={setInput}
                  onSend={handleSend}
                  minLines={3}
                />
                <div className="mt-3">
                  <Select value={selectedModel} onValueChange={(value) => setSelectedModel(value)}>
                    <SelectTrigger className="w-auto">
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_MODELS.map((model) => (
                        <SelectItem key={model.value} value={model.value}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {renderTopicButtons()}

              {/* Task list section */}
              <div className="border-bytebot-bronze-light-5 mt-8 w-full border-t pt-6">
                <TaskList title="Latest Tasks" />
              </div>
            </div>
          </div>

          {/* Stock photo area - centered in its grid cell */}
          <div className="flex items-center justify-center px-6 pt-6">
            <div className="aspect-square h-full w-full max-w-md xl:max-w-2xl">
              <StockPhoto src="/stock-1.png" alt="Bytebot stock image" />
            </div>
          </div>
        </div>

        {/* Mobile layout - only visible on small/medium screens */}
        <div className="flex h-full flex-col lg:hidden">
          <div className="flex flex-1 flex-col items-center overflow-y-auto px-4 pt-10">
            <div className="flex w-full max-w-xl flex-col items-center pb-10">
              <div className="mb-6 flex w-full flex-col items-start justify-start">
                <h1 className="text-bytebot-bronze-light-12 mb-1 text-2xl">
                  Got something brewing?
                </h1>
                <p className="text-bytebot-bronze-light-10 text-2xl">
                  Let&apos;s dive in!
                </p>
              </div>

              <div className="bg-bytebot-bronze-light-2 border-bytebot-bronze-light-5 shadow-bytebot w-full rounded-2xl border-[0.5px] p-3">
                <ChatInput
                  input={input}
                  isLoading={isLoading}
                  onInputChange={setInput}
                  onSend={handleSend}
                  minLines={3}
                />
                <div className="mt-3">
                  <Select value={selectedModel} onValueChange={(value) => setSelectedModel(value)}>
                    <SelectTrigger className="w-auto">
                      <SelectValue placeholder="Select a model" />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_MODELS.map((model) => (
                        <SelectItem key={model.value} value={model.value}>
                          {model.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {renderTopicButtons()}

              {/* Task list section */}
              <div className="border-bytebot-bronze-light-5 mt-8 w-full border-t pt-6">
                <TaskList title="Latest Tasks" />
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
