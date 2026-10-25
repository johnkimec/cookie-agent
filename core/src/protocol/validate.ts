import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

const schemaPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../protocol/schema/cookie-rpc.schema.json",
);

interface SchemaDocument {
  $id: string;
}

const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as SchemaDocument;

const ajv = new Ajv2020({ allErrors: true, strict: true });
ajv.addSchema(schema);

function mustCompile(ref: string): ValidateFunction {
  const validate = ajv.getSchema(ref);
  if (validate === undefined) {
    throw new Error(`Missing schema ${ref}`);
  }
  return validate;
}

const schemaId = schema.$id;
const validateMessage = mustCompile(schemaId);

export const paramDefs = [
  "initializeParams",
  "shutdownParams",
  "chatSendParams",
  "chatCancelParams",
  "chatDeltaParams",
  "chatDoneParams",
  "runtimeStatusParams",
  "emptyParams",
] as const;

export type ParamDef = (typeof paramDefs)[number];

const paramValidators = new Map<ParamDef, ValidateFunction>(
  paramDefs.map((name) => [name, mustCompile(`${schemaId}#/$defs/${name}`)]),
);

export function isCookieMessage(value: unknown): boolean {
  return validateMessage(value) === true;
}

export function messageErrors(value: unknown): string {
  validateMessage(value);
  return ajv.errorsText(validateMessage.errors, { separator: "; " });
}

export function paramsAreValid(def: ParamDef, value: unknown): boolean {
  const validate = paramValidators.get(def);
  if (validate === undefined) {
    throw new Error(`Unknown params schema ${def}`);
  }
  return validate(value) === true;
}

export function paramsErrors(def: ParamDef, value: unknown): string {
  const validate = paramValidators.get(def);
  if (validate === undefined) {
    throw new Error(`Unknown params schema ${def}`);
  }
  validate(value);
  return ajv.errorsText(validate.errors, { separator: "; " });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
