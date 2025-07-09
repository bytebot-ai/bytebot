import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { sendEvent } from '@getlumen/server';

export interface LumenEventData {
  name: string;
  userId?: string;
  value: string;
}

@Injectable()
export class LumenService {
  private readonly logger = new Logger(LumenService.name);
  private readonly lumenApiKey: string | undefined;
  private readonly lumenApiUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.lumenApiKey = this.configService.get<string>('LUMEN_API_KEY');
    this.lumenApiUrl =
      this.configService.get<string>('LUMEN_API_URL') ||
      'https://api.getlumen.dev';

    if (!this.lumenApiKey) {
      this.logger.warn(
        'LUMEN_API_KEY is not set. Lumen event logging will be disabled.',
      );
    }
  }

  async sendEvent(eventData: LumenEventData): Promise<void> {
    if (!this.lumenApiKey) {
      this.logger.debug('Lumen API key not configured, skipping event send');
      return;
    }

    try {
      await sendEvent({
        name: eventData.name,
        userId: eventData.userId || `bytebot-agent-${process.env.HOSTNAME}`,
        value: eventData.value,
        apiUrl: this.lumenApiUrl,
        apiKey: this.lumenApiKey,
      });

      this.logger.debug(`Lumen event sent successfully: ${eventData.name}`);
    } catch (error) {
      this.logger.error('Error sending Lumen event:', error);
    }
  }

  async sendApiUsageEvent(
    provider: string,
    usageData: any,
    additionalData?: Record<string, any>,
  ): Promise<void> {
    // Combine usage data with additional data for the event value
    const eventValue = additionalData
      ? JSON.stringify({ ...usageData, ...additionalData })
      : JSON.stringify(usageData);

    await this.sendEvent({
      name: `${provider}-api-call`,
      value: eventValue,
    });
  }

  isConfigured(): boolean {
    return !!this.lumenApiKey;
  }
}
