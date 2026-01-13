import { Injectable } from '@nestjs/common';
import Ajv, { type ErrorObject } from 'ajv';
import addFormats from 'ajv-formats';

export type JsonSchema = Record<string, any>;

export interface JsonSchemaViolation {
  keyword: string;
  instancePath: string;
  schemaPath: string;
  message: string;
  params: Record<string, any>;
}

export interface JsonSchemaValidationResult {
  valid: boolean;
  violations: JsonSchemaViolation[];
  missingFields: string[];
}

@Injectable()
export class JsonSchemaValidatorService {
  private readonly ajv: Ajv;

  constructor() {
    // Strict by default: schema mistakes should fail-closed.
    this.ajv = new Ajv({
      allErrors: true,
      strict: true,
      // Validate schemas we load at runtime; invalid schemas are treated as server errors.
      validateSchema: true,
    });
    addFormats(this.ajv);
  }

  validate(schema: JsonSchema, data: unknown): JsonSchemaValidationResult {
    const validate = this.ajv.compile(schema);
    const valid = validate(data) as boolean;

    if (valid) {
      return { valid: true, violations: [], missingFields: [] };
    }

    const errors = (validate.errors ?? []) as ErrorObject[];
    const violations = errors.map((e) => ({
      keyword: e.keyword,
      instancePath: e.instancePath ?? '',
      schemaPath: e.schemaPath ?? '',
      message: e.message ?? 'invalid',
      params: (e.params as any) ?? {},
    }));

    const missingFields = errors
      .filter((e) => e.keyword === 'required' && typeof (e.params as any)?.missingProperty === 'string')
      .map((e) => (e.params as any).missingProperty as string);

    return { valid: false, violations, missingFields };
  }

  /**
   * Patch semantics:
   * - validate only the fields present in the payload (no "required" enforcement)
   * - apply merged values, then run a full validation pass for completeness
   */
  makePatchSchema(schema: JsonSchema): JsonSchema {
    // Shallow clone is enough for our current v1 schemas; deep clone later if nested required is introduced.
    const copy: JsonSchema = { ...(schema as any) };
    if (Array.isArray(copy.required)) {
      copy.required = [];
    }
    return copy;
  }
}

