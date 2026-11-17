import { z } from 'zod';
import type { JsonSchemaProperty, ToolParametersSchema } from './types.js';

/**
 * Convierte un esquema `z.ZodObject` en un JSON Schema compatible con OpenAI Function Calling.
 */
export function zodToOpenAIToolParameters(schema?: z.ZodTypeAny): ToolParametersSchema {
  if (!schema) {
    return { type: 'object', properties: {} };
  }

  // Desenvolver ZodEffects (ej. .refine / .superRefine) si envuelven un ZodObject
  let current: z.ZodTypeAny = schema;
  while (current instanceof z.ZodEffects) {
    current = current._def.schema;
  }

  if (!(current instanceof z.ZodObject)) {
    return { type: 'object', properties: {} };
  }

  const shape = current.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const { prop, isOptional } = unwrapZodField(fieldSchema);
    properties[key] = prop;
    if (!isOptional) {
      required.push(key);
    }
  }

  const result: ToolParametersSchema = {
    type: 'object',
    properties,
  };

  if (required.length > 0) {
    result.required = required;
  }

  return result;
}

function unwrapZodField(field: z.ZodTypeAny): {
  prop: JsonSchemaProperty;
  isOptional: boolean;
} {
  let isOptional = false;
  let description = field.description;
  let current: z.ZodTypeAny = field;

  while (
    current instanceof z.ZodOptional ||
    current instanceof z.ZodNullable ||
    current instanceof z.ZodDefault ||
    current instanceof z.ZodEffects
  ) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    ) {
      isOptional = true;
      current = current._def.innerType;
    } else if (current instanceof z.ZodEffects) {
      current = current._def.schema;
    }
    if (!description && current.description) {
      description = current.description;
    }
  }

  if (current instanceof z.ZodNumber) {
    const prop: JsonSchemaProperty = { type: 'number' };
    if (description) prop.description = description;

    for (const check of current._def.checks ?? []) {
      if (check.kind === 'min') {
        prop.minimum = check.inclusive ? check.value : check.value + 1;
      } else if (check.kind === 'max') {
        prop.maximum = check.inclusive ? check.value : check.value - 1;
      }
    }
    return { prop, isOptional };
  }

  if (current instanceof z.ZodBoolean) {
    const prop: JsonSchemaProperty = { type: 'boolean' };
    if (description) prop.description = description;
    return { prop, isOptional };
  }

  if (current instanceof z.ZodEnum) {
    const prop: JsonSchemaProperty = {
      type: 'string',
      enum: current._def.values,
    };
    if (description) prop.description = description;
    return { prop, isOptional };
  }

  const prop: JsonSchemaProperty = { type: 'string' };
  if (description) prop.description = description;
  return { prop, isOptional };
}
