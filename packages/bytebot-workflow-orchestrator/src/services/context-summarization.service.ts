/**
 * Context Summarization Service
 * v1.0.0: Adaptive Context Management for Long-Running Agents
 *
 * Implements industry-standard context window management patterns:
 * - LangChain: ConversationSummaryBufferMemory pattern
 * - Anthropic: Hierarchical context with recent detailed, older summarized
 * - OpenAI: Token counting and smart truncation
 *
 * Key Features:
 * 1. Token-aware context management (stays within model limits)
 * 2. Hierarchical summarization (recent=detailed, older=summarized)
 * 3. Key fact preservation (never loses critical information)
 * 4. LLM-driven summarization for coherent compression
 *
 * @see /documentation/2026-01-03-ADVANCED_ENHANCEMENTS.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Context window configuration by model
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-3-5-sonnet-20241022': 200000,
  'claude-3-opus-20240229': 200000,
  'claude-3-haiku-20240307': 200000,
  'gpt-4-turbo': 128000,
  'gpt-4o': 128000,
  'gpt-4': 8192,
  'default': 100000,
};

// Rough token estimation (4 chars per token average)
const CHARS_PER_TOKEN = 4;

// Context item types
export interface ContextItem {
  id: string;
  type: 'step_result' | 'observation' | 'action' | 'thought' | 'summary';
  timestamp: Date;
  content: string;
  metadata?: {
    stepNumber?: number;
    importance?: 'critical' | 'high' | 'medium' | 'low';
    keyFacts?: string[];
  };
}

// Summarization result
export interface SummarizationResult {
  originalTokens: number;
  compressedTokens: number;
  compressionRatio: number;
  summaryItems: ContextItem[];
  preservedKeyFacts: string[];
}

// Context window status
export interface ContextWindowStatus {
  currentTokens: number;
  maxTokens: number;
  utilizationPercent: number;
  needsSummarization: boolean;
  itemCount: number;
  oldestItemAge: number; // in minutes
}

@Injectable()
export class ContextSummarizationService {
  private readonly logger = new Logger(ContextSummarizationService.name);
  private readonly enabled: boolean;
  private readonly llmApiKey: string;
  private readonly llmApiUrl: string;
  private readonly llmModel: string;

  // Configuration thresholds
  private readonly summarizationThreshold: number; // % of context before summarizing
  private readonly recentItemsToPreserve: number;  // Items to keep detailed
  private readonly maxSummaryLength: number;       // Max tokens for summary
  private readonly keyFactsLimit: number;          // Max key facts to preserve

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.enabled = this.configService.get('CONTEXT_SUMMARIZATION_ENABLED', 'true') === 'true';
    this.llmApiKey = this.configService.get('ANTHROPIC_API_KEY', '');
    this.llmApiUrl = this.configService.get('LLM_API_URL', 'https://api.anthropic.com/v1/messages');
    this.llmModel = this.configService.get('LLM_MODEL', 'claude-3-5-sonnet-20241022');

    // Thresholds
    this.summarizationThreshold = parseInt(
      this.configService.get('SUMMARIZATION_THRESHOLD_PERCENT', '70'),
      10,
    );
    this.recentItemsToPreserve = parseInt(
      this.configService.get('RECENT_ITEMS_TO_PRESERVE', '5'),
      10,
    );
    this.maxSummaryLength = parseInt(
      this.configService.get('MAX_SUMMARY_TOKENS', '2000'),
      10,
    );
    this.keyFactsLimit = parseInt(
      this.configService.get('KEY_FACTS_LIMIT', '20'),
      10,
    );

    this.logger.log(
      `Context summarization ${this.enabled ? 'enabled' : 'disabled'} ` +
      `(threshold: ${this.summarizationThreshold}%, preserve: ${this.recentItemsToPreserve} items)`,
    );
  }

  /**
   * Check if context needs summarization
   */
  needsSummarization(items: ContextItem[], modelId?: string): boolean {
    if (!this.enabled) return false;

    const status = this.getContextStatus(items, modelId);
    return status.needsSummarization;
  }

  /**
   * Get current context window status
   */
  getContextStatus(items: ContextItem[], modelId?: string): ContextWindowStatus {
    const model = modelId || this.llmModel;
    const maxTokens = MODEL_CONTEXT_LIMITS[model] || MODEL_CONTEXT_LIMITS['default'];
    const currentTokens = this.estimateTokens(items);
    const utilizationPercent = (currentTokens / maxTokens) * 100;

    const oldestItem = items.length > 0
      ? items.reduce((oldest, item) =>
          item.timestamp < oldest.timestamp ? item : oldest
        )
      : null;

    const oldestItemAge = oldestItem
      ? (Date.now() - oldestItem.timestamp.getTime()) / 60000
      : 0;

    return {
      currentTokens,
      maxTokens,
      utilizationPercent,
      needsSummarization: utilizationPercent >= this.summarizationThreshold,
      itemCount: items.length,
      oldestItemAge,
    };
  }

  /**
   * Summarize context items using hierarchical approach
   *
   * Strategy:
   * 1. Preserve N most recent items in full detail
   * 2. Extract key facts from older items
   * 3. Create LLM-generated summary of older items
   * 4. Return combined context that fits within limits
   */
  async summarizeContext(
    items: ContextItem[],
    goalDescription: string,
    modelId?: string,
  ): Promise<SummarizationResult> {
    const originalTokens = this.estimateTokens(items);

    if (items.length <= this.recentItemsToPreserve) {
      // Nothing to summarize
      return {
        originalTokens,
        compressedTokens: originalTokens,
        compressionRatio: 1,
        summaryItems: items,
        preservedKeyFacts: [],
      };
    }

    this.logger.log(
      `Summarizing context: ${items.length} items, ${originalTokens} tokens`,
    );

    // Split items: recent (preserve) vs older (summarize)
    const sortedItems = [...items].sort(
      (a, b) => b.timestamp.getTime() - a.timestamp.getTime(),
    );
    const recentItems = sortedItems.slice(0, this.recentItemsToPreserve);
    const olderItems = sortedItems.slice(this.recentItemsToPreserve);

    // Extract key facts from all items (especially older ones)
    const allKeyFacts = this.extractKeyFacts(olderItems);

    // Generate LLM summary of older items
    const summary = await this.generateSummary(olderItems, goalDescription);

    // Create summary item
    const summaryItem: ContextItem = {
      id: `summary-${Date.now()}`,
      type: 'summary',
      timestamp: new Date(),
      content: summary,
      metadata: {
        importance: 'high',
        keyFacts: allKeyFacts.slice(0, this.keyFactsLimit),
      },
    };

    // Combine: summary first, then recent items
    const summaryItems = [summaryItem, ...recentItems.reverse()];
    const compressedTokens = this.estimateTokens(summaryItems);

    const result: SummarizationResult = {
      originalTokens,
      compressedTokens,
      compressionRatio: compressedTokens / originalTokens,
      summaryItems,
      preservedKeyFacts: allKeyFacts.slice(0, this.keyFactsLimit),
    };

    // Emit event for monitoring
    this.eventEmitter.emit('context.summarized', {
      originalTokens,
      compressedTokens,
      compressionRatio: result.compressionRatio,
      itemsSummarized: olderItems.length,
      itemsPreserved: recentItems.length,
    });

    this.logger.log(
      `Context summarized: ${originalTokens} -> ${compressedTokens} tokens ` +
      `(${Math.round(result.compressionRatio * 100)}% of original)`,
    );

    return result;
  }

  /**
   * Estimate token count for items
   */
  estimateTokens(items: ContextItem[]): number {
    let totalChars = 0;
    for (const item of items) {
      totalChars += item.content.length;
      if (item.metadata?.keyFacts) {
        totalChars += item.metadata.keyFacts.join(' ').length;
      }
    }
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
  }

  /**
   * Estimate tokens for a string
   */
  estimateStringTokens(text: string): number {
    return Math.ceil(text.length / CHARS_PER_TOKEN);
  }

  /**
   * Extract key facts from context items
   */
  private extractKeyFacts(items: ContextItem[]): string[] {
    const facts: string[] = [];

    for (const item of items) {
      // Get explicit key facts from metadata
      if (item.metadata?.keyFacts) {
        facts.push(...item.metadata.keyFacts);
      }

      // Extract facts from step results
      if (item.type === 'step_result' && item.content) {
        // Look for common patterns that indicate key information
        const patterns = [
          /found:?\s*(.+?)(?:\.|$)/gi,
          /result:?\s*(.+?)(?:\.|$)/gi,
          /confirmed:?\s*(.+?)(?:\.|$)/gi,
          /selected:?\s*(.+?)(?:\.|$)/gi,
          /price:?\s*\$?[\d,]+/gi,
          /\$[\d,]+(?:\.\d{2})?/g,
        ];

        for (const pattern of patterns) {
          const matches = item.content.match(pattern);
          if (matches) {
            facts.push(...matches.slice(0, 3)); // Limit per pattern
          }
        }
      }
    }

    // Deduplicate and limit
    const uniqueFacts = [...new Set(facts)];
    return uniqueFacts.slice(0, this.keyFactsLimit);
  }

  /**
   * Generate LLM summary of older items
   */
  private async generateSummary(
    items: ContextItem[],
    goalDescription: string,
  ): Promise<string> {
    if (!this.llmApiKey || items.length === 0) {
      // Fallback to simple concatenation
      return this.generateFallbackSummary(items);
    }

    const itemsText = items.map(item =>
      `[${item.type.toUpperCase()}] ${item.content}`
    ).join('\n\n');

    const prompt = `You are summarizing the history of an AI agent working on a goal.

GOAL: ${goalDescription}

HISTORY TO SUMMARIZE:
${itemsText}

Create a concise summary that:
1. Captures the key actions taken
2. Preserves important facts, numbers, and decisions
3. Notes any errors or issues encountered
4. Maintains context needed for continuing the task

Keep the summary under ${this.maxSummaryLength * CHARS_PER_TOKEN} characters.
Focus on WHAT was accomplished and WHAT was learned, not HOW.

Summary:`;

    try {
      const response = await fetch(this.llmApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.llmApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307', // Use fast model for summarization
          max_tokens: this.maxSummaryLength,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json();
      return data.content?.[0]?.text || this.generateFallbackSummary(items);
    } catch (error) {
      this.logger.warn(`LLM summarization failed: ${(error as Error).message}`);
      return this.generateFallbackSummary(items);
    }
  }

  /**
   * Generate fallback summary without LLM
   */
  private generateFallbackSummary(items: ContextItem[]): string {
    const stepResults = items.filter(i => i.type === 'step_result');
    const actions = items.filter(i => i.type === 'action');

    const lines: string[] = [
      `[SUMMARY] ${items.length} earlier actions were summarized:`,
    ];

    // Add step results briefly
    if (stepResults.length > 0) {
      lines.push(`- Completed ${stepResults.length} steps`);
      for (const result of stepResults.slice(0, 3)) {
        const brief = result.content.substring(0, 100);
        lines.push(`  * ${brief}${result.content.length > 100 ? '...' : ''}`);
      }
      if (stepResults.length > 3) {
        lines.push(`  * ... and ${stepResults.length - 3} more steps`);
      }
    }

    // Add actions briefly
    if (actions.length > 0) {
      lines.push(`- Performed ${actions.length} actions`);
    }

    return lines.join('\n');
  }

  /**
   * Convert step results to context items
   */
  convertStepsToContextItems(steps: Array<{
    order: number;
    description: string;
    status: string;
    actualOutcome?: string | null;
    completedAt?: Date | null;
  }>): ContextItem[] {
    return steps.map(step => ({
      id: `step-${step.order}`,
      type: 'step_result' as const,
      timestamp: step.completedAt || new Date(),
      content: step.actualOutcome || `Step ${step.order}: ${step.description} [${step.status}]`,
      metadata: {
        stepNumber: step.order,
        importance: step.status === 'COMPLETED' ? 'high' : 'medium',
      },
    }));
  }
}
