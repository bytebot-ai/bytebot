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

export enum ApplicationName {
  FIREFOX = 'firefox',
  ONEPASSWORD = '1password',
  THUNDERBIRD = 'thunderbird',
  VSCODE = 'vscode',
  TERMINAL = 'terminal',
  DESKTOP = 'desktop',
  DIRECTORY = 'directory',
}
