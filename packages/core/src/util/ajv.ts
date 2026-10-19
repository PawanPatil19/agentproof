import { Ajv2020 } from "ajv/dist/2020.js";
import type { ErrorObject } from "ajv";
import addFormatsModule from "ajv-formats";

// ajv-formats ships CommonJS; under NodeNext its default export arrives wrapped.
const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => Ajv2020;

/**
 * One JSON Schema 2020-12 validator factory for the whole engine.
 * `strict` rejects unknown keywords, so a typo in an output schema is a
 * policy error rather than a silently ignored constraint.
 */
export function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
  addFormats(ajv);
  return ajv;
}

/**
 * Describe validation errors by location only. Values are never echoed,
 * so messages are safe to persist even when the output is sensitive.
 */
export function describeErrors(errors: ErrorObject[] | null | undefined, limit = 3): string {
  if (!errors || errors.length === 0) return "";
  const parts = errors.slice(0, limit).map((e) => {
    const where = e.instancePath === "" ? "(root)" : e.instancePath;
    const extra =
      e.keyword === "additionalProperties"
        ? ` '${String((e.params as { additionalProperty?: string }).additionalProperty)}'`
        : "";
    return `${where} ${e.message ?? e.keyword}${extra}`;
  });
  const more = errors.length > limit ? ` (+${errors.length - limit} more)` : "";
  return parts.join("; ") + more;
}
