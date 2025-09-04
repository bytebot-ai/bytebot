import {
  PipeTransform,
  Injectable,
  ArgumentMetadata,
  BadRequestException,
} from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToClass } from 'class-transformer';
import {
  MoveMouseActionDto,
  TraceMouseActionDto,
  ClickMouseActionDto,
  PressMouseActionDto,
  DragMouseActionDto,
  ScrollActionDto,
  TypeKeysActionDto,
  PressKeysActionDto,
  TypeTextActionDto,
  PasteTextActionDto,
  WaitActionDto,
  ScreenshotActionDto,
  CursorPositionActionDto,
  ApplicationActionDto,
  WriteFileActionDto,
  ReadFileActionDto,
} from './computer-action.dto';

@Injectable()
export class ComputerActionValidationPipe implements PipeTransform {
  async transform(value: any, metadata: ArgumentMetadata) {
    if (!value || !value.action) {
      throw new BadRequestException('Missing action field');
    }

    let dto;
    switch (value.action) {
      case 'move_mouse':
        dto = plainToClass(MoveMouseActionDto, value);
        break;
      case 'trace_mouse':
        dto = plainToClass(TraceMouseActionDto, value);
        break;
      case 'click_mouse':
        dto = plainToClass(ClickMouseActionDto, value);
        break;
      case 'press_mouse':
        dto = plainToClass(PressMouseActionDto, value);
        break;
      case 'drag_mouse':
        dto = plainToClass(DragMouseActionDto, value);
        break;
      case 'scroll':
        dto = plainToClass(ScrollActionDto, value);
        break;
      case 'type_keys':
        dto = plainToClass(TypeKeysActionDto, value);
        break;
      case 'press_keys':
        dto = plainToClass(PressKeysActionDto, value);
        break;
      case 'type_text':
        dto = plainToClass(TypeTextActionDto, value);
        break;
      case 'paste_text':
        dto = plainToClass(PasteTextActionDto, value);
        break;
      case 'wait':
        dto = plainToClass(WaitActionDto, value);
        break;
      case 'screenshot':
        dto = plainToClass(ScreenshotActionDto, value);
        break;
      case 'cursor_position':
        dto = plainToClass(CursorPositionActionDto, value);
        break;
      case 'application':
        dto = plainToClass(ApplicationActionDto, value);
        break;
      case 'write_file':
        dto = plainToClass(WriteFileActionDto, value);
        break;
      case 'read_file':
        dto = plainToClass(ReadFileActionDto, value);
        break;
      default:
        throw new BadRequestException(`Unknown action: ${value.action}`);
    }

    const errors = await validate(dto);
    if (errors.length > 0) {
      throw new BadRequestException(errors);
    }

    return dto;
  }
}
