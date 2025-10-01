import { IsNotEmpty, IsString, Length, IsIn } from 'class-validator';

export class TestApiKeyDto {
  @IsNotEmpty({ message: 'Provider is required' })
  @IsString()
  @IsIn(['ANTHROPIC', 'OPENAI', 'GEMINI', 'OPENROUTER', 'MISTRAL', 'COHERE', 'GROQ', 'PERPLEXITY', 'TOGETHER', 'DEEPSEEK', 'FIREWORKS'], {
    message: 'Provider must be one of: ANTHROPIC, OPENAI, GEMINI, OPENROUTER, MISTRAL, COHERE, GROQ, PERPLEXITY, TOGETHER, DEEPSEEK, FIREWORKS'
  })
  provider: string;

  @IsNotEmpty({ message: 'API key is required' })
  @IsString()
  @Length(1, 200, { message: 'API key must be between 1 and 200 characters' })
  apiKey: string;
}