import { NotificationController } from './notification.controller';
import { SlackEventType } from '../services/slack-notification.service';

describe('NotificationController', () => {
  it('returns event types that match server-side validation (SlackEventType values)', () => {
    const controller = new NotificationController({} as any, {} as any, {} as any);
    const result = controller.getEventTypes();

    expect(result.success).toBe(true);
    expect(Array.isArray(result.events)).toBe(true);

    const types = result.events.map((e: any) => e.type);
    expect(types).toContain(SlackEventType.GOAL_STARTED);
    expect(types).toContain(SlackEventType.USER_PROMPT_CREATED);
    expect(types).not.toContain('GOAL_STARTED');
  });
});

