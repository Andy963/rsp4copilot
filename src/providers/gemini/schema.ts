function resolveJsonSchemaRef(ref: any, rootSchema: any): any | null {
  const r = typeof ref === "string" ? ref.trim() : "";
  if (!r) return null;
  if (!rootSchema || typeof rootSchema !== "object") return null;
  if (r === "#") return rootSchema;
  if (!r.startsWith("#/")) return null;

  const decode = (token: string) => token.replace(/~1/g, "/").replace(/~0/g, "~");
  const parts = r
    .slice(2)
    .split("/")
    .map((p: string) => decode(p));

  let cur = rootSchema;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return null;
    if (!(p in cur)) return null;
    cur = cur[p];
  }
  return cur && typeof cur === "object" ? cur : null;
}

function mergeJsonSchemasShallow(base: any, next: any): any {
  const a = base && typeof base === "object" ? base : {};
  const b = next && typeof next === "object" ? next : {};

  const out: any = { ...a, ...b };

  const ap = a.properties && typeof a.properties === "object" && !Array.isArray(a.properties) ? a.properties : null;
  const bp = b.properties && typeof b.properties === "object" && !Array.isArray(b.properties) ? b.properties : null;
  if (ap || bp) out.properties = { ...(ap || {}), ...(bp || {}) };

  const ar = Array.isArray(a.required) ? a.required : null;
  const br = Array.isArray(b.required) ? b.required : null;
  if (ar || br) out.required = Array.from(new Set([...(ar || []), ...(br || [])].filter((x) => typeof x === "string" && x)));

  const ad = a.definitions && typeof a.definitions === "object" && !Array.isArray(a.definitions) ? a.definitions : null;
  const bd = b.definitions && typeof b.definitions === "object" && !Array.isArray(b.definitions) ? b.definitions : null;
  if (ad || bd) out.definitions = { ...(ad || {}), ...(bd || {}) };

  const adefs = a.$defs && typeof a.$defs === "object" && !Array.isArray(a.$defs) ? a.$defs : null;
  const bdefs = b.$defs && typeof b.$defs === "object" && !Array.isArray(b.$defs) ? b.$defs : null;
  if (adefs || bdefs) out.$defs = { ...(adefs || {}), ...(bdefs || {}) };

  return out;
}

