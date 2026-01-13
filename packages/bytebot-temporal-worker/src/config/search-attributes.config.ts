/**
 * Custom Search Attributes Configuration - Phase 10.2
 *
 * Defines custom search attributes for ByteBot workflow visibility.
 * These attributes enable filtering and searching workflows in Temporal UI.
 *
 * Best Practices (Temporal 2025):
 * - Use for search/visibility, not business logic (use queries for that)
 * - Don't store PII in search attributes (not encrypted)
 * - Use keyword type for exact matches, text for partial matches
 * - Keep cardinality reasonable to avoid performance issues
 *
 * @see https://docs.temporal.io/search-attribute
 * @see https://docs.temporal.io/typescript/search-attributes
 */

// ============================================================================
// Search Attribute Type Definitions
// ============================================================================

/**
 * Custom search attribute names used by ByteBot workflows.
 * These must be registered in Temporal before use.
 *
 * Registration command:
 * temporal operator search-attribute create --namespace bytebot --name ByteBotTenantId --type Keyword
 * temporal operator search-attribute create --namespace bytebot --name ByteBotGoalRunId --type Keyword
 * temporal operator search-attribute create --namespace bytebot --name ByteBotPhase --type Keyword
 * temporal operator search-attribute create --namespace bytebot --name ByteBotStepCount --type Int
 * temporal operator search-attribute create --namespace bytebot --name ByteBotHasHighRiskSteps --type Bool
 * temporal operator search-attribute create --namespace bytebot --name ByteBotIsAwaitingApproval --type Bool
 * temporal operator search-attribute create --namespace bytebot --name ByteBotErrorType --type Keyword
 */
export const SEARCH_ATTRIBUTES = {
  /**
   * Tenant ID for multi-tenant filtering
   * Type: Keyword (exact match)
   */
  TENANT_ID: 'ByteBotTenantId',

  /**
   * Goal Run ID for direct lookup
   * Type: Keyword (exact match)
   */
  GOAL_RUN_ID: 'ByteBotGoalRunId',

  /**
   * Current workflow phase (PLANNING, EXECUTING, VERIFYING, etc.)
   * Type: Keyword (exact match)
   */
  PHASE: 'ByteBotPhase',

  /**
   * Total number of steps in the plan
   * Type: Int
   */
  STEP_COUNT: 'ByteBotStepCount',

  /**
   * Whether the workflow has high-risk steps requiring approval
   * Type: Bool
   */
  HAS_HIGH_RISK_STEPS: 'ByteBotHasHighRiskSteps',

  /**
   * Whether workflow is currently awaiting human approval
   * Type: Bool
   */
  IS_AWAITING_APPROVAL: 'ByteBotIsAwaitingApproval',

  /**
   * Error type if workflow failed (for error analysis)
   * Type: Keyword (exact match)
   */
  ERROR_TYPE: 'ByteBotErrorType',
} as const;

// ============================================================================
// Type-Safe Search Attribute Interfaces
// ============================================================================

/**
 * Type-safe interface for ByteBot search attributes.
 * Used when setting initial attributes or upserting.
 *
 * Phase 11: Added index signature for Temporal SearchAttributes compatibility
 */
export interface ByteBotSearchAttributes {
  [key: string]: string[] | number[] | boolean[] | undefined;
  [SEARCH_ATTRIBUTES.TENANT_ID]?: string[];
  [SEARCH_ATTRIBUTES.GOAL_RUN_ID]?: string[];
  [SEARCH_ATTRIBUTES.PHASE]?: string[];
  [SEARCH_ATTRIBUTES.STEP_COUNT]?: number[];
  [SEARCH_ATTRIBUTES.HAS_HIGH_RISK_STEPS]?: boolean[];
  [SEARCH_ATTRIBUTES.IS_AWAITING_APPROVAL]?: boolean[];
  [SEARCH_ATTRIBUTES.ERROR_TYPE]?: string[];
}

/**
 * Valid phase values for the ByteBotPhase search attribute
 */
export type ByteBotPhaseAttribute =
  | 'INITIALIZING'
  | 'PLANNING'
  | 'EXECUTING'
  | 'WAITING_USER_INPUT'
  | 'VERIFYING'
  | 'REPLANNING'
  | 'PAUSED'
  | 'AWAITING_APPROVAL'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Creates initial search attributes for a new workflow execution.
 */
