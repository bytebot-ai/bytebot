import { MessageContentBlock } from "@bytebot/shared";

export enum Role {
  USER = "USER",
  ASSISTANT = "ASSISTANT",
}

// Message interface
export interface Message {
  id: string;
  content: MessageContentBlock[];
  role: Role;
  taskId?: string;
  createdAt?: string;
}

// Task related enums and types
export enum TaskStatus {
  PENDING = "PENDING",
  RUNNING = "RUNNING",
  NEEDS_HELP = "NEEDS_HELP",
  NEEDS_REVIEW = "NEEDS_REVIEW",
  COMPLETED = "COMPLETED",
  CANCELLED = "CANCELLED",
  FAILED = "FAILED",
}

export enum TaskPriority {
  LOW = "LOW",
  MEDIUM = "MEDIUM",
  HIGH = "HIGH",
  URGENT = "URGENT",
}

export enum TakeOverState {
  AGENT_CONTROL = "AGENT_CONTROL",
  USER_TAKEOVER = "USER_TAKEOVER", 
  USER_CONTROL = "USER_CONTROL",
}

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  takeOverState: TakeOverState;
  createdAt: string;
  updatedAt: string;
}
