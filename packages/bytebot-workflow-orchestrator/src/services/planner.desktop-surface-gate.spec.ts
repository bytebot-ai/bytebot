import { PlannerService } from './planner.service';
import { StepType } from '@prisma/client';

describe('PlannerService desktop surface feasibility gate', () => {
  const makeService = () => {
    const prisma = {} as any;
    const goalRunService = {} as any;
    const configService = {
      get: jest.fn((_key: string, fallback: any) => fallback),
    } as any;
    return new PlannerService(prisma, goalRunService, configService);
  };

  it('sets requiresDesktop=true when suggestedTools include desktop execution tools', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Open a website in the browser',
            type: StepType.EXECUTE,
            expectedOutcome: 'Website loaded',
            suggestedTools: ['browser'],
            requiresDesktop: false,
          },
          {
            description: 'Verify page loaded',
            type: StepType.EXECUTE,
            expectedOutcome: 'Page verified',
            suggestedTools: ['screenshot'],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    const output = await (service as any).callLLMForPlan('Open site', {});
    expect(output.items[0].requiresDesktop).toBe(true);
    expect(output.items[1].requiresDesktop).toBe(true);
  });

  it('does not force requiresDesktop=true for non-desktop tools', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Parse a document',
            type: StepType.EXECUTE,
            expectedOutcome: 'Document parsed',
            suggestedTools: ['document_parse'],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    const output = await (service as any).callLLMForPlan('Parse doc', {});
    expect(output.items[0].requiresDesktop).toBe(false);
  });

  it('forces DESKTOP feasibility for travel-shopping goals even when planner omits tools', async () => {
    const service = makeService();

    jest.spyOn(service as any, 'callLLM').mockResolvedValueOnce(
      JSON.stringify({
        summary: 'test',
        items: [
          {
            description: 'Search for round-trip flights from DTW to LAS for Feb 21-28',
            type: StepType.EXECUTE,
            expectedOutcome: 'Top flight options collected',
            suggestedTools: [],
            requiresDesktop: false,
          },
          {
            description: 'Search for hotels in Las Vegas for the same dates',
            type: StepType.EXECUTE,
            expectedOutcome: 'Top hotel options collected',
            suggestedTools: [],
            requiresDesktop: false,
          },
        ],
        confidence: 0.9,
      }),
    );

    const output = await (service as any).callLLMForPlan(
      'Please price a trip with flight and hotel from Detroit to Las Vegas Feb 21-28',
      {},
    );

    expect(output.items[0].requiresDesktop).toBe(true);
    expect(output.items[0].suggestedTools).toContain('browser');
    expect(output.items[1].requiresDesktop).toBe(true);
    expect(output.items[1].suggestedTools).toContain('browser');
  });
});
