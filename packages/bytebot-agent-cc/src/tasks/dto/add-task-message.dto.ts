import { IsNotEmpty, IsString } from 'class-validator';

export class AddTaskMessageDto {
  @IsNotEmpty()
  @IsString()
  message: string;
}
