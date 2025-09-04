import { Injectable, Logger } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import { randomUUID } from 'crypto';
import {
  convertClickMouseActionToToolUseBlock,
  convertDragMouseActionToToolUseBlock,
  convertPressKeysActionToToolUseBlock,
  convertPressMouseActionToToolUseBlock,
  convertScrollActionToToolUseBlock,
  convertTypeKeysActionToToolUseBlock,
  convertTypeTextActionToToolUseBlock,
  ImageContentBlock,
  MessageContentBlock,
  MessageContentType,
  ScreenshotToolUseBlock,
  ToolResultContentBlock,
  UserActionContentBlock,
} from '@bytebot/shared';
import { Role } from '@prisma/client';
import { MessagesService } from '../messages/messages.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InputCaptureService {
  private readonly logger = new Logger(InputCaptureService.name);
  private socket: Socket | null = null;
  private capturing = false;

  constructor(
    private readonly messagesService: MessagesService,
    private readonly configService: ConfigService,
  ) {}

  isCapturing() {
    return this.capturing;
  }

  start(taskId: string) {
    if (this.socket?.connected && this.capturing) return;

    if (this.socket && !this.socket.connected) {
      this.socket.connect();
      return;
    }

    const baseUrl = this.configService.get<string>('BYTEBOT_DESKTOP_BASE_URL');
    if (!baseUrl) {
      this.logger.warn('BYTEBOT_DESKTOP_BASE_URL missing.');
      return;
    }

    this.socket = io(baseUrl, { transports: ['websocket'] });

    this.socket.on('connect', () => {
      this.logger.log('Input socket connected');
      this.capturing = true;
    });

    this.socket.on(
      'screenshotAndAction',
      async (shot: { image: string }, action: any) => {
        if (!this.capturing || !taskId) return;
        // The gateway only sends a click_mouse or drag_mouse action together with screenshots for now.
        if (action.action !== 'click_mouse' && action.action !== 'drag_mouse')
          return;

        const userActionBlock: UserActionContentBlock = {
          type: MessageContentType.UserAction,
          content: [
            {
              type: MessageContentType.Image,
              source: {
                data: shot.image,
                media_type: 'image/png',
                type: 'base64',
              },
            },
          ],
        };

        const toolUseId = randomUUID();
        switch (action.action) {
          case 'drag_mouse':
            userActionBlock.content.push(
              convertDragMouseActionToToolUseBlock(action, toolUseId),
            );
            break;
          case 'click_mouse':
            userActionBlock.content.push(
              convertClickMouseActionToToolUseBlock(action, toolUseId),
            );
            break;
        }

        await this.messagesService.create({
          content: [userActionBlock],
          role: Role.USER,
          taskId,
        });
      },
    );

    this.socket.on('action', async (action: any) => {
      if (!this.capturing || !taskId) return;
      const toolUseId = randomUUID();
      const userActionBlock: UserActionContentBlock = {
        type: MessageContentType.UserAction,
        content: [],
      };

      switch (action.action) {
        case 'drag_mouse':
          userActionBlock.content.push(
            convertDragMouseActionToToolUseBlock(action, toolUseId),
          );
          break;
        case 'press_mouse':
          userActionBlock.content.push(
            convertPressMouseActionToToolUseBlock(action, toolUseId),
          );
          break;
        case 'type_keys':
          userActionBlock.content.push(
            convertTypeKeysActionToToolUseBlock(action, toolUseId),
          );
          break;
        case 'press_keys':
          userActionBlock.content.push(
            convertPressKeysActionToToolUseBlock(action, toolUseId),
          );
          break;
        case 'type_text':
          userActionBlock.content.push(
            convertTypeTextActionToToolUseBlock(action, toolUseId),
          );
          break;
        case 'scroll':
          userActionBlock.content.push(
            convertScrollActionToToolUseBlock(action, toolUseId),
          );
          break;
        default:
          this.logger.warn(`Unknown action ${action.action}`);
      }

      if (userActionBlock.content.length > 0) {
        await this.messagesService.create({
          content: [userActionBlock],
          role: Role.USER,
          taskId,
        });
      }
    });

    this.socket.on('disconnect', () => {
      this.logger.log('Input socket disconnected');
      this.capturing = false;
    });
  }

  async stop() {
    if (!this.socket) return;
    if (this.socket.connected) this.socket.disconnect();
    else this.socket.removeAllListeners();
    this.socket = null;
    this.capturing = false;
  }
}
