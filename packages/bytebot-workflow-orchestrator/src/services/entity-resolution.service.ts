/**
 * Entity Resolution Service
 * v1.0.0: Advanced Entity Linking and Disambiguation
 *
 * Implements industry-standard patterns for entity resolution:
 * - Google Knowledge Graph: Entity disambiguation with confidence
 * - Microsoft Entity Linking: Coreference resolution
 * - Amazon Product Graph: Fuzzy matching with canonical forms
 *
 * Key Features:
 * 1. Cross-step entity linking (same entity mentioned differently)
 * 2. Fuzzy string matching (Levenshtein, Jaro-Winkler)
 * 3. Canonical entity normalization
 * 4. Entity relationship mapping
 * 5. LLM-assisted disambiguation
 *
 * @see /documentation/2026-01-03-ADVANCED_ENHANCEMENTS_V2.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ExtractedEntity } from './knowledge-extraction.service';

// Resolved Entity (canonical form)
export interface ResolvedEntity {
  id: string;
  canonicalName: string;
  type: ExtractedEntity['type'];
  aliases: string[]; // All variations found
  mentions: number;
  confidence: number;
  firstSeen: Date;
  lastSeen: Date;
  sources: Array<{
    goalRunId: string;
    stepNumber: number;
    originalText: string;
  }>;
  relationships: EntityRelationship[];
  metadata: Record<string, any>;
}

// Entity Relationship
export interface EntityRelationship {
  type: 'related_to' | 'part_of' | 'same_as' | 'derived_from' | 'refers_to';
  targetEntityId: string;
  confidence: number;
  evidence?: string;
}

// Resolution Result
export interface ResolutionResult {
  resolved: boolean;
  entity: ResolvedEntity;
  matchedExisting: boolean;
  matchConfidence: number;
  alternativeMatches?: Array<{
    entityId: string;
    confidence: number;
  }>;
}

// Entity Cluster (group of related entities)
export interface EntityCluster {
  id: string;
  primaryEntity: ResolvedEntity;
  relatedEntities: ResolvedEntity[];
  clusterType: 'identity' | 'hierarchy' | 'association';
  totalMentions: number;
}

@Injectable()
export class EntityResolutionService {
  private readonly logger = new Logger(EntityResolutionService.name);
  private readonly enabled: boolean;
  private readonly llmApiKey: string;
  private readonly llmApiUrl: string;

  // Canonical entity store (goalRunId -> entityId -> ResolvedEntity)
  private entityStore: Map<string, Map<string, ResolvedEntity>> = new Map();

  // Global entity index for cross-goal resolution
  private globalEntityIndex: Map<string, ResolvedEntity> = new Map();

  // Configuration
  private readonly matchThreshold: number;
  private readonly useLlmDisambiguation: boolean;

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    this.enabled = this.configService.get('ENTITY_RESOLUTION_ENABLED', 'true') === 'true';
    this.llmApiKey = this.configService.get('ANTHROPIC_API_KEY', '');
    this.llmApiUrl = this.configService.get('LLM_API_URL', 'https://api.anthropic.com/v1/messages');
    this.matchThreshold = parseFloat(this.configService.get('ENTITY_MATCH_THRESHOLD', '0.85'));
    this.useLlmDisambiguation = this.configService.get('USE_LLM_DISAMBIGUATION', 'true') === 'true';

    this.logger.log(
      `Entity resolution ${this.enabled ? 'enabled' : 'disabled'} ` +
      `(threshold: ${this.matchThreshold})`
    );
  }

  /**
   * Resolve an entity mention to a canonical form
   */
  async resolveEntity(
    goalRunId: string,
    entity: ExtractedEntity,
    stepNumber: number,
    context?: string,
  ): Promise<ResolutionResult> {
    if (!this.enabled) {
      return this.createNewEntity(goalRunId, entity, stepNumber);
    }

    // Get or create goal entity store
    if (!this.entityStore.has(goalRunId)) {
      this.entityStore.set(goalRunId, new Map());
    }
    const goalEntities = this.entityStore.get(goalRunId)!;

    // Try to find matching entity
    const matches = this.findMatches(entity.name, entity.type, goalEntities);

    if (matches.length > 0 && matches[0].confidence >= this.matchThreshold) {
      // Found a match - merge with existing
      const bestMatch = matches[0];
      const resolved = this.mergeEntity(bestMatch.entity, entity, stepNumber, goalRunId);

      return {
        resolved: true,
        entity: resolved,
        matchedExisting: true,
        matchConfidence: bestMatch.confidence,
        alternativeMatches: matches.slice(1).map(m => ({
          entityId: m.entity.id,
          confidence: m.confidence,
        })),
      };
    }

    // Check if LLM disambiguation can help
    if (this.useLlmDisambiguation && matches.length > 0 && context) {
      const disambiguated = await this.llmDisambiguate(entity, matches, context);
      if (disambiguated) {
        const resolved = this.mergeEntity(disambiguated.entity, entity, stepNumber, goalRunId);
        return {
          resolved: true,
          entity: resolved,
          matchedExisting: true,
          matchConfidence: disambiguated.confidence,
        };
      }
    }

    // No match found - create new entity
    return this.createNewEntity(goalRunId, entity, stepNumber);
  }

  /**
   * Resolve multiple entities in batch
   */
  async resolveEntities(
    goalRunId: string,
    entities: ExtractedEntity[],
    stepNumber: number,
    context?: string,
  ): Promise<ResolutionResult[]> {
    const results: ResolutionResult[] = [];

    for (const entity of entities) {
      const result = await this.resolveEntity(goalRunId, entity, stepNumber, context);
      results.push(result);
    }

    // Find relationships between resolved entities
    this.detectRelationships(goalRunId, results.map(r => r.entity));

    return results;
  }

  /**
   * Get all resolved entities for a goal
   */
  getResolvedEntities(goalRunId: string): ResolvedEntity[] {
    const goalEntities = this.entityStore.get(goalRunId);
    if (!goalEntities) {
      return [];
    }
    return Array.from(goalEntities.values());
  }

  /**
   * Get entity by ID
   */
  getEntity(goalRunId: string, entityId: string): ResolvedEntity | null {
    return this.entityStore.get(goalRunId)?.get(entityId) || null;
  }

  /**
   * Find entity clusters (groups of related entities)
   */
  findEntityClusters(goalRunId: string): EntityCluster[] {
    const entities = this.getResolvedEntities(goalRunId);
    const visited = new Set<string>();
    const clusters: EntityCluster[] = [];

    for (const entity of entities) {
      if (visited.has(entity.id)) continue;

      const cluster = this.buildCluster(entity, entities, visited);
      if (cluster.relatedEntities.length > 0 || cluster.primaryEntity.mentions > 2) {
        clusters.push(cluster);
      }
    }

    return clusters.sort((a, b) => b.totalMentions - a.totalMentions);
  }

  /**
   * Link entities across goals (for cross-goal learning)
   */
  async linkCrossGoalEntities(
    goalRunIds: string[],
  ): Promise<Map<string, string[]>> {
    const linkedGroups = new Map<string, string[]>();
    const allEntities: Array<{ goalRunId: string; entity: ResolvedEntity }> = [];

    // Collect all entities
    for (const goalRunId of goalRunIds) {
      const entities = this.getResolvedEntities(goalRunId);
      for (const entity of entities) {
        allEntities.push({ goalRunId, entity });
      }
    }

    // Find matches across goals
    for (let i = 0; i < allEntities.length; i++) {
      for (let j = i + 1; j < allEntities.length; j++) {
        if (allEntities[i].goalRunId === allEntities[j].goalRunId) continue;

        const similarity = this.calculateSimilarity(
          allEntities[i].entity.canonicalName,
          allEntities[j].entity.canonicalName,
        );

        if (similarity >= this.matchThreshold &&
            allEntities[i].entity.type === allEntities[j].entity.type) {
          const key1 = `${allEntities[i].goalRunId}:${allEntities[i].entity.id}`;
          const key2 = `${allEntities[j].goalRunId}:${allEntities[j].entity.id}`;

          if (!linkedGroups.has(key1)) {
            linkedGroups.set(key1, [key1]);
          }
          linkedGroups.get(key1)!.push(key2);
        }
      }
    }

    return linkedGroups;
  }

  /**
   * Get entity statistics
   */
  getStatistics(goalRunId: string): {
    totalEntities: number;
    byType: Record<string, number>;
    averageAliases: number;
    totalRelationships: number;
  } {
    const entities = this.getResolvedEntities(goalRunId);

    const byType: Record<string, number> = {};
    let totalAliases = 0;
    let totalRelationships = 0;

    for (const entity of entities) {
      byType[entity.type] = (byType[entity.type] || 0) + 1;
      totalAliases += entity.aliases.length;
      totalRelationships += entity.relationships.length;
    }

    return {
      totalEntities: entities.length,
      byType,
      averageAliases: entities.length > 0 ? totalAliases / entities.length : 0,
      totalRelationships,
    };
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private findMatches(
    name: string,
    type: ExtractedEntity['type'],
    entities: Map<string, ResolvedEntity>,
  ): Array<{ entity: ResolvedEntity; confidence: number }> {
    const matches: Array<{ entity: ResolvedEntity; confidence: number }> = [];
    const nameLower = name.toLowerCase();

    for (const entity of entities.values()) {
      // Type must match
      if (entity.type !== type) continue;

      // Check canonical name
      let maxConfidence = this.calculateSimilarity(nameLower, entity.canonicalName.toLowerCase());

      // Check aliases
      for (const alias of entity.aliases) {
        const aliasConfidence = this.calculateSimilarity(nameLower, alias.toLowerCase());
        maxConfidence = Math.max(maxConfidence, aliasConfidence);
      }

      if (maxConfidence > 0.5) {
        matches.push({ entity, confidence: maxConfidence });
      }
    }

    return matches.sort((a, b) => b.confidence - a.confidence);
  }

  private calculateSimilarity(str1: string, str2: string): number {
    // Exact match
    if (str1 === str2) return 1.0;

    // Normalize
    const s1 = str1.toLowerCase().trim();
    const s2 = str2.toLowerCase().trim();

    if (s1 === s2) return 0.99;

    // Contains check
    if (s1.includes(s2) || s2.includes(s1)) {
      return 0.9;
    }

    // Jaro-Winkler similarity
    return this.jaroWinkler(s1, s2);
  }

  private jaroWinkler(s1: string, s2: string): number {
    const jaro = this.jaroSimilarity(s1, s2);

    // Common prefix (up to 4 chars)
    let prefix = 0;
    for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
      if (s1[i] === s2[i]) {
        prefix++;
      } else {
        break;
      }
    }

    return jaro + (prefix * 0.1 * (1 - jaro));
  }

  private jaroSimilarity(s1: string, s2: string): number {
    if (s1.length === 0 && s2.length === 0) return 1.0;
    if (s1.length === 0 || s2.length === 0) return 0.0;

    const matchWindow = Math.max(Math.floor(Math.max(s1.length, s2.length) / 2) - 1, 0);
    const s1Matches = new Array(s1.length).fill(false);
    const s2Matches = new Array(s2.length).fill(false);

    let matches = 0;
    let transpositions = 0;

    // Find matches
    for (let i = 0; i < s1.length; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, s2.length);

      for (let j = start; j < end; j++) {
        if (s2Matches[j] || s1[i] !== s2[j]) continue;
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }

    if (matches === 0) return 0.0;

    // Count transpositions
    let k = 0;
    for (let i = 0; i < s1.length; i++) {
      if (!s1Matches[i]) continue;
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) transpositions++;
      k++;
    }

    return (
      (matches / s1.length +
        matches / s2.length +
        (matches - transpositions / 2) / matches) / 3
    );
  }

  private createNewEntity(
    goalRunId: string,
    entity: ExtractedEntity,
    stepNumber: number,
  ): ResolutionResult {
    const canonicalName = this.normalizeEntityName(entity.name);
    const entityId = `ent-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

    const resolved: ResolvedEntity = {
      id: entityId,
      canonicalName,
      type: entity.type,
      aliases: entity.name !== canonicalName ? [entity.name] : [],
      mentions: entity.mentions,
      confidence: 1.0,
      firstSeen: entity.firstSeen,
      lastSeen: entity.lastSeen,
      sources: [{
        goalRunId,
        stepNumber,
        originalText: entity.name,
      }],
      relationships: [],
      metadata: {},
    };

    // Store
    if (!this.entityStore.has(goalRunId)) {
      this.entityStore.set(goalRunId, new Map());
    }
    this.entityStore.get(goalRunId)!.set(entityId, resolved);

    return {
      resolved: true,
      entity: resolved,
      matchedExisting: false,
      matchConfidence: 1.0,
    };
  }

  private mergeEntity(
    existing: ResolvedEntity,
    newEntity: ExtractedEntity,
    stepNumber: number,
    goalRunId: string,
  ): ResolvedEntity {
    // Add alias if different from canonical
    const newName = this.normalizeEntityName(newEntity.name);
    if (newName !== existing.canonicalName && !existing.aliases.includes(newEntity.name)) {
      existing.aliases.push(newEntity.name);
    }

    // Update mentions and timestamps
    existing.mentions += newEntity.mentions;
    if (newEntity.lastSeen > existing.lastSeen) {
      existing.lastSeen = newEntity.lastSeen;
    }
    if (newEntity.firstSeen < existing.firstSeen) {
      existing.firstSeen = newEntity.firstSeen;
    }

    // Add source
    existing.sources.push({
      goalRunId,
      stepNumber,
      originalText: newEntity.name,
    });

    return existing;
  }

  private normalizeEntityName(name: string): string {
    // Remove common prefixes/suffixes
    let normalized = name.trim();

    // Remove currency symbols for prices
    normalized = normalized.replace(/^[\$€£]/, '').trim();

    // Title case for proper nouns
    if (/^[a-z]/.test(normalized)) {
      normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }

    // Remove trailing punctuation
    normalized = normalized.replace(/[.,;:!?]+$/, '');

    return normalized;
  }

  private async llmDisambiguate(
    entity: ExtractedEntity,
    candidates: Array<{ entity: ResolvedEntity; confidence: number }>,
    context: string,
  ): Promise<{ entity: ResolvedEntity; confidence: number } | null> {
    if (!this.llmApiKey || candidates.length === 0) {
      return null;
    }

    const candidateList = candidates.slice(0, 5).map((c, i) =>
      `${i + 1}. "${c.entity.canonicalName}" (aliases: ${c.entity.aliases.join(', ')})`
    ).join('\n');

    const prompt = `Given the context and entity mention, determine if any candidate matches.

CONTEXT: ${context.substring(0, 500)}

ENTITY MENTION: "${entity.name}" (type: ${entity.type})

CANDIDATES:
${candidateList}

Respond with ONLY a JSON object:
{"match": <number 1-5 or null if no match>, "confidence": <0-1>}`;

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
          max_tokens: 100,
          messages: [{ role: 'user', content: prompt }],
        }),
      });

      if (!response.ok) return null;

      const data = await response.json();
      const text = data.content?.[0]?.text || '';
      const match = text.match(/\{[^}]+\}/);

      if (match) {
        const result = JSON.parse(match[0]);
        if (result.match && result.match >= 1 && result.match <= candidates.length) {
          return {
            entity: candidates[result.match - 1].entity,
            confidence: result.confidence || 0.8,
          };
        }
      }
    } catch (error) {
      this.logger.debug(`LLM disambiguation failed: ${(error as Error).message}`);
    }

    return null;
  }

  private detectRelationships(goalRunId: string, entities: ResolvedEntity[]): void {
    // Detect relationships between entities based on co-occurrence and naming
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const e1 = entities[i];
        const e2 = entities[j];

        // Check for hierarchical relationship (one contains the other)
        if (e1.canonicalName.toLowerCase().includes(e2.canonicalName.toLowerCase())) {
          e2.relationships.push({
            type: 'part_of',
            targetEntityId: e1.id,
            confidence: 0.7,
          });
        } else if (e2.canonicalName.toLowerCase().includes(e1.canonicalName.toLowerCase())) {
          e1.relationships.push({
            type: 'part_of',
            targetEntityId: e2.id,
            confidence: 0.7,
          });
        }

        // Check for co-occurrence in same step
        const sharedSteps = e1.sources.filter(s1 =>
          e2.sources.some(s2 => s2.stepNumber === s1.stepNumber)
        );
        if (sharedSteps.length > 0) {
          e1.relationships.push({
            type: 'related_to',
            targetEntityId: e2.id,
            confidence: 0.5 + (sharedSteps.length * 0.1),
          });
        }
      }
    }
  }

  private buildCluster(
    entity: ResolvedEntity,
    allEntities: ResolvedEntity[],
    visited: Set<string>,
  ): EntityCluster {
    visited.add(entity.id);

    const relatedEntities: ResolvedEntity[] = [];
    let totalMentions = entity.mentions;

    // Find directly related entities
    for (const rel of entity.relationships) {
      const related = allEntities.find(e => e.id === rel.targetEntityId);
      if (related && !visited.has(related.id)) {
        visited.add(related.id);
        relatedEntities.push(related);
        totalMentions += related.mentions;
      }
    }

    // Determine cluster type
    let clusterType: EntityCluster['clusterType'] = 'association';
    if (entity.relationships.some(r => r.type === 'same_as')) {
      clusterType = 'identity';
    } else if (entity.relationships.some(r => r.type === 'part_of')) {
      clusterType = 'hierarchy';
    }

    return {
      id: `cluster-${entity.id}`,
      primaryEntity: entity,
      relatedEntities,
      clusterType,
      totalMentions,
    };
  }
}
