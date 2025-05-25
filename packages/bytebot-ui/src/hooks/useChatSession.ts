import { useState, useEffect, useRef, useCallback } from "react";
import { Message, Role, TaskStatus, Task, TakeOverState } from "@/types";
import {
  guideTask,
  fetchTaskMessages,
  fetchTaskById,
  startTask,
  takeOverTask,
  resumeTaskControl,
} from "@/utils/taskUtils";
import { MessageContentType } from "@bytebot/shared";
import { useWebSocket } from "./useWebSocket";

interface UseChatSessionProps {
  initialTaskId?: string;
}

export function useChatSession({ initialTaskId }: UseChatSessionProps = {}) {
  const [taskStatus, setTaskStatus] = useState<TaskStatus>(TaskStatus.PENDING);
  const [takeOverState, setTakeOverState] = useState<TakeOverState>(TakeOverState.AGENT_CONTROL);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(
    initialTaskId || null,
  );
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingSession, setIsLoadingSession] = useState(true);

  const processedMessageIds = useRef<Set<string>>(new Set());

  // WebSocket event handlers
  const handleTaskUpdate = useCallback((task: Task) => {
    if (task.id === currentTaskId) {
      setTaskStatus(task.status);
      setTakeOverState(task.takeOverState);
    }
  }, [currentTaskId]);

  const handleNewMessage = useCallback((message: Message) => {
    // Only add message if it's not already processed and belongs to current task
    if (!processedMessageIds.current.has(message.id) && 
        message.taskId === currentTaskId) {
      console.log('Adding new message from WebSocket:', message);
      processedMessageIds.current.add(message.id);
      setMessages((prev) => [...prev, message]);
    }
  }, [currentTaskId]);

  const handleTaskCreated = useCallback((task: Task) => {
    console.log('New task created:', task);
  }, []);

  const handleTaskDeleted = useCallback((taskId: string) => {
    if (taskId === currentTaskId) {
      console.log('Current task was deleted');
      setCurrentTaskId(null);
      setMessages([]);
      processedMessageIds.current = new Set();
    }
  }, [currentTaskId]);

  // Initialize WebSocket connection
  const { joinTask, leaveTask } = useWebSocket({
    onTaskUpdate: handleTaskUpdate,
    onNewMessage: handleNewMessage,
    onTaskCreated: handleTaskCreated,
    onTaskDeleted: handleTaskDeleted,
  });

  // Load task ID from URL parameter or fetch the latest task on initial render
  useEffect(() => {
    const loadSession = async () => {
      setIsLoadingSession(true);
      try {
        if (initialTaskId) {
          // If we have an initial task ID (from URL), fetch that specific task
          console.log(`Fetching specific task: ${initialTaskId}`);
          const task = await fetchTaskById(initialTaskId);
          const messages = await fetchTaskMessages(initialTaskId);

          if (task) {
            console.log(`Found task: ${task.id}`);
            setCurrentTaskId(task.id);
            setTaskStatus(task.status); // Set the task status when loading
            setTakeOverState(task.takeOverState);

            // If the task has messages, add them to the messages state
            if (messages && messages.length > 0) {
              // Process all messages
              const formattedMessages = messages.map((msg: Message) => ({
                id: msg.id,
                content: msg.content,
                role: msg.role,
                createdAt: msg.createdAt,
              }));

              // Add message IDs to processed set
              formattedMessages.forEach((msg: Message) => {
                processedMessageIds.current.add(msg.id);
              });

              setMessages(formattedMessages);
            }
          } else {
            console.log(`Task with ID ${initialTaskId} not found`);
          }
        }
      } catch (error) {
        console.error("Error loading session:", error);
      } finally {
        setIsLoadingSession(false);
      }
    };

    loadSession();
  }, [initialTaskId]);

  // Join/leave WebSocket task rooms when task ID changes
  useEffect(() => {
    if (currentTaskId) {
      console.log(`Joining WebSocket room for task: ${currentTaskId}`);
      joinTask(currentTaskId);
    } else {
      console.log('Leaving WebSocket task room');
      leaveTask();
    }
  }, [currentTaskId, joinTask, leaveTask]);

  const handleStartTask = async () => {
    if (!input.trim()) return;

    setIsLoading(true);

    try {
      const description = input;
      setInput("");

      startNewConversation();

      // Send request to start a new task or continue existing task
      const task = await startTask(description);

      if (task) {
        // Store the task ID for polling
        setCurrentTaskId(task.id);
      } else {
        // Add error message to chat
        const errorMessage: Message = {
          id: Date.now().toString(),
          content: [
            {
              type: MessageContentType.Text,
              text: "Sorry, there was an error processing your request. Please try again.",
            },
          ],
          role: Role.ASSISTANT,
        };

        processedMessageIds.current.add(errorMessage.id);
        setMessages((prev) => [...prev, errorMessage]);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleGuideTask = async () => {
    if (!input.trim()) return;

    setIsLoading(true);

    try {
      const message = input;
      setInput("");

      // Send request to start a new task or continue existing task
      const response = await guideTask(currentTaskId!, message);

      if (!response) {
        // Add error message to chat
        const errorMessage: Message = {
          id: Date.now().toString(),
          content: [
            {
              type: MessageContentType.Text,
              text: "Sorry, there was an error processing your request. Please try again.",
            },
          ],
          role: Role.ASSISTANT,
        };

        processedMessageIds.current.add(errorMessage.id);
        setMessages((prev) => [...prev, errorMessage]);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // Start a new conversation (clears current task)
  const startNewConversation = () => {
    // Clear the current task ID
    setCurrentTaskId(null);

    // Clear messages
    setMessages([]);

    // Clear processed message IDs
    processedMessageIds.current = new Set();

    console.log("Started new conversation");
  };

  const handleTakeOver = async () => {
    if (!currentTaskId) return;

    try {
      const updatedTask = await takeOverTask(currentTaskId);
      if (updatedTask) {
        setTakeOverState(updatedTask.takeOverState);
      }
    } catch (error) {
      console.error("Error taking over task:", error);
    }
  };

  const handleResumeControl = async () => {
    if (!currentTaskId) return;

    try {
      const updatedTask = await resumeTaskControl(currentTaskId);
      if (updatedTask) {
        setTakeOverState(updatedTask.takeOverState);
      }
    } catch (error) {
      console.error("Error resuming control:", error);
    }
  };

  return {
    messages,
    taskStatus,
    takeOverState,
    input,
    setInput,
    currentTaskId,
    isLoading,
    isLoadingSession,
    handleGuideTask,
    handleStartTask,
    handleTakeOver,
    handleResumeControl,
    startNewConversation,
  };
}
