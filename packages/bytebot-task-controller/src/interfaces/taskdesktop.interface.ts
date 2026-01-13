/**
 * TaskDesktop CRD TypeScript Interfaces
 * Phase 6.2: Task Controller Service
 * v1.0.15: Added workspace persistence support (workspaceId, persistence config, pvcName)
 */

import { V1ObjectMeta } from '@kubernetes/client-node';

/**
 * v1.0.15: Persistence mount configuration
 */
export interface PersistenceMount {
  mountPath: string;
  subPath: string;
}

/**
 * v1.0.15: Workspace persistence configuration
 * Enables PVC-backed storage for browser profile, downloads, and workspace
 */
export interface PersistenceConfig {
  enabled: boolean;
  storageClass?: string;  // Default: 'longhorn'
  size?: string;          // Default: '10Gi'
  mounts?: PersistenceMount[];  // Default: chromium, downloads, workspace
  retainOnDelete?: boolean;     // Default: false
}

/**
 * Default persistence mounts for workspace continuity
 */
export const DEFAULT_PERSISTENCE_MOUNTS: PersistenceMount[] = [
  { mountPath: '/home/user/.config/chromium', subPath: 'chromium' },
  { mountPath: '/home/user/Downloads', subPath: 'downloads' },
  { mountPath: '/home/user/workspace', subPath: 'workspace' },
];

/**
 * TaskDesktop spec - desired state
 */
export interface TaskDesktopSpec {
  taskId: string;
  tenantId: string;
  // v1.0.15: Workspace ID for workflow mode (multiple tasks share one desktop)
  workspaceId?: string;
  tier?: 'starter' | 'professional' | 'enterprise';
  timeout?: string;
  warmPodSelector?: Record<string, string>;
  priority?: number;
  agentEndpoint?: string;
  artifactUpload?: {
    enabled?: boolean;
    bucket?: string;
    prefix?: string;
    includeScreenshots?: boolean;
    includeDownloads?: boolean;
  };
  // v1.0.15: Workspace persistence configuration
  persistence?: PersistenceConfig;
}

/**
 * TaskDesktop phase
 *
 * Phase transitions:
 * - Pending → WaitingForCapacity (when no warm pods available)
 * - Pending → Claiming (when warm pod found)
 * - WaitingForCapacity → Claiming (when pod becomes available)
 * - WaitingForCapacity → Failed (when capacity wait times out)
 * - Claiming → Assigned → Running → Finalizing → Completed/Failed
 */
export type TaskDesktopPhase =
  | 'Pending'
  | 'WaitingForCapacity'  // v1.0.9: Task waiting for overflow pool capacity
  | 'Claiming'
  | 'Assigned'
  | 'Running'
  | 'Finalizing'
  | 'Completed'
  | 'Failed'
  | 'Cancelled'
  | 'TimedOut';

/**
 * Condition type
 */
export type TaskDesktopConditionType =
  | 'PodClaimed'
  | 'PodReady'
  | 'TaskStarted'
  | 'TaskCompleted'
  | 'ArtifactsUploaded'
  | 'Finalized';

/**
 * Condition status
 */
export type ConditionStatus = 'True' | 'False' | 'Unknown';

/**
 * TaskDesktop condition
 */
export interface TaskDesktopCondition {
  type: TaskDesktopConditionType;
  status: ConditionStatus;
  lastTransitionTime?: string;
  reason?: string;
  message?: string;
}

/**
 * Artifact upload status
 */
export interface ArtifactUploadStatus {
  state: 'Pending' | 'InProgress' | 'Completed' | 'Failed' | 'Skipped';
  artifactCount?: number;
  totalSize?: string;
  completedAt?: string;
  error?: string;
}

/**
 * Credentials reference
 */
export interface TaskDesktopCredentials {
  secretName?: string;
  vncPassword?: string;
  apiToken?: string;
  tokenExpiresAt?: string;
  revoked?: boolean;
}

/**
 * State transition history entry
 */
export interface TaskDesktopHistoryEntry {
  timestamp: string;
  fromPhase: string;
  toPhase: string;
  reason?: string;
}

/**
 * TaskDesktop status - observed state
 */