export function createInitialSearchAttributes(
  tenantId: string,
  goalRunId: string
): ByteBotSearchAttributes {
  return {
    [SEARCH_ATTRIBUTES.TENANT_ID]: [tenantId],
    [SEARCH_ATTRIBUTES.GOAL_RUN_ID]: [goalRunId],
    [SEARCH_ATTRIBUTES.PHASE]: ['INITIALIZING'],
    [SEARCH_ATTRIBUTES.STEP_COUNT]: [0],
    [SEARCH_ATTRIBUTES.HAS_HIGH_RISK_STEPS]: [false],
    [SEARCH_ATTRIBUTES.IS_AWAITING_APPROVAL]: [false],
  };
}

/**
 * Creates search attribute update for phase change.
 */
export function createPhaseUpdate(phase: ByteBotPhaseAttribute): ByteBotSearchAttributes {
  return {
    [SEARCH_ATTRIBUTES.PHASE]: [phase],
  };
}

/**
 * Creates search attribute update for step plan completion.
 */
export function createPlanSearchAttributes(
  stepCount: number,
  hasHighRiskSteps: boolean
): ByteBotSearchAttributes {
  return {
    [SEARCH_ATTRIBUTES.STEP_COUNT]: [stepCount],
    [SEARCH_ATTRIBUTES.HAS_HIGH_RISK_STEPS]: [hasHighRiskSteps],
    [SEARCH_ATTRIBUTES.PHASE]: ['EXECUTING'],
  };
}

/**
 * Creates search attribute update for approval state.
 */
export function createApprovalStateUpdate(isAwaitingApproval: boolean): ByteBotSearchAttributes {
  const update: ByteBotSearchAttributes = {
    [SEARCH_ATTRIBUTES.IS_AWAITING_APPROVAL]: [isAwaitingApproval],
  };

  if (isAwaitingApproval) {
    update[SEARCH_ATTRIBUTES.PHASE] = ['AWAITING_APPROVAL'];
  }

  return update;
}

/**
 * Creates search attribute update for error state.
 */
export function createErrorSearchAttributes(errorType: string): ByteBotSearchAttributes {
  return {
    [SEARCH_ATTRIBUTES.PHASE]: ['FAILED'],
    [SEARCH_ATTRIBUTES.ERROR_TYPE]: [errorType],
  };
}

// ============================================================================
// Kubernetes Job for Search Attribute Registration
// ============================================================================

/**
 * Shell commands to register custom search attributes.
 * Run these once per Temporal namespace.
 *
 * Example job manifest at:
 * kubernetes/manifests/temporal-search-attributes/job.yaml
 */
export const REGISTRATION_COMMANDS = `
# Register ByteBot custom search attributes in Temporal namespace
temporal operator search-attribute create --namespace bytebot --name ${SEARCH_ATTRIBUTES.TENANT_ID} --type Keyword
temporal operator search-attribute create --namespace bytebot --name ${SEARCH_ATTRIBUTES.GOAL_RUN_ID} --type Keyword
temporal operator search-attribute create --namespace bytebot --name ${SEARCH_ATTRIBUTES.PHASE} --type Keyword
temporal operator search-attribute create --namespace bytebot --name ${SEARCH_ATTRIBUTES.STEP_COUNT} --type Int
temporal operator search-attribute create --namespace bytebot --name ${SEARCH_ATTRIBUTES.HAS_HIGH_RISK_STEPS} --type Bool
temporal operator search-attribute create --namespace bytebot --name ${SEARCH_ATTRIBUTES.IS_AWAITING_APPROVAL} --type Bool
temporal operator search-attribute create --namespace bytebot --name ${SEARCH_ATTRIBUTES.ERROR_TYPE} --type Keyword
`.trim();

// ============================================================================
// Example Temporal Queries
// ============================================================================

/**
 * Example queries for filtering workflows in Temporal UI or CLI.
 *
 * Find all workflows for a tenant:
 * ByteBotTenantId = "tenant-123"
 *
 * Find workflows awaiting approval:
 * ByteBotIsAwaitingApproval = true
 *
 * Find failed workflows with specific error:
 * ByteBotPhase = "FAILED" AND ByteBotErrorType = "MAX_RETRIES_EXCEEDED"
 *
 * Find workflows with many steps:
 * ByteBotStepCount > 10
 *
 * Find high-risk workflows in execution:
 * ByteBotHasHighRiskSteps = true AND ByteBotPhase = "EXECUTING"
 */
