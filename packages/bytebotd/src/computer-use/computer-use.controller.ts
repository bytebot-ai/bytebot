import {
  Controller,
  Get,
  Post,
  Body,
  Logger,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { ComputerUseService } from './computer-use.service';
import { ComputerActionValidationPipe } from './dto/computer-action-validation.pipe';
import { ComputerActionDto } from './dto/computer-action.dto';

@Controller('computer-use')
export class ComputerUseController {
  private readonly logger = new Logger(ComputerUseController.name);

  constructor(private readonly computerUseService: ComputerUseService) {}

  @Get('capabilities')
  capabilities() {
    return this.computerUseService.getCapabilities();
  }

  @Post('reset-input')
  async resetInput() {
    try {
      this.logger.log('Reset input request');
      return await this.computerUseService.resetInput();
    } catch (error: any) {
      this.logger.error(
        `Error resetting input: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        `Failed to reset input: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post()
  async action(
    @Body(new ComputerActionValidationPipe()) params: ComputerActionDto,
  ) {
    try {
      // don't log base64 data
      const paramsCopy = { ...params };
      if (paramsCopy.action === 'write_file') {
        paramsCopy.data = 'base64 data';
      }
      this.logger.log(`Computer action request: ${JSON.stringify(paramsCopy)}`);
      return await this.computerUseService.action(params);
    } catch (error) {
      this.logger.error(
        `Error executing computer action: ${error.message}`,
        error.stack,
      );
      throw new HttpException(
        `Failed to execute computer action: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
