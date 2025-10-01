import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ProvidersModule } from '../providers.module';
import { ConfigModule } from '@nestjs/config';

describe('ProvidersController (Integration)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
        }),
        ProvidersModule,
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('/providers (GET)', () => {
    it('should return all providers', () => {
      return request(app.getHttpServer())
        .get('/providers')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          expect(res.body.length).toBeGreaterThan(0);
          
          const provider = res.body[0];
          expect(provider).toHaveProperty('id');
          expect(provider).toHaveProperty('name');
          expect(provider).toHaveProperty('description');
          expect(provider).toHaveProperty('isEnabled');
          expect(provider).toHaveProperty('models');
        });
    });
  });

  describe('/providers/enabled (GET)', () => {
    it('should return only enabled providers', () => {
      return request(app.getHttpServer())
        .get('/providers/enabled')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          // Each provider should be enabled
          res.body.forEach((provider: any) => {
            expect(provider.isEnabled).toBe(true);
          });
        });
    });
  });

  describe('/providers/models (GET)', () => {
    it('should return all available models', () => {
      return request(app.getHttpServer())
        .get('/providers/models')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          
          if (res.body.length > 0) {
            const model = res.body[0];
            expect(model).toHaveProperty('provider');
            expect(model).toHaveProperty('name');
            expect(model).toHaveProperty('title');
          }
        });
    });
  });

  describe('/providers/default-model (GET)', () => {
    it('should return a default model if any providers are enabled', () => {
      return request(app.getHttpServer())
        .get('/providers/default-model')
        .expect(200)
        .expect((res) => {
          // Could be null if no providers are enabled in test environment
          if (res.body !== null) {
            expect(res.body).toHaveProperty('provider');
            expect(res.body).toHaveProperty('name');
            expect(res.body).toHaveProperty('title');
          }
        });
    });
  });

  describe('/providers/:providerId/models (GET)', () => {
    it('should return models for a specific provider', () => {
      return request(app.getHttpServer())
        .get('/providers/anthropic/models')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          
          res.body.forEach((model: any) => {
            expect(model.provider).toBe('anthropic');
            expect(model).toHaveProperty('name');
            expect(model).toHaveProperty('title');
          });
        });
    });

    it('should return empty array for unknown provider', () => {
      return request(app.getHttpServer())
        .get('/providers/unknown/models')
        .expect(200)
        .expect((res) => {
          expect(Array.isArray(res.body)).toBe(true);
          expect(res.body).toHaveLength(0);
        });
    });
  });

  describe('/providers/refresh (POST)', () => {
    it('should refresh provider status', () => {
      return request(app.getHttpServer())
        .post('/providers/refresh')
        .expect(201)
        .expect((res) => {
          expect(res.body).toEqual({ success: true });
        });
    });
  });
});