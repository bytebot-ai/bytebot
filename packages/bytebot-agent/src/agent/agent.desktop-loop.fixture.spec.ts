import * as fs from 'node:fs';
import * as path from 'node:path';

import { MessageContentType } from '@bytebot/shared';
import {
  DesktopLoopDetector,
  buildDesktopActionSignature,
} from './agent.desktop-safety';

type FixtureRow = {
  tool: string;
  coordinates?: { x: number; y: number };
  button?: string;
  clickCount?: number;
  screenshotHash: string;
};

describe('desktop loop detector fixture replay', () => {
  it('replays the Google Flights modal stall fixture and trips quickly', () => {
    const fixturePath = path.join(
      __dirname,
      'fixtures',
      'desktop-loop-google-flights.jsonl',
    );
    const lines = fs
      .readFileSync(fixturePath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

    const detector = new DesktopLoopDetector();

    let lastResult: ReturnType<DesktopLoopDetector['record']> | null = null;
    let steps = 0;

    for (const line of lines) {
      const row = JSON.parse(line) as FixtureRow;
      steps++;

      const block: any = {
        type: MessageContentType.ToolUse,
        id: `fx-${steps}`,
        name: row.tool,
        input: {},
      };

      if (row.coordinates) {
        block.input.coordinates = row.coordinates;
      }
      if (row.tool === 'computer_click_mouse') {
        block.input.button = row.button || 'left';
        block.input.clickCount = row.clickCount || 1;
      }

      const signature = buildDesktopActionSignature(block);
      lastResult = detector.record({
        atMs: Date.now(),
        signature,
        screenshotHash: row.screenshotHash,
      });

      if (lastResult.interrupt) break;
    }

    expect(lastResult?.interrupt).toBe(true);
    expect(lastResult?.rule).toBe('repeat_in_window_no_progress');
    expect(steps).toBeLessThanOrEqual(12);
  });
});
