// Schema-aware repair for tool-call arguments whose serialized representation
// disagrees with the declared schema in a way that has exactly one faithful
// reading. Adapted from lidge-jun/opencodex src/lib/tool-argument-integers.ts
// (MIT) with the same intent boundary: repair `120000.0` in an integer field
// and a bare `4` in a string-declared field; leave `1.5` and over-2^53 values
// alone so genuine disagreements still fail.

type SchemaNode = Record<string, unknown>;

function asSchema(value: unknown): SchemaNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SchemaNode
    : undefined;
}

function declaresInteger(schema: SchemaNode): boolean {
  const type = schema.type;
  if (type === "integer") return true;
  return Array.isArray(type) && type.includes("integer");
}

function declaresString(schema: SchemaNode): boolean {
  const type = schema.type;
  if (type === "string") return true;
  return Array.isArray(type) && type.includes("string");
}

function declaresNumeric(schema: SchemaNode): boolean {
  const type = schema.type;
  if (type === "integer" || type === "number") return true;
  return Array.isArray(type) && (type.includes("integer") || type.includes("number"));
}

const U64_NUMBER_FIELDS = new Set(["timeout_ms"]);
const U64_NUMBER_FIELDS_BY_TOOL = new Map<string, ReadonlySet<string>>([
  ["wait", new Set(["yield_time_ms", "max_tokens"])],
]);

function resolveRef(schema: SchemaNode, root: SchemaNode, seen: Set<string>): SchemaNode | undefined {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  if (seen.has(ref)) return undefined;
  seen.add(ref);
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    const current = asSchema(node);
    if (!current) return undefined;
    node = current[segment];
  }
  const resolved = asSchema(node);
  return resolved ? resolveRef(resolved, root, seen) : undefined;
}

const COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;

function compositionBranches(schema: SchemaNode): SchemaNode[] {
  const branches: SchemaNode[] = [];
  for (const key of COMPOSITION_KEYS) {
    const value = schema[key];
    if (!Array.isArray(value)) continue;
    for (const branch of value) {
      const node = asSchema(branch);
      if (node) branches.push(node);
    }
  }
  return branches;
}

function safelyIntegral(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

interface CoerceResult {
  value: unknown;
  changed: boolean;
}

function coerceValue(
  value: unknown,
  schema: SchemaNode | undefined,
  root: SchemaNode,
  depth: number,
  toolName?: string,
  propertyName?: string,
): CoerceResult {
  if (depth > 64) return { value, changed: false };
  const resolved = schema ? resolveRef(schema, root, new Set()) : undefined;

  if (typeof value === "number") {
    if (!resolved) return { value, changed: false };
    const branches = compositionBranches(resolved);
    const nativeU64Field = propertyName !== undefined
      && (
        U64_NUMBER_FIELDS.has(propertyName)
        || U64_NUMBER_FIELDS_BY_TOOL.get(toolName ?? "")?.has(propertyName) === true
      );
    const nativeU64Declared = nativeU64Field
      && (declaresNumeric(resolved) || branches.some(declaresNumeric));
    const integerDeclared = declaresInteger(resolved)
      || branches.some(declaresInteger)
      || nativeU64Declared;
    if (!integerDeclared && safelyIntegral(value)) {
      const stringDeclared = declaresString(resolved) || branches.some(declaresString);
      const numericDeclared = declaresNumeric(resolved) || branches.some(declaresNumeric);
      if (stringDeclared && !numericDeclared) {
        return { value: String(value), changed: true };
      }
    }
    if (!integerDeclared || !safelyIntegral(value)) return { value, changed: false };
    return { value, changed: true };
  }

  if (Array.isArray(value)) {
    const itemSchema = resolved ? asSchema(resolved.items) : undefined;
    let changed = false;
    const next = value.map(entry => {
      const result = coerceValue(entry, itemSchema, root, depth + 1, toolName);
      if (result.changed) changed = true;
      return result.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }

  const object = asSchema(value);
  if (!object) return { value, changed: false };

  const properties = resolved ? asSchema(resolved.properties) : undefined;
  const additional = resolved ? asSchema(resolved.additionalProperties) : undefined;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    const childSchema = asSchema(properties?.[key]) ?? additional;
    const result = coerceValue(entry, childSchema, root, depth + 1, toolName, key);
    if (result.changed) changed = true;
    next[key] = result.value;
  }
  return changed ? { value: next, changed } : { value, changed: false };
}

export function coerceToolArguments(args: string, parameters: Record<string, unknown> | undefined, toolName?: string): string {
  if (!parameters || !args) return args;
  if (!/\d/.test(args)) return args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return args;
  }
  const root = parameters as SchemaNode;
  const result = coerceValue(parsed, root, root, 0, toolName);
  if (!result.changed) return args;
  return JSON.stringify(result.value);
}

// --- apply_patch envelope repair (adapted from opencodex apply-patch-envelope.ts) ---

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const TOP_LEVEL_PATCH_ENVELOPE = /^(\*\*\* Begin Patch(?: \*\*\*)?)(\r?\n)([\s\S]*)(\r?\n)(\*\*\* End Patch(?: \*\*\*)?)(\r?\n)?$/;
const PATCH_OPERATION_LINE = /^\*\*\* (?:Add|Update|Delete) File: .+$/m;

export function isCompletePatchEnvelope(text: string): boolean {
  const match = TOP_LEVEL_PATCH_ENVELOPE.exec(text);
  if (!match) return false;
  return PATCH_OPERATION_LINE.test(match[3] ?? "");
}

export function normalizeApplyPatchDelimiters(text: string): string {
  const match = TOP_LEVEL_PATCH_ENVELOPE.exec(text);
  if (!match) return text;
  const body = match[3] ?? "";
  const trailingBreak = match[6] ?? "";
  if (!PATCH_OPERATION_LINE.test(body)) return text;
  return `${PATCH_BEGIN}\n${body}\n${PATCH_END}${trailingBreak}`;
}
