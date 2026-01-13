import { PlannerService } from './planner.service';
import { StepType } from '@prisma/client';
import { PlannerFirstStepUserInputError } from './planner.errors';
import { ExecuteStepHasInteractionToolError, UnknownSuggestedToolTokenError } from '../contracts/planner-tools';

describe('PlannerService no USER_INPUT_REQUIRED first step', () => {
  const makeService = () => {
    const prisma = {} as any;
    const goalRunService = {} as any;
    const configService = {
      get: jest.fn((_key: string, fallback: any) => fallback),
    } as any;
    return new PlannerService(prisma, goalRunService, configService);
  };

  it('rejects prompt-first output when the LLM returns USER_INPUT_REQUIRED as step 1', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Ask the user for the fire-drill codeword',
            type: StepType.USER_INPUT_REQUIRED,
            expectedOutcome: 'User provides codeword',
            suggestedTools: ['ASK_USER'],
            requiresDesktop: false,
          },
          {
            description: 'Validate codeword',
            type: StepType.EXECUTE,
            expectedOutcome: 'Codeword validated',
            suggestedTools: ['Shell'],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    await expect((service as any).callLLMForPlan('Fire drill', {})).rejects.toBeInstanceOf(
      PlannerFirstStepUserInputError,
    );
  });

  it('rejects prompt-first output when step 1 is EXECUTE but has suggestedTools=["ASK_USER"]', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Clarify target URL with the user',
            type: StepType.EXECUTE,
            expectedOutcome: 'URL clarified',
            suggestedTools: ['ASK_USER'],
            requiresDesktop: false,
          },
          {
            description: 'Proceed with task',
            type: StepType.EXECUTE,
            expectedOutcome: 'Task progressed',
            suggestedTools: [],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    const promise = (service as any).callLLMForPlan('Do the thing', {});
    await expect(promise).rejects.toBeInstanceOf(PlannerFirstStepUserInputError);

    await promise.catch((error: PlannerFirstStepUserInputError) => {
      expect(error.reason).toBe('ASK_USER_TOOL');
    });
  });

  it('rejects prompt-first output when step 1 is EXECUTE but has suggestedTools=["CHAT"]', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Prompt the user to provide the missing inputs',
            type: StepType.EXECUTE,
            expectedOutcome: 'Inputs provided',
            suggestedTools: ['CHAT'],
            requiresDesktop: false,
          },
          {
            description: 'Proceed with task',
            type: StepType.EXECUTE,
            expectedOutcome: 'Task progressed',
            suggestedTools: [],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    const promise = (service as any).callLLMForPlan('Do the thing', {});
    await expect(promise).rejects.toBeInstanceOf(PlannerFirstStepUserInputError);

    await promise.catch((error: PlannerFirstStepUserInputError) => {
      expect(error.reason).toBe('ASK_USER_TOOL');
    });
  });

  it('rejects prompt-first replans (so the orchestrator can convert to GOAL_INTAKE)', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Ask the user for missing required details',
            type: StepType.USER_INPUT_REQUIRED,
            expectedOutcome: 'User provides details',
            suggestedTools: ['ASK_USER'],
            requiresDesktop: false,
          },
          {
            description: 'Proceed with task',
            type: StepType.EXECUTE,
            expectedOutcome: 'Task progressed',
            suggestedTools: [],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    await expect(
      (service as any).callLLMForReplan(
        'Do stuff',
        {},
        { checklistItems: [] },
        'Need more info',
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(PlannerFirstStepUserInputError);
  });

  it('rejects plan output when a non-first EXECUTE step contains an interaction tool token', async () => {
    const service = makeService();
    const llm = jest.spyOn(service as any, 'callLLM');

    llm.mockResolvedValue(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Do step 1',
            type: StepType.EXECUTE,
            expectedOutcome: 'Step 1 done',
            suggestedTools: [],
            requiresDesktop: false,
          },
          {
            description: 'Ask the user for clarification',
            type: StepType.EXECUTE, // misclassified
            expectedOutcome: 'User clarified',
            suggestedTools: ['ASK_USER'],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    await expect((service as any).callLLMForPlan('Do the thing', {})).rejects.toBeInstanceOf(
      ExecuteStepHasInteractionToolError,
    );
    expect(llm).toHaveBeenCalled();
  });

  it('rejects plan output when suggestedTools contains an unknown tool token (fail-closed)', async () => {
    const service = makeService();
    const llm = jest.spyOn(service as any, 'callLLM');

    llm.mockResolvedValue(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Do step 1',
            type: StepType.EXECUTE,
            expectedOutcome: 'Step 1 done',
            suggestedTools: ['totally_not_a_real_tool'],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    await expect((service as any).callLLMForPlan('Do the thing', {})).rejects.toBeInstanceOf(
      UnknownSuggestedToolTokenError,
    );
    expect(llm).toHaveBeenCalled();
  });
});
