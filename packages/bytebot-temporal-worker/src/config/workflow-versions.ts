/**
 * Workflow Versioning Configuration - Phase 10.5
 *
 * This module defines patch IDs and version constants for workflow evolution.
 * Using Temporal's patched() API enables safe deployment of workflow changes
 * without breaking running workflow executions.
 *
 * Best Practices (Temporal 2025):
 * - Always put newest code at the top of if-patched blocks
 * - Use semantic patch IDs that describe the change
 * - Keep patch code until all affected workflows complete
 * - Use replay testing to verify patch correctness
 * - Consider Worker Versioning for major changes
 *
 * @see https://docs.temporal.io/develop/typescript/versioning
 * @see https://docs.temporal.io/patching
 */

// ============================================================================
// Patch IDs
// ============================================================================

/**
 * Patch IDs for workflow versioning.
 *
 * Naming convention: <version>-<feature>-<description>
 * Example: v1.1-search-attributes
 *
 * Once a patch is deployed and running workflows have used it,
 * the patch code must remain until all affected workflows complete.
 */
export const WORKFLOW_PATCHES = {
  /**
   * Phase 10.2: Added search attribute upserts
   * Affects: goalRunWorkflow
   * Added: 2026-01-05
   * Safe to remove after: All workflows started before this date complete
   */
  V1_1_SEARCH_ATTRIBUTES: 'v1.1-search-attributes',

  /**
   * Phase 10.3: Added update handlers
   * Affects: goalRunWorkflow
   * Added: 2026-01-05
   * Safe to remove after: All workflows started before this date complete
   */
  V1_1_UPDATE_HANDLERS: 'v1.1-update-handlers',

  /**
   * Phase 10.1: Enhanced metrics collection
   * Affects: Activities
   * Added: 2026-01-05
   * Note: Activity changes don't require patching (only workflow changes do)
   */
  V1_1_ENHANCED_METRICS: 'v1.1-enhanced-metrics',

  /**
   * Future: Example of how to add new patches
   * When adding workflow changes, add a new patch ID here
   */
  // V1_2_NEW_FEATURE: 'v1.2-new-feature',
} as const;

// ============================================================================
// Version Constants
// ============================================================================

/**
 * Current workflow version for logging and debugging.
 * Update this when deploying significant workflow changes.
 */
export const WORKFLOW_VERSION = '1.1.0';

/**
 * Minimum compatible workflow version.
 * Workflows started with versions below this may have issues.
 */
export const MIN_COMPATIBLE_VERSION = '1.0.0';

// ============================================================================
// Version Metadata
// ============================================================================

/**
 * Version history for documentation and debugging.
 */
export const VERSION_HISTORY = [
  {
    version: '1.0.0',
    date: '2026-01-01',
    changes: ['Initial release with PEVR workflow'],
    patches: [],
  },
  {
    version: '1.0.5',
    date: '2026-01-05',
    changes: ['Phase 9.2d: Fixed LLM proxy endpoint and authentication'],
    patches: [],
  },
  {
    version: '1.1.0',
    date: '2026-01-05',
    changes: [
      'Phase 10.1: Enhanced observability with custom Prometheus metrics',
      'Phase 10.2: Custom search attributes for workflow visibility',
      'Phase 10.3: Update handlers for synchronous operations',
      'Phase 10.4: Worker rate limiting configuration',
      'Phase 10.5: Workflow versioning support',
    ],
    patches: [
      WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES,
      WORKFLOW_PATCHES.V1_1_UPDATE_HANDLERS,
    ],
  },
] as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets the current version info.
 */
export function getCurrentVersionInfo() {
  return VERSION_HISTORY[VERSION_HISTORY.length - 1];
}

/**
 * Checks if a version is compatible with the current workflow.
 */
export function isVersionCompatible(version: string): boolean {
  const [major, minor] = version.split('.').map(Number);
  const [minMajor, minMinor] = MIN_COMPATIBLE_VERSION.split('.').map(Number);

  if (major > minMajor) return true;
  if (major === minMajor && minor >= minMinor) return true;
  return false;
}

// ============================================================================
// Deprecation Tracking
// ============================================================================

/**
 * Tracks which patches can be safely removed.
 *
 * To remove a patch:
 * 1. Query Temporal for workflows with the patch marker
 * 2. Wait for all such workflows to complete
 * 3. Remove the old code path (keep only new code)
 * 4. Deploy and test
 *
 * Query example:
 * temporal workflow list -q "TemporalChangeVersion CONTAINS 'v1.1-search-attributes'"
 */
export const DEPRECATION_STATUS = {
  [WORKFLOW_PATCHES.V1_1_SEARCH_ATTRIBUTES]: {
    canRemove: false,
    reason: 'Recently deployed - wait for workflow completion',
    checkAfter: '2026-02-05', // 1 month after deployment
  },
  [WORKFLOW_PATCHES.V1_1_UPDATE_HANDLERS]: {
    canRemove: false,
    reason: 'Recently deployed - wait for workflow completion',
    checkAfter: '2026-02-05',
  },
} as const;
