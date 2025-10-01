import { Controller, Get, Param, Post } from '@nestjs/common';
import { ProviderManagerService, ProviderConfig } from './provider-manager.service';
import { BytebotAgentModel } from '../agent/agent.types';

@Controller('providers')
export class ProvidersController {
  constructor(private readonly providerManager: ProviderManagerService) {}

  @Get()
  getProviders(): ProviderConfig[] {
    return this.providerManager.getAvailableProviders();
  }

  @Get('enabled')
  getEnabledProviders(): ProviderConfig[] {
    return this.providerManager.getEnabledProviders();
  }

  @Get('models')
  getAllModels(): BytebotAgentModel[] {
    return this.providerManager.getAllAvailableModels();
  }

  @Get(':providerId/models')
  getProviderModels(@Param('providerId') providerId: string): BytebotAgentModel[] {
    return this.providerManager.getModelsForProvider(providerId);
  }

  @Get('default-model')
  getDefaultModel(): BytebotAgentModel | null {
    return this.providerManager.getDefaultModel();
  }

  @Post(':providerId/test')
  async testProvider(@Param('providerId') providerId: string): Promise<{ success: boolean }> {
    const success = await this.providerManager.testProvider(providerId);
    return { success };
  }

  @Post('refresh')
  refreshProviders(): { success: boolean } {
    this.providerManager.refreshProviderStatus();
    return { success: true };
  }
}