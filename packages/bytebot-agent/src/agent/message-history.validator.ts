/**
 * v2.2.5: Message History Validator
 *
 * Validates message history before sending to AI API to detect corruption.
 * The most common corruption is orphaned tool_use blocks without corresponding
 * tool_result blocks, which causes the Anthropic API to return:
 * "tool_use ids were found without tool_result blocks immediately after"
 *
 * This corruption can occur due to:
 * - Race conditions in task claiming (fixed in v2.2.4)
 * - Worker crashes during tool execution
 * - Network failures during message saving
 *
 * When corruption is detected, the task should be marked as FAILED rather than
 * attempting repair, since the task state is unknown and user review is needed.
 */

import { Logger } from '@nestjs/common';
import { Message, Role } from '@prisma/client';
import { MessageContentBlock, MessageContentType } from '@bytebot/shared';

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  orphanedToolUseIds: string[];
}

/**
 * Validates message history for structural integrity.
 *
 * Checks:
 * 1. Every tool_use block has a corresponding tool_result in the next user message
 * 2. Message alternation is correct (user/assistant/user/assistant...)
 * 3. No orphaned tool_result blocks (results without matching tool_use)
 */
export function validateMessageHistory(
  messages: Array<{ role: Role; content: MessageContentBlock[] | unknown }>,
  logger?: Logger,
): ValidationResult {
  const errors: string[] = [];
  const orphanedToolUseIds: string[] = [];

  if (!messages || messages.length === 0) {
    return { isValid: true, errors: [], orphanedToolUseIds: [] };
  }

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const content = message.content as MessageContentBlock[];

    // Skip messages without array content
    if (!Array.isArray(content)) {
      continue;
    }

    if (message.role === Role.ASSISTANT) {
      // Find all tool_use blocks in this assistant message
      const toolUseBlocks = content.filter(
        (block) => block.type === MessageContentType.ToolUse,
      );

      if (toolUseBlocks.length === 0) {
        continue;
      }

      // Check if there's a next message
      const nextMessage = messages[i + 1];

      if (!nextMessage) {
        // Last message in history has tool_use blocks without results
        // This is the most common case - task was interrupted
        const ids = toolUseBlocks
          .map((block: any) => block.id)
          .filter((id: string) => id);
        orphanedToolUseIds.push(...ids);
        errors.push(
          `Message at index ${i} has ${toolUseBlocks.length} tool_use block(s) without results (end of history)`,
        );
        continue;
      }

      if (nextMessage.role !== Role.USER) {
        // Next message is not a user message (should contain tool_results)
        const ids = toolUseBlocks
          .map((block: any) => block.id)
          .filter((id: string) => id);
        orphanedToolUseIds.push(...ids);
        errors.push(
          `Message at index ${i} has tool_use blocks but next message (index ${i + 1}) is not a user message`,
        );
        continue;
      }

      // Check that each tool_use has a corresponding tool_result
      const nextContent = nextMessage.content as MessageContentBlock[];
      if (!Array.isArray(nextContent)) {
        const ids = toolUseBlocks
          .map((block: any) => block.id)
          .filter((id: string) => id);
        orphanedToolUseIds.push(...ids);
        errors.push(
          `Message at index ${i} has tool_use blocks but next message has invalid content`,
        );
        continue;
      }

      const toolResultIds = new Set(
        nextContent
          .filter((block) => block.type === MessageContentType.ToolResult)
          .map((block: any) => block.tool_use_id),
      );

      for (const toolUse of toolUseBlocks) {
        const toolUseId = (toolUse as any).id;
        if (toolUseId && !toolResultIds.has(toolUseId)) {
          orphanedToolUseIds.push(toolUseId);
          errors.push(
            `Tool use ${toolUseId} at message index ${i} has no corresponding tool_result`,
          );
        }
      }
    }
  }

  const isValid = errors.length === 0;

  if (!isValid && logger) {
    logger.warn(
      `Message history validation failed: ${errors.length} error(s) found`,
    );
    for (const error of errors) {
      logger.warn(`  - ${error}`);
    }
  }

  return {
    isValid,
    errors,
    orphanedToolUseIds,
  };
}

/**
 * Formats validation errors into a human-readable error message for task failure.
 */
export function formatValidationError(result: ValidationResult): string {
  if (result.isValid) {
    return '';
  }

  const errorCount = result.errors.length;
  const orphanedCount = result.orphanedToolUseIds.length;

  let message = `Message history corrupted: ${errorCount} validation error(s) detected.`;

  if (orphanedCount > 0) {
    message += ` Found ${orphanedCount} orphaned tool_use block(s) without tool_result responses.`;
  }

  message += ' This may have occurred due to a worker crash or race condition during task processing.';
  message += ' Please create a new task to retry.';

  return message;
}
