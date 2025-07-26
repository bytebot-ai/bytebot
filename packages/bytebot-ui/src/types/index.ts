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
  take_over?: boolean;
}

// Grouped messages interface for processed endpoint
export interface GroupedMessages {
  role: Role;
  messages: Message[];
  take_over?: boolean;
}

export interface Model {
  provider: string;
  name: string;
  title: string;
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

export enum TaskType {
  IMMEDIATE = "IMMEDIATE",
  SCHEDULED = "SCHEDULED",
}

export interface User {
  id: string;
  name?: string;
  email: string;
}

export interface FileWithBase64 {
  name: string;
  base64: string;
  type: string;
  size: number;
}

export interface File {
  id: string;
  name: string;
  type: string;
  size: number;
  data: string;
  createdAt: string;
  updatedAt: string;
  taskId: string;
}

export interface Task {
  id: string;
  description: string;
  type: TaskType;
  status: TaskStatus;
  priority: TaskPriority;
  control: Role;
  createdBy: Role;
  createdAt: string;
  updatedAt: string;
  scheduledFor?: string;
  executedAt?: string;
  completedAt?: string;
  queuedAt?: string;
  error?: string;
  result?: unknown;
  model: Model;
  userId?: string;
  user?: User;
  files?: File[];
}
