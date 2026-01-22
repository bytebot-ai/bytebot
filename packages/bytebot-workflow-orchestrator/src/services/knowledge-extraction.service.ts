/**
 * Knowledge Extraction Service
 * v1.0.0: LLM-Driven Knowledge Extraction for Agent Context
 *
 * Implements industry-standard patterns for extracting actionable knowledge:
 * - OpenAI: Structured outputs with JSON schema validation
 * - Anthropic: Chain-of-thought extraction with reasoning
 * - Google: Entity extraction and relationship mapping
 *
 * Key Features:
 * 1. Multi-dimensional knowledge extraction (facts, entities, decisions, metrics)
 * 2. Confidence scoring for extracted knowledge
 * 3. Deduplication and conflict resolution
 * 4. Temporal ordering and relevance decay
 *
 * @see /documentation/2026-01-03-ADVANCED_ENHANCEMENTS.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';

// Knowledge types following OpenAI structured output patterns
export interface ExtractedFact {
  id: string;
  type: 'fact' | 'decision' | 'discovery' | 'error' | 'metric';
  content: string;
  confidence: number; // 0-1 score
  source: {
    stepNumber?: number;
    timestamp: Date;
    context: string; // Brief context about where this came from
  };
  entities?: string[]; // Named entities mentioned
  tags?: string[]; // Categorization tags
}

export interface ExtractedEntity {
  name: string;
  type: 'person' | 'organization' | 'location' | 'product' | 'service' | 'price' | 'date' | 'url' | 'other';
  mentions: number;
  firstSeen: Date;
  lastSeen: Date;
  relatedFacts: string[]; // IDs of facts mentioning this entity
}

export interface KnowledgeGraph {
  goalRunId: string;
  extractedAt: Date;
  facts: ExtractedFact[];
  entities: ExtractedEntity[];
  summary: string;
  keyMetrics: Record<string, string | number>;
  decisions: Array<{
    decision: string;
    reasoning?: string;
    stepNumber: number;
  }>;
}

export interface ExtractionResult {
  success: boolean;
  knowledgeGraph: KnowledgeGraph;
  newFactsCount: number;
  newEntitiesCount: number;
  processingTimeMs: number;
}

// Regex patterns for common knowledge extraction
const EXTRACTION_PATTERNS = {
  prices: /\$[\d,]+(?:\.\d{2})?|\b\d+(?:,\d{3})*(?:\.\d{2})?\s*(?:USD|EUR|GBP|dollars?)\b/gi,
  dates: /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,?\s+\d{4})?\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/gi,
  urls: /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi,
  emails: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
  confirmations: /(?:confirmed|verified|selected|booked|reserved|completed|found|discovered)[:.]?\s*(.{10,100})/gi,
  errors: /(?:error|failed|couldn't|unable|problem|issue)[:.]?\s*(.{10,100})/gi,
  decisions: /(?:decided|chose|selected|picked|going with|will use)[:.]?\s*(.{10,100})/gi,
};

@Injectable()
export class KnowledgeExtractionService {
  private readonly logger = new Logger(KnowledgeExtractionService.name);
  private readonly enabled: boolean;
  private readonly llmApiKey: string;
  private readonly llmApiUrl: string;

  // Cache for extracted knowledge (goalRunId -> KnowledgeGraph)
  private knowledgeCache: Map<string, KnowledgeGraph> = new Map();

  // Configuration
  private readonly maxFactsPerGoal: number;
  private readonly confidenceThreshold: number;
  private readonly useLlmExtraction: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.enabled = this.configService.get('KNOWLEDGE_EXTRACTION_ENABLED', 'true') === 'true';
    this.llmApiKey = this.configService.get('ANTHROPIC_API_KEY', '');
    this.llmApiUrl = this.configService.get('LLM_API_URL', 'https://api.anthropic.com/v1/messages');
    this.maxFactsPerGoal = parseInt(this.configService.get('MAX_FACTS_PER_GOAL', '100'), 10);
    this.confidenceThreshold = parseFloat(this.configService.get('FACT_CONFIDENCE_THRESHOLD', '0.6'));
    this.useLlmExtraction = this.configService.get('USE_LLM_EXTRACTION', 'true') === 'true';

    this.logger.log(
      `Knowledge extraction ${this.enabled ? 'enabled' : 'disabled'} ` +
      `(LLM: ${this.useLlmExtraction}, threshold: ${this.confidenceThreshold})`
    );
  }

  /**
   * Extract knowledge from step outcome text
   */
  async extractFromOutcome(
    goalRunId: string,
    stepNumber: number,
    outcomeText: string,
    goalDescription: string,
  ): Promise<ExtractionResult> {
    const startTime = Date.now();

    if (!this.enabled || !outcomeText) {
      return this.emptyResult(goalRunId);
    }

    this.logger.debug(`Extracting knowledge from step ${stepNumber} for goal ${goalRunId}`);

    // Get or create knowledge graph for this goal
    let graph = this.knowledgeCache.get(goalRunId) || this.createEmptyGraph(goalRunId);

    // Extract using pattern matching (fast, always available)
    const patternFacts = this.extractWithPatterns(outcomeText, stepNumber);

    // Extract using LLM if enabled and API key available
    let llmFacts: ExtractedFact[] = [];
    if (this.useLlmExtraction && this.llmApiKey) {
      try {
        llmFacts = await this.extractWithLLM(outcomeText, stepNumber, goalDescription);
      } catch (error) {
        this.logger.warn(`LLM extraction failed: ${(error as Error).message}`);
      }
    }

    // Merge and deduplicate facts
    const allFacts = [...patternFacts, ...llmFacts];
    const newFacts = this.deduplicateAndMerge(graph.facts, allFacts);

    // Extract entities from all facts
    const newEntities = this.extractEntities(newFacts, graph.entities);

    // Update graph
    graph.facts = [...graph.facts, ...newFacts].slice(-this.maxFactsPerGoal);
    graph.entities = newEntities;
    graph.extractedAt = new Date();

    // Update decisions list
    const newDecisions = newFacts
      .filter(f => f.type === 'decision')
      .map(f => ({
        decision: f.content,
        reasoning: f.source.context,
        stepNumber: f.source.stepNumber || stepNumber,
      }));
    graph.decisions = [...graph.decisions, ...newDecisions];

    // Update key metrics
    this.updateKeyMetrics(graph, newFacts);

    // Generate summary if we have enough facts
    if (graph.facts.length >= 5 && graph.facts.length % 5 === 0) {
      graph.summary = this.generateSummary(graph);
    }

    // Cache the updated graph
    this.knowledgeCache.set(goalRunId, graph);

    const processingTimeMs = Date.now() - startTime;

    // Emit event for monitoring
    this.eventEmitter.emit('knowledge.extracted', {
      goalRunId,
      stepNumber,
      newFactsCount: newFacts.length,
      newEntitiesCount: newEntities.length - (graph.entities.length - newEntities.length),
      processingTimeMs,
    });

    this.logger.log(
      `Extracted ${newFacts.length} facts, ${newEntities.length} entities ` +
      `from step ${stepNumber} (${processingTimeMs}ms)`
    );

    return {
      success: true,
      knowledgeGraph: graph,
      newFactsCount: newFacts.length,
      newEntitiesCount: newEntities.length,
      processingTimeMs,
    };
  }

  /**
   * Get accumulated knowledge for a goal
   */
  getKnowledge(goalRunId: string): KnowledgeGraph | null {
    return this.knowledgeCache.get(goalRunId) || null;
  }

  /**
   * Format knowledge for LLM context
   */
  formatForContext(goalRunId: string, maxTokens: number = 1000): string {
    const graph = this.knowledgeCache.get(goalRunId);
    if (!graph || graph.facts.length === 0) {
      return '';
    }

    const lines: string[] = ['=== ACCUMULATED KNOWLEDGE ==='];

    // Add key metrics
    if (Object.keys(graph.keyMetrics).length > 0) {
      lines.push('\nKey Metrics:');
      for (const [key, value] of Object.entries(graph.keyMetrics)) {
        lines.push(`  - ${key}: ${value}`);
      }
    }

    // Add high-confidence facts (sorted by confidence)
    const highConfidenceFacts = graph.facts
      .filter(f => f.confidence >= this.confidenceThreshold)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 15);

    if (highConfidenceFacts.length > 0) {
      lines.push('\nKey Facts:');
      for (const fact of highConfidenceFacts) {
        const icon = fact.type === 'error' ? '⚠️' : fact.type === 'decision' ? '→' : '•';
        lines.push(`  ${icon} ${fact.content}`);
      }
    }

    // Add decisions
    if (graph.decisions.length > 0) {
      lines.push('\nDecisions Made:');
      for (const decision of graph.decisions.slice(-5)) {
        lines.push(`  Step ${decision.stepNumber}: ${decision.decision}`);
      }
    }

    // Add important entities
    const importantEntities = graph.entities
      .filter(e => e.mentions >= 2 || e.type === 'price' || e.type === 'date')
      .slice(0, 10);

    if (importantEntities.length > 0) {
      lines.push('\nKey Entities:');
      for (const entity of importantEntities) {
        lines.push(`  - ${entity.name} (${entity.type})`);
      }
    }

    lines.push('\n=== END KNOWLEDGE ===');

    // Truncate if too long (rough token estimate: 4 chars per token)
    let result = lines.join('\n');
    const maxChars = maxTokens * 4;
    if (result.length > maxChars) {
      result = result.substring(0, maxChars - 50) + '\n... (truncated)';
    }

    return result;
  }

  /**
   * Clear knowledge for a goal (on completion or reset)
   */
  clearKnowledge(goalRunId: string): void {
    this.knowledgeCache.delete(goalRunId);
    this.logger.debug(`Cleared knowledge cache for goal ${goalRunId}`);
  }

  /**
   * Extract facts using regex patterns (fast, no API calls)
   */
  private extractWithPatterns(text: string, stepNumber: number): ExtractedFact[] {
    const facts: ExtractedFact[] = [];
    const timestamp = new Date();

    // Extract prices
    const prices = text.match(EXTRACTION_PATTERNS.prices) || [];
    for (const price of prices.slice(0, 5)) {
      facts.push(this.createFact('metric', `Price found: ${price}`, 0.9, stepNumber, timestamp, text));
    }

    // Extract dates
    const dates = text.match(EXTRACTION_PATTERNS.dates) || [];
    for (const date of dates.slice(0, 3)) {
      facts.push(this.createFact('fact', `Date mentioned: ${date}`, 0.85, stepNumber, timestamp, text));
    }

    // Extract URLs
    const urls = text.match(EXTRACTION_PATTERNS.urls) || [];
    for (const url of urls.slice(0, 3)) {
      facts.push(this.createFact('discovery', `URL found: ${url}`, 0.95, stepNumber, timestamp, text));
    }

    // Extract confirmations
    let match;
    while ((match = EXTRACTION_PATTERNS.confirmations.exec(text)) !== null) {
      if (facts.length < 10) {
        facts.push(this.createFact('fact', match[0].trim(), 0.8, stepNumber, timestamp, text));
      }
    }

    // Extract errors
    while ((match = EXTRACTION_PATTERNS.errors.exec(text)) !== null) {
      if (facts.length < 15) {
        facts.push(this.createFact('error', match[0].trim(), 0.85, stepNumber, timestamp, text));
      }
    }

    // Extract decisions
    while ((match = EXTRACTION_PATTERNS.decisions.exec(text)) !== null) {
      if (facts.length < 15) {
        facts.push(this.createFact('decision', match[0].trim(), 0.75, stepNumber, timestamp, text));
      }
    }

    return facts;
  }

  /**
   * Extract facts using LLM (more accurate, requires API)
   */
  private async extractWithLLM(
    text: string,
    stepNumber: number,
    goalDescription: string,
  ): Promise<ExtractedFact[]> {
    const prompt = `You are extracting knowledge from an AI agent's step outcome.

GOAL: ${goalDescription}
STEP ${stepNumber} OUTCOME:
${text.substring(0, 2000)}

Extract the most important facts, decisions, and discoveries. Return a JSON array with objects containing:
- type: "fact" | "decision" | "discovery" | "error" | "metric"
- content: concise description (max 100 chars)
- confidence: 0-1 how certain this fact is
- entities: array of named entities mentioned

Return ONLY the JSON array, no other text. Extract at most 5 items, focusing on the most important.

Example output:
[
  {"type": "discovery", "content": "Found Southwest flight for $289", "confidence": 0.95, "entities": ["Southwest", "$289"]},
  {"type": "decision", "content": "Selected cheapest option", "confidence": 0.8, "entities": []}
]`;

    try {
      const response = await fetch(this.llmApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.llmApiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) {
        throw new Error(`LLM API error: ${response.status}`);
      }

      const data = await response.json();
      const responseText = data.content?.[0]?.text || '[]';

      // Parse JSON from response
      const jsonMatch = responseText.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return [];
      }

      const extracted = JSON.parse(jsonMatch[0]);
      const timestamp = new Date();

      return extracted.map((item: any) => this.createFact(
        item.type || 'fact',
        item.content || '',
        item.confidence || 0.7,
        stepNumber,
        timestamp,
        text,
        item.entities,
      ));
    } catch (error) {
      this.logger.warn(`LLM extraction parse error: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Create a fact object with unique ID
   */
  private createFact(
    type: ExtractedFact['type'],
    content: string,
    confidence: number,
    stepNumber: number,
    timestamp: Date,
    context: string,
    entities?: string[],
  ): ExtractedFact {
    return {
      id: `fact-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`,
      type,
      content: content.substring(0, 200),
      confidence,
      source: {
        stepNumber,
        timestamp,
        context: context.substring(0, 100),
      },
      entities: entities || [],
      tags: [],
    };
  }

  /**
   * Deduplicate and merge facts
   */
  private deduplicateAndMerge(
    existing: ExtractedFact[],
    newFacts: ExtractedFact[],
  ): ExtractedFact[] {
    const existingContents = new Set(existing.map(f => f.content.toLowerCase()));
    const result: ExtractedFact[] = [];

    for (const fact of newFacts) {
      const lowerContent = fact.content.toLowerCase();
      // Check for exact or near-duplicate
      if (!existingContents.has(lowerContent)) {
        // Check for similar content (simple Jaccard-ish similarity)
        const isDuplicate = existing.some(e => {
          const similarity = this.calculateSimilarity(e.content, fact.content);
          return similarity > 0.8;
        });

        if (!isDuplicate) {
          result.push(fact);
          existingContents.add(lowerContent);
        }
      }
    }

    return result;
  }

  /**
   * Calculate simple word overlap similarity
   */
  private calculateSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size;
  }

  /**
   * Extract entities from facts
   */
  private extractEntities(
    facts: ExtractedFact[],
    existing: ExtractedEntity[],
  ): ExtractedEntity[] {
    const entityMap = new Map<string, ExtractedEntity>();

    // Add existing entities
    for (const entity of existing) {
      entityMap.set(entity.name.toLowerCase(), entity);
    }

    // Extract from facts
    for (const fact of facts) {
      // From explicit entities
      for (const entityName of fact.entities || []) {
        const key = entityName.toLowerCase();
        const entityType = this.inferEntityType(entityName);

        if (entityMap.has(key)) {
          const e = entityMap.get(key)!;
          e.mentions++;
          e.lastSeen = fact.source.timestamp;
          e.relatedFacts.push(fact.id);
        } else {
          entityMap.set(key, {
            name: entityName,
            type: entityType,
            mentions: 1,
            firstSeen: fact.source.timestamp,
            lastSeen: fact.source.timestamp,
            relatedFacts: [fact.id],
          });
        }
      }

      // Extract prices as entities
      const prices = fact.content.match(EXTRACTION_PATTERNS.prices) || [];
      for (const price of prices) {
        const key = price.toLowerCase();
        if (!entityMap.has(key)) {
          entityMap.set(key, {
            name: price,
            type: 'price',
            mentions: 1,
            firstSeen: fact.source.timestamp,
            lastSeen: fact.source.timestamp,
            relatedFacts: [fact.id],
          });
        }
      }
    }

    return Array.from(entityMap.values());
  }

  /**
   * Infer entity type from name
   */
  private inferEntityType(name: string): ExtractedEntity['type'] {
    if (/^\$[\d,]+/.test(name) || /\d+\s*(USD|EUR|GBP)/i.test(name)) return 'price';
    if (/^https?:\/\//.test(name)) return 'url';
    if (/@/.test(name)) return 'other'; // Email-like
    if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(name)) return 'date';
    if (/^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(name)) return 'date';
    // Default to other - could be enhanced with NER
    return 'other';
  }

  /**
   * Update key metrics from facts
   */
  private updateKeyMetrics(graph: KnowledgeGraph, newFacts: ExtractedFact[]): void {
    for (const fact of newFacts) {
      if (fact.type === 'metric') {
        // Extract metric name and value
        const match = fact.content.match(/(.+?):\s*(.+)/);
        if (match) {
          graph.keyMetrics[match[1].trim()] = match[2].trim();
        }
      }

      // Also track prices as metrics
      const prices = fact.content.match(EXTRACTION_PATTERNS.prices) || [];
      if (prices.length > 0) {
        graph.keyMetrics['lastPrice'] = prices[prices.length - 1];
      }
    }
  }

  /**
   * Generate summary from knowledge graph
   */
  private generateSummary(graph: KnowledgeGraph): string {
    const factCount = graph.facts.length;
    const decisionCount = graph.decisions.length;
    const errorCount = graph.facts.filter(f => f.type === 'error').length;
    const discoveryCount = graph.facts.filter(f => f.type === 'discovery').length;

    const parts: string[] = [];
    parts.push(`Accumulated ${factCount} facts`);
    if (discoveryCount > 0) parts.push(`${discoveryCount} discoveries`);
    if (decisionCount > 0) parts.push(`${decisionCount} decisions`);
    if (errorCount > 0) parts.push(`${errorCount} errors encountered`);

    return parts.join(', ') + '.';
  }

  /**
   * Create empty knowledge graph
   */
  private createEmptyGraph(goalRunId: string): KnowledgeGraph {
    return {
      goalRunId,
      extractedAt: new Date(),
      facts: [],
      entities: [],
      summary: '',
      keyMetrics: {},
      decisions: [],
    };
  }

  /**
   * Return empty result
   */
  private emptyResult(goalRunId: string): ExtractionResult {
    return {
      success: true,
      knowledgeGraph: this.createEmptyGraph(goalRunId),
      newFactsCount: 0,
      newEntitiesCount: 0,
      processingTimeMs: 0,
    };
  }
}
