import {
  PrismaClient,
  Prisma,
  UserPromptCancelReason,
  UserPromptKind,
  UserPromptStatus,
  GoalRunPhase,
  ChecklistItemStatus,
} from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

type Args = {
  apply: boolean;
  dryRun: boolean;
  limit: number;
  tenantId?: string;
  goalRunId?: string;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    dryRun: true,
    limit: 200,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--apply') {
      args.apply = true;
      args.dryRun = false;
      continue;
    }
    if (token === '--dry-run') {
      args.apply = false;
      args.dryRun = true;
      continue;
    }
    if (token === '--limit') {
      const raw = argv[i + 1];
      i++;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --limit: ${raw}`);
      }
      args.limit = Math.floor(parsed);
      continue;
    }
    if (token === '--tenant-id') {
      args.tenantId = argv[i + 1];
      i++;
      continue;
    }
    if (token === '--goal-run-id') {
      args.goalRunId = argv[i + 1];
      i++;
      continue;
    }
    if (token === '--help' || token === '-h') {
      printHelpAndExit(0);
    }
  }

  return args;
}

function printHelpAndExit(code: number): never {
  // eslint-disable-next-line no-console
  console.log(`
Unstick strategy-derived prompts (AGENT_REQUESTED_HELP) by canceling them and resuming runs.

This is a one-time maintenance tool to clean up prompts created before the "no strategy prompts" fix.

Usage:
  ts-node scripts/unstick-strategy-prompts.ts [--dry-run] [--apply] [--limit N] [--tenant-id T] [--goal-run-id GR]

Defaults:
  --dry-run (prints planned changes, makes no DB writes)
  --limit 200

Notes:
  - Targets OPEN TEXT_CLARIFICATION prompts where payload.result.errorCode == "AGENT_REQUESTED_HELP"
  - Cancels prompt with cancelReason=POLICY_DENY
  - Unblocks checklist item if blocked by that prompt
  - Resumes goal run from WAITING_USER_INPUT to EXECUTING only if no other OPEN prompts remain
  - Enqueues one outbox event per cancelled prompt (dedupeKey=user_prompt.cancelled:<promptId>)
`.trim());
  process.exit(code);
}

type PromptRow = {
  id: string;
  tenantId: string;
  goalRunId: string;
  checklistItemId: string | null;
  kind: string;
  dedupeKey: string;
  payload: any;
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const prompts = (await prisma.userPrompt.findMany({
      where: {
        status: UserPromptStatus.OPEN,
        kind: UserPromptKind.TEXT_CLARIFICATION,
        ...(args.tenantId ? { tenantId: args.tenantId } : {}),
        ...(args.goalRunId ? { goalRunId: args.goalRunId } : {}),
        payload: {
          path: ['result', 'errorCode'],
          equals: 'AGENT_REQUESTED_HELP',
        },
      },
      orderBy: { createdAt: 'asc' },
      take: args.limit,
      select: {
        id: true,
        tenantId: true,
        goalRunId: true,
        checklistItemId: true,
        kind: true,
        dedupeKey: true,
        payload: true,
      },
    })) as unknown as PromptRow[];

    // eslint-disable-next-line no-console
    console.log(
      `[unstick-strategy-prompts] found ${prompts.length} prompts (dryRun=${args.dryRun}, limit=${args.limit})`,
    );

    if (prompts.length === 0) return;

    let cancelled = 0;
    let unblocked = 0;
    let resumed = 0;
    let outboxEnqueued = 0;

    for (const prompt of prompts) {
      const now = new Date();
      const outboxDedupeKey = `user_prompt.cancelled:${prompt.id}`;
      const stepTitle =
        typeof prompt.payload?.title === 'string'
          ? prompt.payload.title
          : typeof prompt.payload?.reason === 'string'
            ? prompt.payload.reason
            : null;

      if (args.dryRun) {
        // eslint-disable-next-line no-console
        console.log(
          `[dry-run] cancel prompt ${prompt.id} (goalRun=${prompt.goalRunId}, checklistItem=${prompt.checklistItemId ?? 'none'})`,
        );
        continue;
      }

      await prisma.$transaction(async (tx) => {
        const updatedPrompt = await tx.userPrompt.updateMany({
          where: { id: prompt.id, status: UserPromptStatus.OPEN },
          data: {
            status: UserPromptStatus.CANCELLED,
            cancelReason: UserPromptCancelReason.POLICY_DENY,
            cancelledAt: now,
          },
        });

        if (updatedPrompt.count > 0) {
          cancelled++;
        }

        if (prompt.checklistItemId) {
          const updatedItem = await tx.checklistItem.updateMany({
            where: {
              id: prompt.checklistItemId,
              status: ChecklistItemStatus.BLOCKED,
              blockedByPromptId: prompt.id,
            },
            data: {
              status: ChecklistItemStatus.PENDING,
              blockedByPromptId: null,
              blockedReason: null,
              blockedAt: null,
            },
          });

          if (updatedItem.count > 0) {
            unblocked++;
          }
        }

        const remainingOpen = await tx.userPrompt.count({
          where: { goalRunId: prompt.goalRunId, status: UserPromptStatus.OPEN },
        });

        if (remainingOpen === 0) {
          const updatedRun = await tx.goalRun.updateMany({
            where: { id: prompt.goalRunId, phase: GoalRunPhase.WAITING_USER_INPUT },
            data: {
              phase: GoalRunPhase.EXECUTING,
              waitReason: null,
              waitDetail: Prisma.DbNull,
              waitStartedAt: null,
              waitUntil: null,
            },
          });
          if (updatedRun.count > 0) resumed++;
        }

        try {
          await tx.outbox.create({
            data: {
              id: createId(),
              dedupeKey: outboxDedupeKey,
              aggregateId: prompt.goalRunId,
              eventType: 'user_prompt.cancelled',
              payload: {
                promptId: prompt.id,
                tenantId: prompt.tenantId,
                goalRunId: prompt.goalRunId,
                checklistItemId: prompt.checklistItemId,
                kind: prompt.kind,
                stepDescription: stepTitle,
                cancelReason: 'POLICY_DENY',
                cancelledAt: now.toISOString(),
                reason: {
                  code: 'DEPRECATED_STRATEGY_PROMPT',
                  message:
                    'Canceled a strategy-derived prompt created before the no-strategy-prompts contract fix.',
                },
              },
            },
          });
          outboxEnqueued++;
        } catch (error: any) {
          // Idempotency: ignore unique dedupe constraint.
          if (error?.code !== 'P2002') throw error;
        }
      });
    }

    // eslint-disable-next-line no-console
    console.log(
      `[unstick-strategy-prompts] cancelled=${cancelled} unblocked=${unblocked} resumed=${resumed} outbox=${outboxEnqueued}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`[unstick-strategy-prompts] fatal: ${error?.message || error}`);
  process.exit(1);
});
