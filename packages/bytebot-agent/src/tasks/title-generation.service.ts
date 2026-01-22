import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

/**
 * v2.2.16: Title Generation Service
 * v2.2.17: Fixed model compatibility - switched from gpt-oss-120b to gpt-4o-mini
 *          for better OpenAI SDK compatibility
 *
 * Generates concise, AI-generated titles for tasks using the gpt-4o-mini model.
 * Titles are used in the task list UI to provide a scannable summary instead of
 * displaying the full task description.
 *
 * Best practices followed:
 * - Target length: 50 characters (optimal for scanning)
 * - Maximum length: 72 characters (hard limit)
 * - Style: Imperative mood ("Fix bug", "Add feature")
 * - No period at end
 * - Capitalize first word only
 */

const TITLE_GENERATION_PROMPT = `Generate a concise task title based on the following task description.

Requirements:
- Maximum 50 characters
- Use imperative mood (e.g., "Fix login bug", "Add user authentication")
- No period at the end
- Capitalize only the first word
- Focus on the main action/goal

Respond with ONLY the title, nothing else.

Task description:`;

// v2.2.17: Changed from gpt-oss-120b to gpt-4o-mini for better SDK compatibility
const TITLE_MODEL = 'gpt-4o-mini';
const MAX_TITLE_LENGTH = 72;
const TARGET_TITLE_LENGTH = 50;

@Injectable()
export class TitleGenerationService {
  private readonly openai: OpenAI | null;
  private readonly logger = new Logger(TitleGenerationService.name);
  private readonly enabled: boolean;

  constructor(private readonly configService: ConfigService) {
    const proxyUrl = this.configService.get<string>('BYTEBOT_LLM_PROXY_URL');

    if (!proxyUrl) {
      this.logger.warn(
        'BYTEBOT_LLM_PROXY_URL is not set. Title generation will use fallback.',
      );
      this.enabled = false;
      this.openai = null;
    } else {
      this.enabled = true;
      // Initialize OpenAI client with LiteLLM proxy
      this.openai = new OpenAI({
        apiKey: 'dummy-key-for-proxy',
        baseURL: proxyUrl,
      });
      this.logger.log(`TitleGenerationService initialized with model ${TITLE_MODEL}`);
    }
  }

  /**
   * Generates a title for a task description.
   * Falls back to truncated description if AI generation fails.
   *
   * @param description - The full task description
   * @returns A concise title (max 72 characters)
   */
  async generateTitle(description: string): Promise<string> {
    // If AI generation is disabled, use fallback
    if (!this.enabled) {
      return this.fallbackTitle(description);
    }

    try {
      const title = await this.generateTitleWithAI(description);
      const sanitized = this.sanitizeTitle(title);

      // v2.2.17: If AI returns empty string, use fallback
      if (!sanitized || sanitized.length === 0) {
        this.logger.warn('AI returned empty title, using fallback');
        return this.fallbackTitle(description);
      }

      return sanitized;
    } catch (error: any) {
      this.logger.warn(
        `Failed to generate title with AI: ${error.message}. Using fallback.`,
      );
      return this.fallbackTitle(description);
    }
  }

  /**
   * Generates a title using the AI model
   */
  private async generateTitleWithAI(description: string): Promise<string> {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const startTime = Date.now();

    // Truncate very long descriptions to avoid token limits
    const truncatedDescription =
      description.length > 500 ? description.substring(0, 500) + '...' : description;

    const completion = await this.openai.chat.completions.create({
      model: TITLE_MODEL,
      messages: [
        {
          role: 'user',
          content: `${TITLE_GENERATION_PROMPT}\n\n${truncatedDescription}`,
        },
      ],
      max_tokens: 50,
      temperature: 0.3, // Low temperature for consistent, predictable output
    });

    const title = completion.choices[0]?.message?.content?.trim() || '';
    const duration = Date.now() - startTime;

    this.logger.debug(
      `Generated title in ${duration}ms: "${title}" (${title.length} chars)`,
    );

    return title;
  }

  /**
   * Sanitizes and validates the generated title
   */
  private sanitizeTitle(title: string): string {
    // Remove any leading/trailing whitespace
    let sanitized = title.trim();

    // Remove surrounding quotes if present
    if (
      (sanitized.startsWith('"') && sanitized.endsWith('"')) ||
      (sanitized.startsWith("'") && sanitized.endsWith("'"))
    ) {
      sanitized = sanitized.slice(1, -1);
    }

    // Remove trailing period
    if (sanitized.endsWith('.')) {
      sanitized = sanitized.slice(0, -1);
    }

    // Ensure first letter is capitalized
    if (sanitized.length > 0) {
      sanitized = sanitized.charAt(0).toUpperCase() + sanitized.slice(1);
    }

    // Truncate if too long
    if (sanitized.length > MAX_TITLE_LENGTH) {
      sanitized = sanitized.substring(0, MAX_TITLE_LENGTH - 3).trim() + '...';
    }

    return sanitized;
  }

  /**
   * Fallback title generation when AI is unavailable
   * Extracts the first sentence or truncates intelligently
   */
  private fallbackTitle(description: string): string {
    // Try to get the first sentence
    const firstSentenceMatch = description.match(/^[^.!?]+[.!?]?/);
    let title = firstSentenceMatch
      ? firstSentenceMatch[0].trim()
      : description.trim();

    // Remove trailing punctuation
    title = title.replace(/[.!?]+$/, '');

    // Truncate if still too long
    if (title.length > TARGET_TITLE_LENGTH) {
      // Try to truncate at a word boundary
      const truncated = title.substring(0, TARGET_TITLE_LENGTH);
      const lastSpace = truncated.lastIndexOf(' ');
      if (lastSpace > TARGET_TITLE_LENGTH - 15) {
        title = truncated.substring(0, lastSpace) + '...';
      } else {
        title = truncated.trim() + '...';
      }
    }

    // Ensure first letter is capitalized
    if (title.length > 0) {
      title = title.charAt(0).toUpperCase() + title.slice(1);
    }

    return title;
  }
}
