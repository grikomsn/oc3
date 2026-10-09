// Schema-aware repair for tool-call arguments whose serialized representation
// disagrees with the declared schema in a way that has exactly one faithful
// reading. Adapted from lidge-jun/opencodex src/lib/tool-argument-integers.ts
// (MIT) with the same intent boundary: repair `120000.0` in an integer field
// and a bare `4` in a string-declared field; leave `1.5` and over-2^53 values
// alone so genuine disagreements still fail.

type SchemaNode = Record<string, unknown>;
type PathSegment = string | number;
// JSON path key -> replacement literal for the number found at that path.
type Repairs = Map<string, string>;

interface CoerceScope {
  root: SchemaNode;
  toolName?: string;
  repairs: Repairs;
}

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

function compositionBranches(schema: SchemaNode, root: SchemaNode): SchemaNode[] {
  const branches: SchemaNode[] = [];
  for (const key of COMPOSITION_KEYS) {
    const value = schema[key];
    if (!Array.isArray(value)) continue;
    for (const branch of value) {
      const node = asSchema(branch);
      const resolved = node ? resolveRef(node, root, new Set()) : undefined;
      if (resolved) branches.push(resolved);
    }
  }
  return branches;
}

// The schema itself plus its composition branches: every shape a value may take.
function candidateSchemas(schema: SchemaNode | undefined, root: SchemaNode): SchemaNode[] {
  return schema ? [schema, ...compositionBranches(schema, root)] : [];
}

// Several candidates constraining one value read as anyOf.
function unionOf(schemas: SchemaNode[]): SchemaNode | undefined {
  return schemas.length > 1 ? { anyOf: schemas } : schemas[0];
}

function propertySchema(candidates: SchemaNode[], key: string): SchemaNode | undefined {
  const named: SchemaNode[] = [];
  const additional: SchemaNode[] = [];
  for (const candidate of candidates) {
    const properties = asSchema(candidate.properties);
    const child = properties && Object.hasOwn(properties, key) ? asSchema(properties[key]) : undefined;
    if (child) named.push(child);
    const extra = asSchema(candidate.additionalProperties);
    if (extra) additional.push(extra);
  }
  return unionOf(named.length ? named : additional);
}

function itemSchema(candidates: SchemaNode[]): SchemaNode | undefined {
  const items: SchemaNode[] = [];
  for (const candidate of candidates) {
    const node = asSchema(candidate.items);
    if (node) items.push(node);
  }
  return unionOf(items);
}

function safelyIntegral(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

function pathKey(path: PathSegment[]): string {
  return JSON.stringify(path);
}

function coerceValue(
  value: unknown,
  schema: SchemaNode | undefined,
  scope: CoerceScope,
  depth: number,
  path: PathSegment[],
  propertyName?: string,
): void {
  if (depth > 64) return;
  const resolved = schema ? resolveRef(schema, scope.root, new Set()) : undefined;
  const candidates = candidateSchemas(resolved, scope.root);

  if (typeof value === "number") {
    if (!safelyIntegral(value)) return;
    const nativeU64Field = propertyName !== undefined
      && (
        U64_NUMBER_FIELDS.has(propertyName)
        || U64_NUMBER_FIELDS_BY_TOOL.get(scope.toolName ?? "")?.has(propertyName) === true
      );
    const nativeU64Declared = nativeU64Field && candidates.some(declaresNumeric);
    if (candidates.some(declaresInteger) || nativeU64Declared) {
      scope.repairs.set(pathKey(path), String(value));
    } else if (candidates.some(declaresString) && !candidates.some(declaresNumeric)) {
      scope.repairs.set(pathKey(path), JSON.stringify(String(value)));
    }
    return;
  }

  if (Array.isArray(value)) {
    const entrySchema = itemSchema(candidates);
    value.forEach((entry, index) => coerceValue(entry, entrySchema, scope, depth + 1, [...path, index]));
    return;
  }

  const object = asSchema(value);
  if (!object) return;
  for (const [key, entry] of Object.entries(object)) {
    coerceValue(entry, propertySchema(candidates, key), scope, depth + 1, [...path, key], key);
  }
}

interface NumberSpan {
  start: number;
  end: number;
}

const JSON_BLANK = /\s*/y;
const JSON_STRING = /"(?:[^"\\]|\\.)*"/y;
const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const JSON_LITERAL = /true|false|null/y;

// Maps each number literal in already-validated JSON to its path. A repeated
// key keeps its last occurrence, which is the value JSON.parse returns.
function numberSpans(text: string): Map<string, NumberSpan> {
  const spans = new Map<string, NumberSpan>();
  const path: PathSegment[] = [];
  let pos = 0;
  const take = (pattern: RegExp): string => {
    pattern.lastIndex = pos;
    const found = pattern.exec(text)?.[0] ?? "";
    pos += found.length;
    return found;
  };
  const visit = (): void => {
    take(JSON_BLANK);
    if (text[pos] === "{") {
      pos += 1;
      take(JSON_BLANK);
      while (text[pos] !== "}") {
        const key = JSON.parse(take(JSON_STRING)) as string;
        take(JSON_BLANK);
        pos += 1;
        path.push(key);
        visit();
        path.pop();
        take(JSON_BLANK);
        if (text[pos] === ",") pos += 1;
        take(JSON_BLANK);
      }
      pos += 1;
    } else if (text[pos] === "[") {
      pos += 1;
      take(JSON_BLANK);
      for (let index = 0; text[pos] !== "]"; index += 1) {
        path.push(index);
        visit();
        path.pop();
        take(JSON_BLANK);
        if (text[pos] === ",") pos += 1;
        take(JSON_BLANK);
      }
      pos += 1;
    } else if (text[pos] === "\"") {
      take(JSON_STRING);
    } else {
      const start = pos;
      if (take(JSON_NUMBER)) spans.set(pathKey(path), { start, end: pos });
      else take(JSON_LITERAL);
    }
  };
  visit();
  return spans;
}

// Only the repaired literals change; every other byte of the arguments, including
// digits too large for a double, is kept as the model wrote it.
function spliceNumberLiterals(text: string, repairs: Repairs): string {
  const spans = numberSpans(text);
  const edits: Array<NumberSpan & { literal: string }> = [];
  for (const [key, literal] of repairs) {
    const span = spans.get(key);
    if (span) edits.push({ ...span, literal });
  }
  edits.sort((a, b) => a.start - b.start);
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    output += text.slice(cursor, edit.start) + edit.literal;
    cursor = edit.end;
  }
  return output + text.slice(cursor);
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
  const scope: CoerceScope = { root, toolName, repairs: new Map() };
  coerceValue(parsed, root, scope, 0, []);
  return scope.repairs.size ? spliceNumberLiterals(args, scope.repairs) : args;
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
