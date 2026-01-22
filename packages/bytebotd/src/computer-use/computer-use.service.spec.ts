import { PNG } from 'pngjs';

jest.mock('../nut/nut.service', () => ({
  NutService: class NutService {},
}));

const { ComputerUseService } =
  require('./computer-use.service') as typeof import('./computer-use.service');

describe('ComputerUseService (input safety)', () => {
  afterEach(() => {
    jest.useRealTimers();
    delete process.env.BYTEBOT_INPUT_DEADMAN_MS;
  });

  it('treats non-modifier press_keys down as a tap (sendKeys)', async () => {
    const nutService: any = {
      holdKeys: jest.fn().mockResolvedValue({ success: true }),
      sendKeys: jest.fn().mockResolvedValue({ success: true }),
      mouseMoveEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseClickEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseButtonEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseWheelEvent: jest.fn().mockResolvedValue({ success: true }),
      typeText: jest.fn().mockResolvedValue(undefined),
      pasteText: jest.fn().mockResolvedValue(undefined),
      screendump: jest.fn().mockResolvedValue(Buffer.alloc(0)),
      getCursorPosition: jest.fn().mockResolvedValue({ x: 0, y: 0 }),
    };

    const service = new ComputerUseService(nutService);

    await service.action({ action: 'press_keys', keys: ['Enter'], press: 'down' } as any);

    expect(nutService.sendKeys).toHaveBeenCalledWith(['Enter'], 75);
    expect(nutService.holdKeys).not.toHaveBeenCalledWith(['Enter'], true);
  });

  it('auto-releases modifier holds via deadman', async () => {
    jest.useFakeTimers();
    process.env.BYTEBOT_INPUT_DEADMAN_MS = '50';

    const nutService: any = {
      holdKeys: jest.fn().mockResolvedValue({ success: true }),
      sendKeys: jest.fn().mockResolvedValue({ success: true }),
      mouseMoveEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseClickEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseButtonEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseWheelEvent: jest.fn().mockResolvedValue({ success: true }),
      typeText: jest.fn().mockResolvedValue(undefined),
      pasteText: jest.fn().mockResolvedValue(undefined),
      screendump: jest.fn().mockResolvedValue(Buffer.alloc(0)),
      getCursorPosition: jest.fn().mockResolvedValue({ x: 0, y: 0 }),
    };

    const service = new ComputerUseService(nutService);

    await service.action({ action: 'press_keys', keys: ['Shift'], press: 'down' } as any);

    expect(nutService.holdKeys).toHaveBeenCalledWith(['Shift'], true);

    await jest.advanceTimersByTimeAsync(60);

    expect(nutService.holdKeys).toHaveBeenCalledWith(['Shift'], false);
  });

  it('resetInput releases stuck mouse buttons', async () => {
    jest.useFakeTimers();
    process.env.BYTEBOT_INPUT_DEADMAN_MS = '1000';

    const nutService: any = {
      holdKeys: jest.fn().mockResolvedValue({ success: true }),
      sendKeys: jest.fn().mockResolvedValue({ success: true }),
      mouseMoveEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseClickEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseButtonEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseWheelEvent: jest.fn().mockResolvedValue({ success: true }),
      typeText: jest.fn().mockResolvedValue(undefined),
      pasteText: jest.fn().mockResolvedValue(undefined),
      screendump: jest.fn().mockResolvedValue(Buffer.alloc(0)),
      getCursorPosition: jest.fn().mockResolvedValue({ x: 0, y: 0 }),
    };

    const service = new ComputerUseService(nutService);

    await service.action({ action: 'press_mouse', button: 'left', press: 'down' } as any);

    const result = await service.resetInput();

    expect(nutService.mouseButtonEvent).toHaveBeenCalledWith('left', false);
    expect(result.releasedButtons).toContain('left');
  });

  it('includes imageHash in screenshot response when possible', async () => {
    const png = new PNG({ width: 32, height: 32 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 10;
      png.data[i + 1] = 20;
      png.data[i + 2] = 30;
      png.data[i + 3] = 255;
    }
    const buf = PNG.sync.write(png);

    const nutService: any = {
      holdKeys: jest.fn().mockResolvedValue({ success: true }),
      sendKeys: jest.fn().mockResolvedValue({ success: true }),
      mouseMoveEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseClickEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseButtonEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseWheelEvent: jest.fn().mockResolvedValue({ success: true }),
      typeText: jest.fn().mockResolvedValue(undefined),
      pasteText: jest.fn().mockResolvedValue(undefined),
      screendump: jest.fn().mockResolvedValue(buf),
      getCursorPosition: jest.fn().mockResolvedValue({ x: 0, y: 0 }),
    };

    const service = new ComputerUseService(nutService);

    const res = await service.action({ action: 'screenshot' } as any);

    expect(typeof res.image).toBe('string');
    expect(res.image.length).toBeGreaterThan(0);
    expect(res.imageHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reports capabilities for handshake', () => {
    const nutService: any = {
      holdKeys: jest.fn().mockResolvedValue({ success: true }),
      sendKeys: jest.fn().mockResolvedValue({ success: true }),
      mouseMoveEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseClickEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseButtonEvent: jest.fn().mockResolvedValue({ success: true }),
      mouseWheelEvent: jest.fn().mockResolvedValue({ success: true }),
      typeText: jest.fn().mockResolvedValue(undefined),
      pasteText: jest.fn().mockResolvedValue(undefined),
      screendump: jest.fn().mockResolvedValue(Buffer.alloc(0)),
      getCursorPosition: jest.fn().mockResolvedValue({ x: 0, y: 0 }),
    };

    const service = new ComputerUseService(nutService);
    const caps = service.getCapabilities();

    expect(caps.resetInput).toBe(true);
    expect(caps.screenshotHash).toBe(true);
    expect(caps.inputDeadmanMs).toBeGreaterThan(0);
    expect(caps.supportedActions).toContain('press_keys');
    expect(caps.supportedActions).toContain('screenshot');
  });
});