export interface TaskDesktopStatus {
  phase?: TaskDesktopPhase;
  podName?: string;
  podIP?: string;
  podUID?: string;
  // v1.0.15: PVC name for workspace persistence
  pvcName?: string;
  desktopEndpoint?: string;
  vncEndpoint?: string;
  credentials?: TaskDesktopCredentials;
  assignedAt?: string;
  startedAt?: string;
  completedAt?: string;
  // v1.0.24: Timestamp when task entered terminal state (for TTL-based GC)
  finishedAt?: string;
  timeoutAt?: string;
  lastHeartbeat?: string;
  agentHeartbeat?: string;
  heartbeatMissedCount?: number;
  artifactUploadStatus?: ArtifactUploadStatus;
  message?: string;
  reason?: string;
  observedGeneration?: number;
  conditions?: TaskDesktopCondition[];
  retryCount?: number;
  history?: TaskDesktopHistoryEntry[];
  // v1.0.9: Capacity wait tracking for overflow pool support
  capacityWaitStartedAt?: string;  // When task entered WaitingForCapacity phase
  capacityWaitTimeoutAt?: string;  // When capacity wait will timeout
  // v1.0.10: Track which pool the pod came from
  poolType?: 'warm' | 'overflow';
}

/**
 * TaskDesktop custom resource
 */
export interface TaskDesktop {
  apiVersion: 'bytebot.ai/v1alpha1';
  kind: 'TaskDesktop';
  metadata: V1ObjectMeta;
  spec: TaskDesktopSpec;
  status?: TaskDesktopStatus;
}

/**
 * TaskDesktop list
 */
export interface TaskDesktopList {
  apiVersion: 'bytebot.ai/v1alpha1';
  kind: 'TaskDesktopList';
  metadata: {
    resourceVersion?: string;
    continue?: string;
  };
  items: TaskDesktop[];
}

/**
 * Database task model (matching Prisma schema)
 */
export type TaskPriorityEnum = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type TaskTypeEnum = 'IMMEDIATE' | 'SCHEDULED';
export type RoleEnum = 'USER' | 'ASSISTANT';
export type ExecutionSurfaceEnum = 'TEXT_ONLY' | 'DESKTOP';

export interface DatabaseTask {
  id: string;
  description: string;
  type: TaskTypeEnum;
  status: 'PENDING' | 'RUNNING' | 'NEEDS_HELP' | 'NEEDS_REVIEW' | 'COMPLETED' | 'CANCELLED' | 'FAILED';
  priority: TaskPriorityEnum;
  control: RoleEnum;
  // Execution surface contract (nullable override, non-null requiresDesktop)
  requiresDesktop: boolean;
  executionSurface?: ExecutionSurfaceEnum | null;
  model: unknown; // JSON field from Prisma
  version: number;
  createdAt: Date;
  updatedAt: Date;
  tenantId?: string;
}

/**
 * Controller configuration
 */
export interface ControllerConfig {
  leaderElection: {
    enabled: boolean;
    leaseName: string;
    leaseDuration: string;
    renewDeadline: string;
    retryPeriod: string;
  };
  database: {
    pollInterval: string;
    useNotify: boolean;
    batchSize: number;
  };
  warmPool: {
    namespace: string;
    selector: Record<string, string>;
    minWarm: number;
    maxWarm: number;
  };
  podClaiming: {
    timeout: string;
    maxRetries: number;
    retryDelay: string;
    fieldManager: string;
  };
  timeout: {
    default: string;
    maximum: string;
    checkInterval: string;
  };
  artifacts: {
    enabled: boolean;
    endpoint: string;
    bucket: string;
    timeout: string;
  };
  finalizer: {
    name: string;
    gracePeriod: string;
  };
}

/**
 * Pod claiming result
 */
export interface PodClaimResult {
  success: boolean;
  podName?: string;
  podIP?: string;
  podUID?: string;
  error?: string;
}

/**
 * v1.0.15: Workspace creation result
 */
export interface WorkspaceCreateResult {
  success: boolean;
  pvcName?: string;
  podName?: string;
  podIP?: string;
  podUID?: string;
  desktopEndpoint?: string;
  error?: string;
}

/**
 * Reconcile result
 */
export interface ReconcileResult {
  requeue: boolean;
  requeueAfter?: number; // milliseconds
  error?: Error;
}
