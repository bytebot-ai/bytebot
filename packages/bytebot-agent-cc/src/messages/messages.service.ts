import {
  Injectable,
  NotFoundException,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Message, Role, Prisma } from '@prisma/client';
import {
  MessageContentBlock,
  isComputerToolUseContentBlock,
  isToolResultContentBlock,
  isUserActionContentBlock,
} from '@bytebot/shared';
import { TasksGateway } from '../tasks/tasks.gateway';

// Extended message type for processing
export interface ProcessedMessage extends Message {
  take_over?: boolean;
}

export interface GroupedMessages {
  role: Role;
  messages: ProcessedMessage[];
  take_over?: boolean;
}

@Injectable()
export class MessagesService {
  constructor(
    private prisma: PrismaService,
    @Inject(forwardRef(() => TasksGateway))
    private readonly tasksGateway: TasksGateway,
  ) {}

  async create(data: {
    content: MessageContentBlock[];
    role: Role;
    taskId: string;
  }): Promise<Message> {
    const message = await this.prisma.message.create({
      data: {
        content: data.content as Prisma.InputJsonValue,
        role: data.role,
        taskId: data.taskId,
      },
    });

    this.tasksGateway.emitNewMessage(data.taskId, message);

    return message;
  }

  async findEvery(taskId: string): Promise<Message[]> {
    return this.prisma.message.findMany({
      where: {
        taskId,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
  }

  async findAll(
    taskId: string,
    options?: {
      limit?: number;
      page?: number;
    },
  ): Promise<Message[]> {
    const { limit = 10, page = 1 } = options || {};

    // Calculate offset based on page and limit
    const offset = (page - 1) * limit;

    return this.prisma.message.findMany({
      where: {
        taskId,
      },
      orderBy: {
        createdAt: 'asc',
      },
      take: limit,
      skip: offset,
    });
  }

  async findUnsummarized(taskId: string): Promise<Message[]> {
    return this.prisma.message.findMany({
      where: {
        taskId,
        // find messages that don't have a summaryId
        summaryId: null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  async attachSummary(
    taskId: string,
    summaryId: string,
    messageIds: string[],
  ): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    await this.prisma.message.updateMany({
      where: { taskId, id: { in: messageIds } },
      data: { summaryId },
    });
  }

  /**
   * Groups back-to-back messages from the same role and take_over status
   */
  private groupBackToBackMessages(
    messages: ProcessedMessage[],
  ): GroupedMessages[] {
    const groupedConversation: GroupedMessages[] = [];
    let currentGroup: GroupedMessages | null = null;

    for (const message of messages) {
      const role = message.role;
      const isTakeOver = message.take_over || false;

      // If this is the first message, role is different, or take_over status is different from the previous group
      if (
        !currentGroup ||
        currentGroup.role !== role ||
        currentGroup.take_over !== isTakeOver
      ) {
        // Save the previous group if it exists
        if (currentGroup) {
          groupedConversation.push(currentGroup);
        }

        // Start a new group
        currentGroup = {
          role: role,
          messages: [message],
          take_over: isTakeOver,
        };
      } else {
        // Same role and take_over status as previous, merge the content
        currentGroup.messages.push(message);
      }
    }

    // Add the last group
    if (currentGroup) {
      groupedConversation.push(currentGroup);
    }

    return groupedConversation;
  }

  /**
   * Filters and processes messages, adding take_over flags where appropriate
   * Only text messages from the user should appear as user messages
   * Computer tool use messages should be shown as assistant messages with take_over flag
   */
  private filterMessages(messages: Message[]): ProcessedMessage[] {
    const filteredMessages: ProcessedMessage[] = [];

    for (const message of messages) {
      const processedMessage: ProcessedMessage = { ...message };
      const contentBlocks = message.content as MessageContentBlock[];

      // If the role is a user message and all the content blocks are tool result blocks or they are take over actions
      if (message.role === Role.USER) {
        if (contentBlocks.every((block) => isToolResultContentBlock(block))) {
          // Pure tool results should be shown as assistant messages
          processedMessage.role = Role.ASSISTANT;
        } else if (
          contentBlocks.every((block) => isUserActionContentBlock(block))
        ) {
          // Extract computer tool use (take over actions) from the user action content blocks and show them as assistant messages with take_over flag
          processedMessage.content = contentBlocks
            .flatMap((block) => {
              return block.content;
            })
            .filter((block) => isComputerToolUseContentBlock(block));
          processedMessage.role = Role.ASSISTANT;
          processedMessage.take_over = true;
        }
        // If there are text blocks mixed with tool blocks, keep as user message
        // Only pure text messages from user should remain as user messages
      }

      filteredMessages.push(processedMessage);
    }

    return filteredMessages;
  }

  /**
   * Returns raw messages without any processing
   */
  async findRawMessages(
    taskId: string,
    options?: {
      limit?: number;
      page?: number;
    },
  ): Promise<Message[]> {
    return this.findAll(taskId, options);
  }

  /**
   * Returns processed and grouped messages for the chat UI
   */
  async findProcessedMessages(
    taskId: string,
    options?: {
      limit?: number;
      page?: number;
    },
  ): Promise<GroupedMessages[]> {
    const messages = await this.findAll(taskId, options);
    const filteredMessages = this.filterMessages(messages);
    return this.groupBackToBackMessages(filteredMessages);
  }
}
