import { TasksService } from '../tasks/tasks.service';
import { MessagesService } from '../messages/messages.service';
import { Injectable, Logger } from '@nestjs/common';
import { Role, TaskPriority, TaskStatus, TaskType } from '@prisma/client';
import { AnthropicService } from '../anthropic/anthropic.service';
import {
  isScrollToolUseBlock,
  isWaitToolUseBlock,
  isScreenshotToolUseBlock,
  isCursorPositionToolUseBlock,
  isComputerToolUseContentBlock,
  isMoveMouseToolUseBlock,
  isTraceMouseToolUseBlock,
  isClickMouseToolUseBlock,
  isPressMouseToolUseBlock,
  isDragMouseToolUseBlock,
  isTypeKeysToolUseBlock,
  isTypeTextToolUseBlock,
  isPressKeysToolUseBlock,
  isSetTaskStatusToolUseBlock,
  isCreateTaskToolUseBlock,
} from '@bytebot/shared';
import {
  Button,
  ComputerToolUseContentBlock,
  Coordinates,
  MessageContentBlock,
  MessageContentType,
  Press,
  ToolResultContentBlock,
} from '@bytebot/shared';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AgentProcessor {
  private readonly logger = new Logger(AgentProcessor.name);
  private currentTaskId: string | null = null;
  private isProcessing = false;

  constructor(
    private readonly tasksService: TasksService,
    private readonly messagesService: MessagesService,
    private readonly anthropicService: AnthropicService,
    private readonly configService: ConfigService,
  ) {
    this.logger.log('AgentProcessor initialized');
  }

  /**
   * Check if the processor is currently processing a task
   */
  isRunning(): boolean {
    return this.isProcessing;
  }

  /**
   * Get the current task ID being processed
   */
  getCurrentTaskId(): string | null {
    return this.currentTaskId;
  }

  async processTask(taskId: string) {
    this.logger.log(`Processing job for task ID: ${taskId}`);

    try {
      let task = await this.tasksService.findById(taskId);
      this.currentTaskId = taskId;
      this.isProcessing = true;

      while (task.status == TaskStatus.RUNNING) {
        if (task.control != Role.ASSISTANT) {
          // wait 2 seconds and loop
          this.logger.log(
            `Task ${taskId} is not under agent control, waiting 2 seconds before looping`,
          );
          await new Promise((resolve) => setTimeout(resolve, 2000));
          task = await this.tasksService.findById(taskId);
          continue;
        }

        this.logger.log(
          `Processing task loop iteration for task ID: ${taskId}`,
        );
        const messages = await this.messagesService.findAll(taskId);
        this.logger.debug(
          `Sending ${messages.length} messages to LLM for processing`,
        );

        try {
          const messageContentBlocks: MessageContentBlock[] =
            await this.anthropicService.sendMessage(messages, task.model);
          this.logger.debug(
            `Received ${messageContentBlocks.length} content blocks from LLM using model ${task.model}`,
          );

          if (messageContentBlocks.length == 0) {
            this.logger.log(
              `Task ID: ${taskId} received no content blocks from LLM, setting task status to failed`,
            );
            await this.tasksService.update(taskId, {
              status: TaskStatus.FAILED,
            });
            break;
          }

          await this.messagesService.create({
            content: messageContentBlocks,
            role: Role.ASSISTANT,
            taskId: taskId,
          });
          this.logger.debug(
            `Saved assistant response to database for task ID: ${taskId}`,
          );

          const generatedToolResults: ToolResultContentBlock[] = [];

          for (const block of messageContentBlocks) {
            if (isComputerToolUseContentBlock(block)) {
              this.logger.log(
                `Processing tool use block: ${block.input.action} (ID: ${block.id})`,
              );

              const toolResult = await this.handleComputerToolUse(block);
              this.logger.debug(
                `Tool execution completed for tool_use_id: ${block.id}, saving result`,
              );
              generatedToolResults.push(toolResult);
            }

            if (isCreateTaskToolUseBlock(block)) {
              this.logger.log(
                `Processing create task tool use block: ${block.input.name}`,
              );

              // if the block input type exists, convert it to uppercase and use it as the type
              const type = block.input.type?.toUpperCase() as TaskType;
              const priority =
                block.input.priority?.toUpperCase() as TaskPriority;

              await this.tasksService.create({
                description: block.input.description,
                type,
                createdBy: Role.ASSISTANT,
                ...(block.input.scheduledFor && {
                  scheduledFor: new Date(block.input.scheduledFor),
                }),
                priority,
              });

              generatedToolResults.push({
                type: MessageContentType.ToolResult,
                tool_use_id: block.id,
                content: [
                  {
                    type: MessageContentType.Text,
                    text: 'The task has been created',
                  },
                ],
              });
            }

            if (isSetTaskStatusToolUseBlock(block)) {
              this.logger.log(
                `Processing set task status tool use block: ${block.input.status}`,
              );
              switch (block.input.status) {
                case 'completed': {
                  await this.tasksService.update(taskId, {
                    status: TaskStatus.COMPLETED,
                    completedAt: new Date(),
                  });
                  break;
                }
                case 'failed': {
                  await this.tasksService.update(taskId, {
                    status: TaskStatus.FAILED,
                  });
                  break;
                }
                case 'needs_help': {
                  generatedToolResults.push({
                    type: MessageContentType.ToolResult,
                    tool_use_id: block.id,
                    content: [
                      {
                        type: MessageContentType.Text,
                        text: 'The task has been set to needs help',
                      },
                    ],
                  });
                  await this.tasksService.update(taskId, {
                    status: TaskStatus.NEEDS_HELP,
                  });
                  break;
                }
              }
              this.logger.log(
                `Task ID: ${taskId} has been ${block.input.status}`,
              );

              break;
            }
          }

          if (generatedToolResults.length > 0) {
            await this.messagesService.create({
              content: generatedToolResults,
              role: Role.USER,
              taskId: taskId,
            });
            this.logger.debug(
              `Saved ${generatedToolResults.length} tool result(s) to database for task ID: ${taskId}`,
            );
          }

          this.logger.debug(`Refreshing task data for task ID: ${taskId}`);
          task = await this.tasksService.findById(taskId);
          this.logger.debug(
            `Task refreshed, status: ${task.status}, messages count: ${task.messages.length}`,
          );
        } catch (error) {
          this.logger.error(
            `Error during task processing loop for task ID: ${taskId} - ${error.message}`,
            error.stack,
          );

          await this.tasksService.update(taskId, {
            status: TaskStatus.FAILED,
          });
          break;
        }
      }

      this.logger.log(
        `Task processing completed for task ID: ${taskId} with status: ${task.status}`,
      );
    } catch (error) {
      this.logger.error(
        `Critical error processing job for task ID: ${taskId} - ${error.message}`,
        error.stack,
      );
    } finally {
      this.isProcessing = false;
      this.currentTaskId = null;
    }
  }

  async stopProcessing(): Promise<void> {
    if (!this.isProcessing) {
      return;
    }

    this.logger.log(`Stopping execution of task ${this.currentTaskId}`);

    if (this.currentTaskId) {
      await this.tasksService.update(this.currentTaskId, {
        status: TaskStatus.CANCELLED,
      });
    }

    this.isProcessing = false;
    this.currentTaskId = null;
  }

  private async handleComputerToolUse(
    block: ComputerToolUseContentBlock,
  ): Promise<ToolResultContentBlock> {
    this.logger.debug(
      `Handling computer tool use: ${block.name}, tool_use_id: ${block.id}`,
    );

    if (isScreenshotToolUseBlock(block)) {
      this.logger.debug('Processing screenshot request');
      try {
        this.logger.debug('Taking screenshot');
        const image = await this.screenshot();
        this.logger.debug('Screenshot captured successfully');

        return {
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          content: [
            {
              type: MessageContentType.Image,
              source: {
                data: image,
                media_type: 'image/png',
                type: 'base64',
              },
            },
          ],
        };
      } catch (error) {
        this.logger.error(`Screenshot failed: ${error.message}`, error.stack);
        return {
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          content: [
            {
              type: MessageContentType.Text,
              text: 'ERROR: Failed to take screenshot',
            },
          ],
          is_error: true,
        };
      }
    }

    if (isCursorPositionToolUseBlock(block)) {
      this.logger.debug('Processing cursor position request');
      try {
        this.logger.debug('Getting cursor position');
        const position = await this.cursorPosition();
        this.logger.debug(
          `Cursor position obtained: ${position.x}, ${position.y}`,
        );

        return {
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          content: [
            {
              type: MessageContentType.Text,
              text: `Cursor position: ${position.x}, ${position.y}`,
            },
          ],
        };
      } catch (error) {
        this.logger.error(
          `Getting cursor position failed: ${error.message}`,
          error.stack,
        );
        return {
          type: MessageContentType.ToolResult,
          tool_use_id: block.id,
          content: [
            {
              type: MessageContentType.Text,
              text: 'ERROR: Failed to get cursor position',
            },
          ],
          is_error: true,
        };
      }
    }

    try {
      if (isMoveMouseToolUseBlock(block)) {
        await this.moveMouse(block.input);
      }
      if (isTraceMouseToolUseBlock(block)) {
        await this.traceMouse(block.input);
      }
      if (isClickMouseToolUseBlock(block)) {
        await this.clickMouse(block.input);
      }
      if (isPressMouseToolUseBlock(block)) {
        await this.pressMouse(block.input);
      }
      if (isDragMouseToolUseBlock(block)) {
        await this.dragMouse(block.input);
      }
      if (isScrollToolUseBlock(block)) {
        await this.scroll(block.input);
      }
      if (isTypeKeysToolUseBlock(block)) {
        await this.typeKeys(block.input);
      }
      if (isPressKeysToolUseBlock(block)) {
        await this.pressKeys(block.input);
      }
      if (isTypeTextToolUseBlock(block)) {
        await this.typeText(block.input);
      }
      if (isWaitToolUseBlock(block)) {
        await this.wait(block.input);
      }
      this.logger.debug(
        `Tool execution successful for tool_use_id: ${block.id}`,
      );
      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Text,
            text: 'Tool executed successfully',
          },
        ],
      };
    } catch (error) {
      this.logger.error(
        `Error executing ${block.input.action} tool: ${error.message}`,
        error.stack,
      );
      return {
        type: MessageContentType.ToolResult,
        tool_use_id: block.id,
        content: [
          {
            type: MessageContentType.Text,
            text: `Error executing ${block.input.action} tool: ${error.message}`,
          },
        ],
        is_error: true,
      };
    }
  }

  private async moveMouse(input: { coordinates: Coordinates }): Promise<void> {
    const { coordinates } = input;
    console.log(
      `Moving mouse to coordinates: [${coordinates.x}, ${coordinates.y}]`,
    );

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'move_mouse',
            coordinates,
          }),
        },
      );
    } catch (error) {
      console.error('Error in move_mouse action:', error);
      throw error;
    }
  }

  private async traceMouse(input: {
    path: Coordinates[];
    holdKeys?: string[];
  }): Promise<void> {
    const { path, holdKeys } = input;
    console.log(
      `Tracing mouse to path: ${path} ${holdKeys ? `with holdKeys: ${holdKeys}` : ''}`,
    );

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'trace_mouse',
            path,
            holdKeys,
          }),
        },
      );
    } catch (error) {
      console.error('Error in trace_mouse action:', error);
      throw error;
    }
  }

  private async clickMouse(input: {
    coordinates?: Coordinates;
    button: Button;
    holdKeys?: string[];
    numClicks?: number;
  }): Promise<void> {
    const { coordinates, button, holdKeys, numClicks } = input;
    console.log(
      `Clicking mouse ${button} ${numClicks} times ${coordinates ? `at coordinates: [${coordinates.x}, ${coordinates.y}] ` : ''} ${holdKeys ? `with holdKeys: ${holdKeys}` : ''}`,
    );

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'click_mouse',
            coordinates,
            button,
            holdKeys,
            numClicks,
          }),
        },
      );
    } catch (error) {
      console.error('Error in click_mouse action:', error);
      throw error;
    }
  }

  private async pressMouse(input: {
    coordinates?: Coordinates;
    button: Button;
    press: Press;
  }): Promise<void> {
    const { coordinates, button, press } = input;
    console.log(
      `Pressing mouse ${button} ${press} ${coordinates ? `at coordinates: [${coordinates.x}, ${coordinates.y}]` : ''}`,
    );

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'press_mouse',
            coordinates,
            button,
            press,
          }),
        },
      );
    } catch (error) {
      console.error('Error in press_mouse action:', error);
      throw error;
    }
  }

  private async dragMouse(input: {
    path: Coordinates[];
    button: Button;
    holdKeys?: string[];
  }): Promise<void> {
    const { path, button, holdKeys } = input;
    console.log(
      `Dragging mouse to path: ${path} ${holdKeys ? `with holdKeys: ${holdKeys}` : ''}`,
    );

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'drag_mouse',
            path,
            button,
            holdKeys,
          }),
        },
      );
    } catch (error) {
      console.error('Error in drag_mouse action:', error);
      throw error;
    }
  }

  private async scroll(input: {
    coordinates?: Coordinates;
    direction: 'up' | 'down' | 'left' | 'right';
    numScrolls: number;
    holdKeys?: string[];
  }): Promise<void> {
    const { coordinates, direction, numScrolls, holdKeys } = input;
    console.log(
      `Scrolling ${direction} ${numScrolls} times ${coordinates ? `at coordinates: [${coordinates.x}, ${coordinates.y}]` : ''}`,
    );

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'scroll',
            coordinates,
            direction,
            numScrolls,
            holdKeys,
          }),
        },
      );
    } catch (error) {
      console.error('Error in scroll action:', error);
      throw error;
    }
  }

  private async typeKeys(input: {
    keys: string[];
    delay?: number;
  }): Promise<void> {
    const { keys, delay } = input;
    console.log(`Typing keys: ${keys}`);

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'type_keys',
            keys,
            delay,
          }),
        },
      );
    } catch (error) {
      console.error('Error in type_keys action:', error);
      throw error;
    }
  }

  private async pressKeys(input: {
    keys: string[];
    press: Press;
  }): Promise<void> {
    const { keys, press } = input;
    console.log(`Pressing keys: ${keys}`);

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'press_keys',
            keys,
            press,
          }),
        },
      );
    } catch (error) {
      console.error('Error in press_keys action:', error);
      throw error;
    }
  }

  private async typeText(input: {
    text: string;
    delay?: number;
  }): Promise<void> {
    const { text, delay } = input;
    console.log(`Typing text: ${text}`);

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'type_text',
            text,
            delay,
          }),
        },
      );
    } catch (error) {
      console.error('Error in type_text action:', error);
      throw error;
    }
  }

  private async wait(input: { duration: number }): Promise<void> {
    const { duration } = input;
    console.log(`Waiting for ${duration}ms`);

    try {
      await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'wait',
            duration,
          }),
        },
      );
    } catch (error) {
      console.error('Error in wait action:', error);
      throw error;
    }
  }

  private async cursorPosition(): Promise<Coordinates> {
    console.log('Getting cursor position');

    try {
      const response = await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'cursor_position',
          }),
        },
      );

      const data = await response.json();
      return { x: data.x, y: data.y };
    } catch (error) {
      console.error('Error in cursor_position action:', error);
      throw error;
    }
  }

  private async screenshot(): Promise<string> {
    console.log('Taking screenshot');

    try {
      const requestBody = {
        action: 'screenshot',
      };

      const response = await fetch(
        `${this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL')}/computer-use`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to take screenshot: ${response.statusText}`);
      }

      const data = await response.json();

      if (!data.image) {
        throw new Error('Failed to take screenshot: No image data received');
      }

      return data.image; // Base64 encoded image
    } catch (error) {
      console.error('Error in screenshot action:', error);
      throw error;
    }
  }
}
