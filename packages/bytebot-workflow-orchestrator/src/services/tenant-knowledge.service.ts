/**
 * Tenant Knowledge Service
 * v1.0.0: Multi-Tenant Knowledge Graph Isolation
 *
 * Implements industry-standard patterns for tenant data isolation:
 * - AWS: Row-level security with tenant_id in all queries
 * - Salesforce: Namespace-based isolation
 * - Neo4j: Graph partitioning per tenant
 *
 * Key Features:
 * 1. Tenant-scoped knowledge graphs
 * 2. Automatic tenant context injection
 * 3. Cross-tenant analytics (aggregated, anonymized)
 * 4. Tenant-specific fact and entity storage
 * 5. Quota management per tenant
 *
 * @see /documentation/2026-01-03-ADVANCED_ENHANCEMENTS_V2.md
 */

import { Injectable, Logger, Scope, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from './prisma.service';
import {
  KnowledgeExtractionService,
  ExtractedFact,
  ExtractedEntity,
  KnowledgeGraph,
} from './knowledge-extraction.service';

// Tenant Context
export interface TenantContext {
  tenantId: string;
  organizationName?: string;
  tier: 'free' | 'pro' | 'enterprise';
  quotas: TenantQuotas;
}

// Quota Configuration
export interface TenantQuotas {
  maxFacts: number;
  maxEntities: number;
  maxGoalsPerDay: number;
  retentionDays: number;
}

// Tenant Knowledge Graph
export interface TenantKnowledgeGraph extends KnowledgeGraph {
  tenantId: string;
  totalFacts: number;
  totalEntities: number;
  usagePercent: number;
}

// Cross-Tenant Analytics (aggregated)
export interface CrossTenantAnalytics {
  totalTenants: number;
  totalFacts: number;
  totalEntities: number;
  averageFactsPerTenant: number;
  topEntityTypes: Array<{ type: string; count: number }>;
  topFactTypes: Array<{ type: string; count: number }>;
}

// Default quotas by tier
const DEFAULT_QUOTAS: Record<string, TenantQuotas> = {
  free: {
    maxFacts: 1000,
    maxEntities: 500,
    maxGoalsPerDay: 10,
    retentionDays: 7,
  },
  pro: {
    maxFacts: 10000,
    maxEntities: 5000,
    maxGoalsPerDay: 100,
    retentionDays: 30,
  },
  enterprise: {
    maxFacts: 100000,
    maxEntities: 50000,
    maxGoalsPerDay: 1000,
    retentionDays: 365,
  },
};

@Injectable()
export class TenantKnowledgeService {
  private readonly logger = new Logger(TenantKnowledgeService.name);
  private readonly enabled: boolean;

  // In-memory tenant knowledge storage
  // In production, this would be backed by database tables
  private tenantKnowledge: Map<string, {
    facts: ExtractedFact[];
    entities: ExtractedEntity[];
    goalGraphs: Map<string, KnowledgeGraph>;
    metadata: {
      createdAt: Date;
      updatedAt: Date;
      factCount: number;
      entityCount: number;
    };
  }> = new Map();

  // Tenant context cache
  private tenantContextCache: Map<string, TenantContext> = new Map();

  constructor(
    private readonly configService: ConfigService,
    private readonly eventEmitter: EventEmitter2,
    private readonly prisma: PrismaService,
    private readonly knowledgeService: KnowledgeExtractionService,
  ) {
    this.enabled = this.configService.get('TENANT_KNOWLEDGE_ENABLED', 'true') === 'true';
    this.logger.log(`Tenant knowledge service ${this.enabled ? 'enabled' : 'disabled'}`);
  }

  /**
   * Get or create tenant context
   */
  async getTenantContext(tenantId: string): Promise<TenantContext> {
    // Check cache
    if (this.tenantContextCache.has(tenantId)) {
      return this.tenantContextCache.get(tenantId)!;
    }

    // Try to load from database (if tenant table exists)
    try {
      // In production, query tenant from database
      // For now, create default context
      const context: TenantContext = {
        tenantId,
        tier: 'pro', // Default tier
        quotas: DEFAULT_QUOTAS['pro'],
      };

      this.tenantContextCache.set(tenantId, context);
      return context;
    } catch (error) {
      // Default context
      const context: TenantContext = {
        tenantId,
        tier: 'free',
        quotas: DEFAULT_QUOTAS['free'],
      };
      return context;
    }
  }

  /**
   * Get tenant knowledge graph
   */
  async getTenantKnowledge(tenantId: string): Promise<TenantKnowledgeGraph | null> {
    const context = await this.getTenantContext(tenantId);
    const storage = this.tenantKnowledge.get(tenantId);

    if (!storage) {
      return null;
    }

    const usagePercent = (storage.metadata.factCount / context.quotas.maxFacts) * 100;

    return {
      goalRunId: `tenant-${tenantId}`,
      extractedAt: storage.metadata.updatedAt,
      facts: storage.facts,
      entities: storage.entities,
      summary: `Tenant ${tenantId} knowledge: ${storage.metadata.factCount} facts, ${storage.metadata.entityCount} entities`,
      keyMetrics: {},
      decisions: [],
      tenantId,
      totalFacts: storage.metadata.factCount,
      totalEntities: storage.metadata.entityCount,
      usagePercent,
    };
  }

  /**
   * Add knowledge to tenant graph
   */
  async addKnowledge(
    tenantId: string,
    goalRunId: string,
    facts: ExtractedFact[],
    entities: ExtractedEntity[],
  ): Promise<{ added: number; quota: { used: number; max: number } }> {
    const context = await this.getTenantContext(tenantId);

    // Initialize storage if needed
    if (!this.tenantKnowledge.has(tenantId)) {
      this.tenantKnowledge.set(tenantId, {
        facts: [],
        entities: [],
        goalGraphs: new Map(),
        metadata: {
          createdAt: new Date(),
          updatedAt: new Date(),
          factCount: 0,
          entityCount: 0,
        },
      });
    }

    const storage = this.tenantKnowledge.get(tenantId)!;

    // Check quota
    const remainingCapacity = context.quotas.maxFacts - storage.metadata.factCount;
    if (remainingCapacity <= 0) {
      this.logger.warn(`Tenant ${tenantId} has reached fact quota (${context.quotas.maxFacts})`);

      // Emit quota warning
      this.eventEmitter.emit('tenant.quota.exceeded', {
        tenantId,
        resource: 'facts',
        current: storage.metadata.factCount,
        max: context.quotas.maxFacts,
      });

      return {
        added: 0,
        quota: { used: storage.metadata.factCount, max: context.quotas.maxFacts },
      };
    }

    // Add facts (up to quota)
    const factsToAdd = facts.slice(0, remainingCapacity);
    for (const fact of factsToAdd) {
      // Tag with tenant and goal
      const taggedFact: ExtractedFact = {
        ...fact,
        tags: [...(fact.tags || []), `tenant:${tenantId}`, `goal:${goalRunId}`],
      };
      storage.facts.push(taggedFact);
    }

    // Add entities (deduplicate by name)
    const existingEntityNames = new Set(storage.entities.map(e => e.name.toLowerCase()));
    for (const entity of entities) {
      if (!existingEntityNames.has(entity.name.toLowerCase())) {
        if (storage.metadata.entityCount < context.quotas.maxEntities) {
          storage.entities.push(entity);
          storage.metadata.entityCount++;
          existingEntityNames.add(entity.name.toLowerCase());
        }
      } else {
        // Update existing entity
        const existing = storage.entities.find(
          e => e.name.toLowerCase() === entity.name.toLowerCase()
        );
        if (existing) {
          existing.mentions += entity.mentions;
          existing.lastSeen = entity.lastSeen;
          existing.relatedFacts.push(...entity.relatedFacts);
        }
      }
    }

    // Update metadata
    storage.metadata.factCount += factsToAdd.length;
    storage.metadata.updatedAt = new Date();

    // Store goal-specific graph
    const goalGraph = this.knowledgeService.getKnowledge(goalRunId);
    if (goalGraph) {
      storage.goalGraphs.set(goalRunId, goalGraph);
    }

    this.logger.debug(
      `Added ${factsToAdd.length} facts for tenant ${tenantId} ` +
      `(${storage.metadata.factCount}/${context.quotas.maxFacts})`
    );

    return {
      added: factsToAdd.length,
      quota: { used: storage.metadata.factCount, max: context.quotas.maxFacts },
    };
  }

  /**
   * Search tenant knowledge
   */
  async searchKnowledge(
    tenantId: string,
    query: string,
    options: {
      types?: ExtractedFact['type'][];
      limit?: number;
      minConfidence?: number;
    } = {},
  ): Promise<ExtractedFact[]> {
    const storage = this.tenantKnowledge.get(tenantId);
    if (!storage) {
      return [];
    }

    const queryLower = query.toLowerCase();
    const limit = options.limit || 20;
    const minConfidence = options.minConfidence || 0;

    let results = storage.facts.filter(fact => {
      // Content match
      const contentMatch = fact.content.toLowerCase().includes(queryLower);

      // Type filter
      const typeMatch = !options.types || options.types.includes(fact.type);

      // Confidence filter
      const confidenceMatch = fact.confidence >= minConfidence;

      return contentMatch && typeMatch && confidenceMatch;
    });

    // Sort by confidence and recency
    results.sort((a, b) => {
      const confidenceDiff = b.confidence - a.confidence;
      if (Math.abs(confidenceDiff) > 0.1) {
        return confidenceDiff;
      }
      return b.source.timestamp.getTime() - a.source.timestamp.getTime();
    });

    return results.slice(0, limit);
  }

  /**
   * Get entities for tenant
   */
  async getTenantEntities(
    tenantId: string,
    options: {
      types?: ExtractedEntity['type'][];
      limit?: number;
      sortBy?: 'mentions' | 'recency';
    } = {},
  ): Promise<ExtractedEntity[]> {
    const storage = this.tenantKnowledge.get(tenantId);
    if (!storage) {
      return [];
    }

    let entities = [...storage.entities];

    // Type filter
    if (options.types?.length) {
      entities = entities.filter(e => options.types!.includes(e.type));
    }

    // Sort
    if (options.sortBy === 'recency') {
      entities.sort((a, b) => b.lastSeen.getTime() - a.lastSeen.getTime());
    } else {
      entities.sort((a, b) => b.mentions - a.mentions);
    }

    return entities.slice(0, options.limit || 50);
  }

  /**
   * Get cross-tenant analytics (admin only, aggregated)
   */
  async getCrossTenantAnalytics(): Promise<CrossTenantAnalytics> {
    let totalFacts = 0;
    let totalEntities = 0;
    const entityTypeCounts = new Map<string, number>();
    const factTypeCounts = new Map<string, number>();

    for (const [_, storage] of this.tenantKnowledge) {
      totalFacts += storage.metadata.factCount;
      totalEntities += storage.metadata.entityCount;

      for (const entity of storage.entities) {
        entityTypeCounts.set(entity.type, (entityTypeCounts.get(entity.type) || 0) + 1);
      }

      for (const fact of storage.facts) {
        factTypeCounts.set(fact.type, (factTypeCounts.get(fact.type) || 0) + 1);
      }
    }

    const totalTenants = this.tenantKnowledge.size || 1;

    return {
      totalTenants,
      totalFacts,
      totalEntities,
      averageFactsPerTenant: Math.round(totalFacts / totalTenants),
      topEntityTypes: Array.from(entityTypeCounts.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      topFactTypes: Array.from(factTypeCounts.entries())
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
    };
  }

  /**
   * Clean up old facts based on retention policy
   */
  async cleanupExpiredFacts(tenantId: string): Promise<number> {
    const context = await this.getTenantContext(tenantId);
    const storage = this.tenantKnowledge.get(tenantId);

    if (!storage) {
      return 0;
    }

    const cutoffDate = new Date(Date.now() - context.quotas.retentionDays * 24 * 60 * 60 * 1000);

    const originalCount = storage.facts.length;
    storage.facts = storage.facts.filter(
      fact => fact.source.timestamp > cutoffDate
    );

    const removedCount = originalCount - storage.facts.length;
    storage.metadata.factCount = storage.facts.length;

    if (removedCount > 0) {
      this.logger.log(`Cleaned up ${removedCount} expired facts for tenant ${tenantId}`);
    }

    return removedCount;
  }

  /**
   * Delete all knowledge for a tenant
   */
  async deleteTenantKnowledge(tenantId: string): Promise<boolean> {
    const deleted = this.tenantKnowledge.delete(tenantId);
    this.tenantContextCache.delete(tenantId);

    if (deleted) {
      this.logger.log(`Deleted all knowledge for tenant ${tenantId}`);
      this.eventEmitter.emit('tenant.knowledge.deleted', { tenantId });
    }

    return deleted;
  }

  /**
   * Get tenant usage statistics
   */
  async getTenantUsage(tenantId: string): Promise<{
    facts: { used: number; max: number; percent: number };
    entities: { used: number; max: number; percent: number };
    retentionDays: number;
  } | null> {
    const context = await this.getTenantContext(tenantId);
    const storage = this.tenantKnowledge.get(tenantId);

    if (!storage) {
      return {
        facts: { used: 0, max: context.quotas.maxFacts, percent: 0 },
        entities: { used: 0, max: context.quotas.maxEntities, percent: 0 },
        retentionDays: context.quotas.retentionDays,
      };
    }

    return {
      facts: {
        used: storage.metadata.factCount,
        max: context.quotas.maxFacts,
        percent: Math.round((storage.metadata.factCount / context.quotas.maxFacts) * 100),
      },
      entities: {
        used: storage.metadata.entityCount,
        max: context.quotas.maxEntities,
        percent: Math.round((storage.metadata.entityCount / context.quotas.maxEntities) * 100),
      },
      retentionDays: context.quotas.retentionDays,
    };
  }

  /**
   * Export tenant knowledge (for backup/migration)
   */
  async exportTenantKnowledge(tenantId: string): Promise<{
    tenantId: string;
    exportedAt: Date;
    facts: ExtractedFact[];
    entities: ExtractedEntity[];
  } | null> {
    const storage = this.tenantKnowledge.get(tenantId);

    if (!storage) {
      return null;
    }

    return {
      tenantId,
      exportedAt: new Date(),
      facts: storage.facts,
      entities: storage.entities,
    };
  }

  /**
   * Import tenant knowledge (from backup/migration)
   */
  async importTenantKnowledge(
    tenantId: string,
    data: {
      facts: ExtractedFact[];
      entities: ExtractedEntity[];
    },
  ): Promise<{ factsImported: number; entitiesImported: number }> {
    const context = await this.getTenantContext(tenantId);

    // Initialize or reset storage
    this.tenantKnowledge.set(tenantId, {
      facts: data.facts.slice(0, context.quotas.maxFacts),
      entities: data.entities.slice(0, context.quotas.maxEntities),
      goalGraphs: new Map(),
      metadata: {
        createdAt: new Date(),
        updatedAt: new Date(),
        factCount: Math.min(data.facts.length, context.quotas.maxFacts),
        entityCount: Math.min(data.entities.length, context.quotas.maxEntities),
      },
    });

    const storage = this.tenantKnowledge.get(tenantId)!;

    this.logger.log(
      `Imported ${storage.metadata.factCount} facts and ${storage.metadata.entityCount} entities for tenant ${tenantId}`
    );

    return {
      factsImported: storage.metadata.factCount,
      entitiesImported: storage.metadata.entityCount,
    };
  }
}
