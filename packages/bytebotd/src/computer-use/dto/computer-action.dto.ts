import {
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  ValidateNested,
  IsArray,
  Min,
  IsIn,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  ButtonType,
  CoordinatesDto,
  PressType,
  ScrollDirection,
} from './base.dto';

export class MoveMouseActionDto {
  @IsIn(['move_mouse'])
  action: 'move_mouse';

  @ValidateNested()
  @Type(() => CoordinatesDto)
  coordinates: CoordinatesDto;
}

export class TraceMouseActionDto {
  @IsIn(['trace_mouse'])
  action: 'trace_mouse';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CoordinatesDto)
  path: CoordinatesDto[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  holdKeys?: string[];
}

export class ClickMouseActionDto {
  @IsIn(['click_mouse'])
  action: 'click_mouse';

  @IsOptional()
  @ValidateNested()
  @Type(() => CoordinatesDto)
  coordinates?: CoordinatesDto;

  @IsEnum(ButtonType)
  button: ButtonType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  holdKeys?: string[];

  @IsOptional()
  @IsNumber()
  @Min(1)
  numClicks?: number;
}

export class PressMouseActionDto {
  @IsIn(['press_mouse'])
  action: 'press_mouse';

  @IsOptional()
  @ValidateNested()
  @Type(() => CoordinatesDto)
  coordinates?: CoordinatesDto;

  @IsEnum(ButtonType)
  button: ButtonType;

  @IsEnum(PressType)
  press: PressType;
}

export class DragMouseActionDto {
  @IsIn(['drag_mouse'])
  action: 'drag_mouse';

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CoordinatesDto)
  path: CoordinatesDto[];

  @IsEnum(ButtonType)
  button: ButtonType;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  holdKeys?: string[];
}

export class ScrollActionDto {
  @IsIn(['scroll'])
  action: 'scroll';

  @IsOptional()
  @ValidateNested()
  @Type(() => CoordinatesDto)
  coordinates?: CoordinatesDto;

  @IsEnum(ScrollDirection)
  direction: ScrollDirection;

  @IsNumber()
  @Min(1)
  numScrolls: number;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  holdKeys?: string[];
}

export class TypeKeysActionDto {
  @IsIn(['type_keys'])
  action: 'type_keys';

  @IsArray()
  @IsString({ each: true })
  keys: string[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  delay?: number;
}

export class PressKeysActionDto {
  @IsIn(['press_keys'])
  action: 'press_keys';

  @IsArray()
  @IsString({ each: true })
  keys: string[];

  @IsEnum(PressType)
  press: PressType;
}

export class TypeTextActionDto {
  @IsIn(['type_text'])
  action: 'type_text';

  @IsString()
  text: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  delay?: number;
}

export class WaitActionDto {
  @IsIn(['wait'])
  action: 'wait';

  @IsNumber()
  @Min(0)
  duration: number;
}

export class ScreenshotActionDto {
  @IsIn(['screenshot'])
  action: 'screenshot';
}

export class CursorPositionActionDto {
  @IsIn(['cursor_position'])
  action: 'cursor_position';
}

// Union type for all computer actions
export type ComputerActionDto =
  | MoveMouseActionDto
  | TraceMouseActionDto
  | ClickMouseActionDto
  | PressMouseActionDto
  | DragMouseActionDto
  | ScrollActionDto
  | TypeKeysActionDto
  | PressKeysActionDto
  | TypeTextActionDto
  | WaitActionDto
  | ScreenshotActionDto
  | CursorPositionActionDto;
