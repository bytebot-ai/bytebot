import { MessageContentType } from '@bytebot/shared';

function makeFakePngBase64(width: number, height: number): string {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8); // IHDR length
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  return buffer.toString('base64');
}

describe('desktop UI repair ladder fixture replay', () => {
  it('runs Esc once, then a single close-click, then escalates to takeover (bounded)', async () => {
    jest.resetModules();

    process.env.BYTEBOT_DESKTOP_LOOP_REPAIR_ENABLED = 'true';
    process.env.BYTEBOT_DESKTOP_LOOP_REPAIR_ATTEMPT2_ENABLED = 'true';
    process.env.BYTEBOT_DESKTOP_LOOP_REPAIR_ATTEMPT2_MIN_CONFIDENCE = '0.7';

    const screenshotBase64 = makeFakePngBase64(100, 100);
    const actionHashes = {
      before: 'ffffffffffffffff',
      after: 'ffffffffffffffff', // unchanged => no progress
    };

    const toolCalls: Record<string, number> = {
      computer_type_keys: 0,
      computer_screenshot: 0,
      computer_click_mouse: 0,
    };

    jest.doMock('./agent.computer-use', () => {
      const actual = jest.requireActual('./agent.computer-use');
      return {
        ...actual,
        resetDesktopInput: jest.fn(async () => undefined),
        handleComputerToolUse: jest.fn(
          async (block: any, _logger: any, ctx: any) => {
            toolCalls[block.name] = (toolCalls[block.name] || 0) + 1;

            const screenshotHash = actionHashes.after;
            ctx?.onAction?.({
              actionType: block.name,
              success: true,
              durationMs: 1,
              coordinates: block?.input?.coordinates,
              actionSignature: `${block.name}`,
              screenshotHash,
              screenshotCaptured: true,
            });

            const imageBlock = {
              type: MessageContentType.Image,
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: screenshotBase64,
              },
            };

            if (block.name === 'computer_screenshot') {
              return {
                type: MessageContentType.ToolResult,
                tool_use_id: block.id,
                content: [imageBlock],
              };
            }

            return {
              type: MessageContentType.ToolResult,
              tool_use_id: block.id,
              content: [
                { type: MessageContentType.Text, text: 'ok' },
                imageBlock,
              ],
            };
          },
        ),
      };
    });

    const { AgentProcessor } = await import('./agent.processor');

    const eventEmitter = { emit: jest.fn() } as any;

    const processor = new AgentProcessor(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { isPhase6Enabled: () => false } as any,
      {} as any,
      { isWorkspaceEnabled: () => false } as any,
      eventEmitter,
    ) as any;

    processor.lastScreenshotHash = actionHashes.before;

    const generatedToolResults: any[] = [];

    const service = {
      generateMessage: jest.fn(async () => {
        return {
          contentBlocks: [
            {
              type: MessageContentType.Text,
              text: JSON.stringify({
                x: 90,
                y: 10,
                confidence: 0.9,
                rationale_code: 'CLOSE_X',
              }),
            },
          ],
        };
      }),
    } as any;

    const model = { name: 'desktop-vision' } as any;

    const actionContext: any = {
      taskId: 't-1',
      desktopUrl: 'http://desktop',
      onAction: (action: any) => {
        processor.handleDesktopSafetyAction(action);
      },
    };

    const callRepair = () =>
      processor.performDesktopUiRepair({
        taskId: 't-1',
        desktopUrl: 'http://desktop',
        actionContext,
        trigger: 'loop',
        service,
        model,
        generatedToolResults,
      });

    const res1 = await callRepair();
    expect(res1.shortCircuitReason).toBe('ui_repair_esc');
    expect(toolCalls.computer_type_keys).toBe(1);

    const res2 = await callRepair();
    expect(res2.shortCircuitReason).toBe('takeover_required');
    expect(toolCalls.computer_screenshot).toBe(1);
    expect(toolCalls.computer_click_mouse).toBe(1);
    expect(service.generateMessage).toHaveBeenCalledTimes(1);

    expect(processor.pendingDesktopNeedsHelp).toMatchObject({
      errorCode: 'DESKTOP_TAKEOVER_REQUIRED',
      details: {
        reason: 'UI_BLOCKED_POPUP',
        loop: expect.objectContaining({ trigger: 'loop' }),
        repair: expect.objectContaining({
          attempt1: 'esc',
          attempt2: 'failed',
        }),
      },
    });

    // Re-entry safety: do not run repairs again in the same episode once takeover is required.
    const res3 = await callRepair();
    expect(res3.shortCircuitReason).toBe('takeover_required');
    expect(toolCalls.computer_type_keys).toBe(1);
    expect(toolCalls.computer_screenshot).toBe(1);
    expect(toolCalls.computer_click_mouse).toBe(1);
    expect(service.generateMessage).toHaveBeenCalledTimes(1);

    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'desktop.ui_repair.attempt',
      expect.objectContaining({ attempt: 'esc', trigger: 'loop' }),
    );
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      'desktop.ui_repair.attempt',
      expect.objectContaining({ attempt: 'close_click', trigger: 'loop' }),
    );
  });
});
