// src/qmp-client/qmp-client.service.ts
import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createConnection, Socket } from 'net';
import { EventEmitter } from 'events';

@Injectable()
export class QmpClientService
  extends EventEmitter
  implements OnModuleInit, OnModuleDestroy
{
  private socket: Socket | null = null;
  private buffer = '';
  // TCP connection parameters instead of Unix socket
  private host: string;
  private readonly port = 4444; // Default QMP port, adjust as needed
  private readonly logger = new Logger(QmpClientService.name);
  private isConnecting = false;
  private maxRetries = 30; // 30 retries = 30 seconds total with exponential backoff
  private retryCount = 0;

  constructor(private readonly configService: ConfigService) {
    super(); // Call to initialize EventEmitter parent class
    this.host = this.configService.get('QEMU_HOST') || 'localhost';
  }

  async onModuleInit() {
    // await this.connectWithRetry();
  }

  onModuleDestroy() {
    if (this.socket) {
      this.socket.end();
      this.logger.log('Disconnected from QEMU QMP TCP connection.');
    }
  }

  private async connectWithRetry(): Promise<void> {
    while (this.retryCount < this.maxRetries) {
      try {
        // Close existing socket if it exists
        if (this.socket) {
          this.socket.removeAllListeners();
          this.socket.destroy();
          this.socket = null;
        }

        await this.connect();
        this.logger.log(
          `Connected to QEMU QMP TCP at ${this.host}:${this.port}.`,
        );
        // QEMU sends an initial greeting; now enable QMP capabilities.
        await this.sendCommand({ execute: 'qmp_capabilities' });
        this.logger.log('QMP capabilities enabled.');
        this.retryCount = 0; // Reset retry count on successful connection
        return;
      } catch (error) {
        this.retryCount++;
        if (this.retryCount >= this.maxRetries) {
          this.logger.error(
            'Failed to connect to QMP TCP after maximum retries.',
          );
          throw error;
        }

        // Calculate delay with exponential backoff (starts at 100ms)
        const delay = Math.min(100 * Math.pow(2, this.retryCount - 1), 1000);
        this.logger.debug(
          `Retrying connection in ${delay}ms (attempt ${this.retryCount}/${this.maxRetries})`,
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private connect(): Promise<void> {
    if (this.isConnecting) {
      return Promise.reject(
        new Error('Connection attempt already in progress'),
      );
    }

    this.isConnecting = true;
    return new Promise((resolve, reject) => {
      try {
        // Create new socket instance with TCP connection
        this.socket = createConnection(
          { host: this.host, port: this.port },
          () => {
            this.isConnecting = false;
            resolve();
          },
        );

        this.socket.setEncoding('utf8');
        this.socket.on('data', (data: string) => this.handleData(data));
        this.socket.on('error', (err: Error) => {
          this.isConnecting = false;
          this.socket?.removeAllListeners();
          this.socket?.destroy();
          // Don't log connection refused errors during initial connection attempts
          if (
            (err.message.includes('ECONNREFUSED') ||
              err.message.includes('EAGAIN')) &&
            this.retryCount < this.maxRetries
          ) {
            reject(err);
            return;
          }
          this.logger.error('QMP TCP connection error:', err);
          reject(err);
        });
        this.socket.on('close', () => {
          this.isConnecting = false;
          if (this.retryCount < this.maxRetries) {
            this.logger.debug(
              'QMP TCP connection closed, will retry connection.',
            );
          } else {
            this.logger.warn('QMP TCP connection closed.');
          }
        });
      } catch (err) {
        this.isConnecting = false;
        reject(err);
      }
    });
  }

  private handleData(data: string) {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || ''; // keep the incomplete part for later
    for (const line of lines) {
      if (line.trim()) {
        try {
          const json = JSON.parse(line);
          // Emit under a dedicated event name.
          this.emit('qmp-response', json);
        } catch (error) {
          this.logger.error('Failed to parse QMP message:', line);
        }
      }
    }
  }

  /**
   * Sends a QMP command and waits for the next response.
   * Assumes commands are not sent concurrently.
   *
   * @param command The command object to send (as JSON).
   * @param timeoutMs How long to wait for a response (default: 5000ms).
   */
  public sendCommand(command: any, timeoutMs = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeListener('qmp-response', onResponse);
        reject(new Error('QMP command timed out'));
      }, timeoutMs);

      const onResponse = (response: any) => {
        clearTimeout(timeout);
        this.removeListener('qmp-response', onResponse);
        if (response.error) {
          reject(new Error(JSON.stringify(response.error)));
        } else {
          resolve(response);
        }
      };

      this.on('qmp-response', onResponse);
      this.socket?.write(JSON.stringify(command) + '\n', (err) => {
        if (err) {
          clearTimeout(timeout);
          this.removeListener('qmp-response', onResponse);
          reject(err);
        }
      });
    });
  }
}
