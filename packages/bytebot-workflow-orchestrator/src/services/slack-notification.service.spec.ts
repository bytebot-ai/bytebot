import { SlackNotificationService, SlackEventType } from './slack-notification.service';

type PrismaMock = {
  notificationChannel: { findMany: jest.Mock };
  notificationDelivery: { create: jest.Mock };
};

describe('SlackNotificationService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  function makeService(options: {
    botToken?: string;
    channels: Array<{ id: string; config: any }>;
  }): { service: SlackNotificationService; prisma: PrismaMock } {
    const prisma: PrismaMock = {
      notificationChannel: {
        findMany: jest.fn(async () =>
          options.channels.map((c) => ({
            id: c.id,
            tenantId: 't1',
            type: 'SLACK',
            enabled: true,
            events: [SlackEventType.GOAL_STARTED],
            config: c.config,
          })),
        ),
      },
      notificationDelivery: {
        create: jest.fn(async () => ({})),
      },
    };

    const configService = {
      get: jest.fn((key: string, fallback?: any) => {
        switch (key) {
          case 'APP_BASE_URL':
            return 'https://app.bytebot.ai';
          case 'SLACK_TIMEOUT_MS':
            return '1000';
          case 'SLACK_BOT_TOKEN':
            return options.botToken ?? '';
          case 'SLACK_CHANNEL_LOOKUP_TTL_MS':
            return '';
          case 'SLACK_CHANNEL_LOOKUP_MAX_PAGES':
            return '';
          case 'SLACK_REPLY_IN_SLACK_ENABLED':
            return 'false';
          case 'SLACK_SIGNING_SECRET':
            return '';
          default:
            return fallback ?? '';
        }
      }),
    } as any;

    return {
      service: new SlackNotificationService(prisma as any, configService),
      prisma,
    };
  }

  it('delivers via webhook when webhookUrl is configured', async () => {
    const webhookUrl = 'https://hooks.slack.test/services/T00000000/B00000000/XXXX';
    const fetchMock = jest.fn(async () => ({ ok: true, status: 200, text: async () => 'ok' })) as any;
    global.fetch = fetchMock;

    const { service } = makeService({
      channels: [
        {
          id: 'c1',
          config: { webhookUrl },
        },
      ],
    });

    const results = await service.sendGoalNotification(SlackEventType.GOAL_STARTED, {
      goalRunId: 'gr1',
      tenantId: 't1',
      goal: 'test',
      status: 'STARTED',
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      webhookUrl,
      expect.objectContaining({ method: 'POST', headers: expect.any(Object) }),
    );
  });

  it('delivers via bot token when webhookUrl is not configured and channelId is provided', async () => {
    const fetchMock = jest.fn(async (_url: string, _init: any) => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      headers: new Map(),
    })) as any;
    global.fetch = fetchMock;

    const { service } = makeService({
      botToken: 'xoxb-test',
      channels: [
        {
          id: 'c1',
          config: { channelId: 'C1234567890' },
        },
      ],
    });

    const results = await service.sendGoalNotification(SlackEventType.GOAL_STARTED, {
      goalRunId: 'gr1',
      tenantId: 't1',
      goal: 'test',
      status: 'STARTED',
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://slack.com/api/chat.postMessage');
    expect(init.headers.Authorization).toBe('Bearer xoxb-test');
    const body = JSON.parse(init.body);
    expect(body.channel).toBe('C1234567890');
  });

  it('resolves #channel names via conversations.list and caches results', async () => {
    const fetchMock = jest.fn(async (url: string, init: any) => {
      if (url.startsWith('https://slack.com/api/conversations.list')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ok: true,
            channels: [{ id: 'C999', name: 'butler-vantage' }],
            response_metadata: { next_cursor: '' },
          }),
        };
      }
      if (url === 'https://slack.com/api/chat.postMessage') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true }),
          headers: new Map(),
        };
      }
      throw new Error(`unexpected fetch url: ${url}`);
    }) as any;
    global.fetch = fetchMock;

    const { service } = makeService({
      botToken: 'xoxb-test',
      channels: [
        {
          id: 'c1',
          config: { channel: '#butler-vantage' },
        },
      ],
    });

    await service.sendGoalNotification(SlackEventType.GOAL_STARTED, {
      goalRunId: 'gr1',
      tenantId: 't1',
      goal: 'test',
      status: 'STARTED',
    });
    await service.sendGoalNotification(SlackEventType.GOAL_STARTED, {
      goalRunId: 'gr2',
      tenantId: 't1',
      goal: 'test2',
      status: 'STARTED',
    });

    // First send does lookup + post; second send should reuse cache and only post.
    const calls = fetchMock.mock.calls as unknown as Array<[string, any]>;
    expect(calls.filter((call) => String(call[0]).includes('conversations.list'))).toHaveLength(1);
    expect(calls.filter((call) => call[0] === 'https://slack.com/api/chat.postMessage')).toHaveLength(2);
  });

  it('fails bot-based delivery when SLACK_BOT_TOKEN is missing', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;

    const { service } = makeService({
      botToken: '',
      channels: [
        {
          id: 'c1',
          config: { channelId: 'C1234567890' },
        },
      ],
    });

    const results = await service.sendGoalNotification(SlackEventType.GOAL_STARTED, {
      goalRunId: 'gr1',
      tenantId: 't1',
      goal: 'test',
      status: 'STARTED',
    });

    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toContain('Missing SLACK_BOT_TOKEN');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
