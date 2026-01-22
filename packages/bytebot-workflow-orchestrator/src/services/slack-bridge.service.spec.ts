import { SlackBridgeService } from './slack-bridge.service';
import { createHmac } from 'crypto';

describe('SlackBridgeService', () => {
  function makeService(options: {
    signingSecret: string;
    botToken?: string;
    enabled?: string;
    interactivityTimeoutMs?: string;
    userPromptResolutionService?: { resolvePrompt: jest.Mock };
  }): SlackBridgeService {
    const configService = {
      get: jest.fn((key: string) => {
        switch (key) {
          case 'SLACK_SIGNING_SECRET':
            return options.signingSecret;
          case 'SLACK_BOT_TOKEN':
            return options.botToken || '';
          case 'SLACK_REPLY_IN_SLACK_ENABLED':
            return options.enabled ?? 'true';
          case 'SLACK_INTERACTIVITY_TIMEOUT_MS':
            return options.interactivityTimeoutMs ?? '';
          default:
            return '';
        }
      }),
    } as any;

    const userPromptResolutionService = (options.userPromptResolutionService ??
      ({
        resolvePrompt: jest.fn(),
      } as any)) as any;

    return new SlackBridgeService(configService, userPromptResolutionService);
  }

  it('is disabled unless enabled flag + signing secret + bot token are configured', () => {
    const serviceMissingToken = makeService({ signingSecret: 'secret', enabled: 'true', botToken: '' });
    expect(serviceMissingToken.isEnabled()).toBe(false);

    const serviceMissingSecret = makeService({ signingSecret: '', enabled: 'true', botToken: 'xoxb-test' });
    expect(serviceMissingSecret.isEnabled()).toBe(false);

    const serviceDisabled = makeService({ signingSecret: 'secret', enabled: 'false', botToken: 'xoxb-test' });
    expect(serviceDisabled.isEnabled()).toBe(false);

    const serviceEnabled = makeService({ signingSecret: 'secret', enabled: 'true', botToken: 'xoxb-test' });
    expect(serviceEnabled.isEnabled()).toBe(true);
  });

  it('verifies Slack signatures for valid requests', () => {
    const signingSecret = 'test_signing_secret';
    const service = makeService({ signingSecret, botToken: 'xoxb-test' });

    const rawBody = 'payload=%7B%22hello%22%3A%22world%22%7D';
    const timestamp = '1700000000';
    const base = `v0:${timestamp}:${rawBody}`;
    const digest = createHmac('sha256', signingSecret).update(base, 'utf8').digest('hex');
    const signature = `v0=${digest}`;

    expect(
      service.verifySlackRequest({
        rawBody,
        signature,
        timestamp,
        nowMs: parseInt(timestamp, 10) * 1000,
      }),
    ).toBe(true);
  });

  it('rejects stale Slack timestamps (replay protection)', () => {
    const signingSecret = 'test_signing_secret';
    const service = makeService({ signingSecret, botToken: 'xoxb-test' });

    const rawBody = 'payload=test';
    const timestamp = '1700000000';
    const base = `v0:${timestamp}:${rawBody}`;
    const digest = createHmac('sha256', signingSecret).update(base, 'utf8').digest('hex');
    const signature = `v0=${digest}`;

    expect(
      service.verifySlackRequest({
        rawBody,
        signature,
        timestamp,
        nowMs: (parseInt(timestamp, 10) + 60 * 10) * 1000,
      }),
    ).toBe(false);
  });

  it('clears the view submission even if prompt resolution exceeds the handler timeout', async () => {
    const resolvePrompt = jest.fn(
      () =>
        new Promise((_resolve) => {
          // Never resolves (simulate slow DB / downstream)
        }),
    );

    const service = makeService({
      signingSecret: 'secret',
      botToken: 'xoxb-test',
      enabled: 'true',
      interactivityTimeoutMs: '5',
      userPromptResolutionService: { resolvePrompt },
    });

    const startedAt = Date.now();
    const result = await service.handleInteractivity({
      type: 'view_submission',
      user: { id: 'U1' },
      team: { id: 'T1' },
      view: {
        id: 'V1',
        private_metadata: JSON.stringify({ promptId: 'p1', tenantId: 't1', kind: 'TEXT_CLARIFICATION' }),
        state: { values: { answer_block: { answer: { type: 'plain_text_input', value: 'hello' } } } },
      },
    } as any);

    expect(resolvePrompt).toHaveBeenCalled();
    expect(result).toEqual({ response_action: 'clear' });
    expect(Date.now() - startedAt).toBeLessThan(200);
  });
});
