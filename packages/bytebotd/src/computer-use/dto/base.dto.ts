import { IsNumber } from 'class-validator';

export class CoordinatesDto {
  @IsNumber()
  x: number;

  @IsNumber()
  y: number;
}

export enum ButtonType {
  LEFT = 'left',
  RIGHT = 'right',
  MIDDLE = 'middle',
}

export enum PressType {
  UP = 'up',
  DOWN = 'down',
}

export enum ScrollDirection {
  UP = 'up',
  DOWN = 'down',
  LEFT = 'left',
  RIGHT = 'right',
}
