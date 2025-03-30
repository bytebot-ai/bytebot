import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';

const tcpPort = Number(process.env.TCP_PORT ?? 3003);
const httpPort = Number(process.env.HTTP_PORT ?? 3000);

async function bootstrap() {
  // Create HTTP application
  const app = await NestFactory.create(AppModule);

  // Add TCP microservice
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.TCP,
    options: {
      host: '127.0.0.1',
      port: tcpPort,
    },
  });

  // Start both servers
  await app.startAllMicroservices();
  await app.listen(httpPort);

  console.log(`HTTP server running on port ${httpPort}`);
  console.log(`TCP server running on port ${tcpPort}`);
}
bootstrap();