export function jsonSchemaToGeminiSchema(jsonSchema: any, rootSchema: any = jsonSchema, refStack: Set<string> | undefined = undefined): any {
  if (!jsonSchema || typeof jsonSchema !== "object") return {};

  const root = rootSchema && typeof rootSchema === "object" ? rootSchema : jsonSchema;
  const stack = refStack && refStack instanceof Set ? refStack : new Set<string>();

  const ref = typeof jsonSchema.$ref === "string" ? jsonSchema.$ref.trim() : "";
  if (ref) {
    if (stack.has(ref)) return {};
    stack.add(ref);
    const resolved = resolveJsonSchemaRef(ref, root);
    const merged = resolved && typeof resolved === "object" ? { ...resolved, ...jsonSchema } : { ...jsonSchema };
    delete merged.$ref;
    const out = jsonSchemaToGeminiSchema(merged, root, stack);
    stack.delete(ref);
    return out;
  }

  const allOf = Array.isArray(jsonSchema.allOf) ? jsonSchema.allOf : null;
  if (allOf && allOf.length) {
    let merged = { ...jsonSchema };
    delete merged.allOf;
    for (const it of allOf) {
      if (!it || typeof it !== "object") continue;
      merged = mergeJsonSchemasShallow(merged, it);
    }
    return jsonSchemaToGeminiSchema(merged, root, stack);
  }

  const schemaFieldNames = new Set(["items"]);
  const listSchemaFieldNames = new Set(["anyOf", "oneOf"]);
  const dictSchemaFieldNames = new Set(["properties"]);
  const int64FieldNames = new Set(["maxItems", "minItems", "minLength", "maxLength", "minProperties", "maxProperties"]);

  const out: any = {};

  const input: any = { ...jsonSchema };

  // Gemini Schema is a subset of OpenAPI 3.0 and does not support exclusiveMinimum/exclusiveMaximum.
  // Convert JSON Schema 2019+/2020 numeric exclusives (and OpenAPI boolean exclusives) into inclusive bounds.
  const typeHint = typeof input.type === "string" ? input.type.trim().toLowerCase() : "";
  const isIntegerType = typeHint === "integer";
  const bumpEpsilon = (n: any) => Number.EPSILON * Math.max(1, Math.abs(Number(n)));
  const bumpUp = (n: any) => (isIntegerType ? Math.floor(Number(n)) + 1 : Number(n) + bumpEpsilon(n));
  const bumpDown = (n: any) => (isIntegerType ? Math.ceil(Number(n)) - 1 : Number(n) - bumpEpsilon(n));

  if (typeof input.exclusiveMinimum === "number" && Number.isFinite(input.exclusiveMinimum)) {
    const candidate = bumpUp(input.exclusiveMinimum);
    if (typeof input.minimum === "number" && Number.isFinite(input.minimum)) input.minimum = Math.max(input.minimum, candidate);
    else input.minimum = candidate;
    delete input.exclusiveMinimum;
  } else if (input.exclusiveMinimum === true) {
    if (typeof input.minimum === "number" && Number.isFinite(input.minimum)) input.minimum = bumpUp(input.minimum);
    delete input.exclusiveMinimum;
  } else if ("exclusiveMinimum" in input) {
    delete input.exclusiveMinimum;
  }

  if (typeof input.exclusiveMaximum === "number" && Number.isFinite(input.exclusiveMaximum)) {
    const candidate = bumpDown(input.exclusiveMaximum);
    if (typeof input.maximum === "number" && Number.isFinite(input.maximum)) input.maximum = Math.min(input.maximum, candidate);
    else input.maximum = candidate;
    delete input.exclusiveMaximum;
  } else if (input.exclusiveMaximum === true) {
    if (typeof input.maximum === "number" && Number.isFinite(input.maximum)) input.maximum = bumpDown(input.maximum);
    delete input.exclusiveMaximum;
  } else if ("exclusiveMaximum" in input) {
    delete input.exclusiveMaximum;
  }

  if (input.type && input.anyOf) {
    // Avoid producing an invalid schema.
    delete input.anyOf;
  }

  // Handle nullable unions like { anyOf: [{type:'null'}, {...}] }
  const anyOf = Array.isArray(input.anyOf) ? input.anyOf : Array.isArray(input.oneOf) ? input.oneOf : null;
  if (anyOf && anyOf.length === 2) {
    const a0 = anyOf[0] && typeof anyOf[0] === "object" ? anyOf[0] : null;
    const a1 = anyOf[1] && typeof anyOf[1] === "object" ? anyOf[1] : null;
    if (a0?.type === "null") {
      out.nullable = true;
      return { ...out, ...jsonSchemaToGeminiSchema(a1, root, stack) };
    }
    if (a1?.type === "null") {
      out.nullable = true;
      return { ...out, ...jsonSchemaToGeminiSchema(a0, root, stack) };
    }
  }

  if (Array.isArray(input.type)) {
    const list = input.type.filter((t: any) => typeof t === "string");
    if (list.length) {
      out.anyOf = list
        .filter((t: any) => t !== "null")
        .map((t: any) => jsonSchemaToGeminiSchema({ ...input, type: t, anyOf: undefined, oneOf: undefined }, root, stack));
      if (list.includes("null")) out.nullable = true;
      delete out.type;
      return out;
    }
  }

  for (const [k, v] of Object.entries(input)) {
    if (v == null) continue;
    if (k.startsWith("$")) continue;
    if (k === "additionalProperties") continue;
    if (k === "definitions") continue;
    if (k === "$defs") continue;
    if (k === "examples") continue;
    if (k === "allOf") continue;

    if (k === "type") {
      if (typeof v !== "string") continue;
      if (v === "null") continue;
      out.type = String(v).toUpperCase();
      continue;
    }

    if (k === "const") {
      if (!("enum" in out) && typeof v === "string") out.enum = [v];
      continue;
    }

    if (schemaFieldNames.has(k)) {
      if (v && typeof v === "object") (out as any)[k] = jsonSchemaToGeminiSchema(v, root, stack);
      continue;
    }

    if (dictSchemaFieldNames.has(k)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const m: any = {};
        for (const [pk, pv] of Object.entries(v)) {
          if (pv && typeof pv === "object") m[pk] = jsonSchemaToGeminiSchema(pv, root, stack);
        }
        (out as any)[k] = m;
      }
      continue;
    }

    if (listSchemaFieldNames.has(k)) {
      if (Array.isArray(v)) {
        const arr: any[] = [];
        for (const it of v) {
          if (!it || typeof it !== "object") continue;
          if ((it as any).type === "null") {
            out.nullable = true;
            continue;
          }
          arr.push(jsonSchemaToGeminiSchema(it, root, stack));
        }
        out.anyOf = arr;
      }
      continue;
    }

    if (k === "required" || k === "propertyOrdering") {
      if (Array.isArray(v)) {
        const list = v.filter((x: any) => typeof x === "string" && x.trim());
        if (list.length) (out as any)[k] = list;
      }
      continue;
    }

    if (k === "enum") {
      if (Array.isArray(v)) {
        const list = v.filter((x: any) => typeof x === "string");
        if (list.length) out.enum = list;
      }
      continue;
    }

    if (k === "format" || k === "title" || k === "description" || k === "pattern") {
      if (typeof v === "string" && v.trim()) (out as any)[k] = v;
      continue;
    }

    if (k === "nullable") {
      if (typeof v === "boolean") out.nullable = v;
      continue;
    }

    if (k === "minimum" || k === "maximum") {
      if (typeof v === "number" && Number.isFinite(v)) (out as any)[k] = v;
      continue;
    }

    if (int64FieldNames.has(k)) {
      if (typeof v === "number" && Number.isFinite(v)) (out as any)[k] = String(Math.trunc(v));
      else if (typeof v === "string" && v.trim()) (out as any)[k] = v.trim();
      continue;
    }

    if (k === "default" || k === "example") {
      (out as any)[k] = v;
      continue;
    }
  }

  // Gemini Schema types are enum-like uppercase strings; if absent but properties exist, treat as OBJECT.
  if (!out.type && out.properties && typeof out.properties === "object") out.type = "OBJECT";
  return out;
}

