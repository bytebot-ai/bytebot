import { IsOptional, IsString, Length, Matches } from 'class-validator';

export class ApiKeyConfigDto {
  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'Anthropic API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Anthropic API key contains invalid characters' })
  anthropicApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'OpenAI API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'OpenAI API key contains invalid characters' })
  openaiApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'Gemini API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Gemini API key contains invalid characters' })
  geminiApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'OpenRouter API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'OpenRouter API key contains invalid characters' })
  openrouterApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'Mistral API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Mistral API key contains invalid characters' })
  mistralApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'Cohere API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Cohere API key contains invalid characters' })
  cohereApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'Groq API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Groq API key contains invalid characters' })
  groqApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'Perplexity API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Perplexity API key contains invalid characters' })
  perplexityApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'Together API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Together API key contains invalid characters' })
  togetherApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'Deepseek API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Deepseek API key contains invalid characters' })
  deepseekApiKey?: string;

  @IsOptional()
  @IsString()
  @Length(1, 200, { message: 'Fireworks API key must be between 1 and 200 characters' })
  @Matches(/^[a-zA-Z0-9_-]+$/, { message: 'Fireworks API key contains invalid characters' })
  fireworksApiKey?: string;
}