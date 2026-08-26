// A deliberately small JSON-Schema *subset* validator for research skill
// parameters. We do NOT pull in Ajv: the schemas declared by skill entrypoints
// only ever use object/array/number/integer/string/boolean with required, enum,
// item types, numeric bounds, and defaults. Keeping this dependency-free lets
// the exact same contract be mirrored cheaply in the vanilla-JS editor.
//
// `validateParams` is the authoritative server gate (called from validateSteps);
// the frontend re-implements the same rules for inline feedback only.

export type ParamPropType = "array" | "number" | "integer" | "string" | "boolean";

export interface ParamProperty {
  type: ParamPropType;
  items?: { type: "number" | "integer" | "string" | "boolean" };
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  default?: unknown;
  description?: string;
}

export interface ParamSchema {
  type: "object";
  properties?: Record<string, ParamProperty>;
  required?: string[];
  /** Omitted is treated as `false`: skill params are a closed contract so a typo
   *  ("threshold" vs "thresholds") is reported rather than silently ignored. */
  additionalProperties?: boolean;
  examples?: Array<Record<string, unknown>>;
}

const typeName = (value: unknown): string => (Array.isArray(value) ? "array" : value === null ? "null" : typeof value);

const checkProperty = (key: string, spec: ParamProperty, value: unknown): string[] => {
  const errors: string[] = [];
  if (spec.type === "array") {
    if (!Array.isArray(value)) return [`"${key}" must be an array`];
    if (typeof spec.minItems === "number" && value.length < spec.minItems) errors.push(`"${key}" needs at least ${spec.minItems} item(s)`);
    if (spec.items) {
      for (const [i, item] of value.entries()) {
        const ok = spec.items.type === "integer" ? typeof item === "number" && Number.isInteger(item) : typeName(item) === spec.items.type;
        if (!ok) errors.push(`"${key}[${i}]" must be a ${spec.items.type}`);
      }
    }
    return errors;
  }
  if (spec.type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) return [`"${key}" must be an integer`];
  } else if (spec.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return [`"${key}" must be a number`];
  } else if (typeName(value) !== spec.type) {
    return [`"${key}" must be a ${spec.type}`];
  }
  if (typeof value === "number") {
    if (typeof spec.minimum === "number" && value < spec.minimum) errors.push(`"${key}" must be ≥ ${spec.minimum}`);
    if (typeof spec.maximum === "number" && value > spec.maximum) errors.push(`"${key}" must be ≤ ${spec.maximum}`);
  }
  if (spec.enum && !spec.enum.includes(value as string | number)) errors.push(`"${key}" must be one of: ${spec.enum.join(", ")}`);
  return errors;
};

/** Returns a list of human-readable problems; an empty array means valid. */
export function validateParams(schema: ParamSchema | undefined, value: unknown): string[] {
  if (!schema || schema.type !== "object") return [];
  if (value === null || typeof value !== "object" || Array.isArray(value)) return ["parameters must be a JSON object"];
  const record = value as Record<string, unknown>;
  const properties = schema.properties || {};
  const errors: string[] = [];
  for (const key of schema.required || []) {
    if (!(key in record)) errors.push(`missing required parameter "${key}"`);
  }
  if (schema.additionalProperties !== true) {
    for (const key of Object.keys(record)) {
      if (!(key in properties)) errors.push(`unknown parameter "${key}"`);
    }
  }
  for (const [key, spec] of Object.entries(properties)) {
    if (key in record) errors.push(...checkProperty(key, spec, record[key]));
  }
  return errors;
}

/** Build the default parameter object an operation should start from. */
export function defaultParams(schema: ParamSchema | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(schema?.properties || {})) {
    if (spec.default !== undefined) out[key] = spec.default;
  }
  return out;
}

/** The example to show in the editor: first declared example, else the defaults. */
export function exampleParams(schema: ParamSchema | undefined): Record<string, unknown> {
  return schema?.examples?.[0] ?? defaultParams(schema);
}
