export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

export type JsonObject = { readonly [key: string]: Json };

/**
 * `strip` drops object keys the schema does not name. Inputs use it, so a
 * newer client can send a field an older server ignores. `strict` refuses
 * them. Outputs use it, so a projection that grows a field its contract does
 * not list fails loudly and never reaches a socket.
 */
export type ParseMode = "strip" | "strict";

export class SchemaError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path || "value"}: ${message}`);
    this.name = "SchemaError";
    this.path = path;
  }
}

export interface Schema<T> {
  parse(input: unknown, mode?: ParseMode, path?: string): T;
}

export type OptionalSchema<T> = Schema<T | undefined> & {
  readonly optional: true;
};

export type Infer<S> = S extends Schema<infer T> ? T : never;

type Shape = Record<string, Schema<unknown>>;
type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends { readonly optional: true } ? K : never;
}[keyof S];
type Simplify<T> = { [K in keyof T]: T[K] } & {};

export type InferShape<S extends Shape> = Simplify<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
    [K in OptionalKeys<S>]?: Exclude<Infer<S[K]>, undefined>;
  }
>;

const fail = (path: string, message: string): never => {
  throw new SchemaError(path, message);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

type StringOptions = {
  min?: number;
  max: number;
  /** Collapse runs of whitespace to one space and trim the ends. */
  collapse?: boolean;
  /** Cut a longer string to `max` and keep it. Without this it is refused. */
  truncate?: boolean;
  /**
   * What the whole string must match, tried after the length is settled so
   * it only ever runs on a string of at most `max` characters. It may not be
   * global or sticky: `test()` on such an expression moves its `lastIndex`,
   * so one schema would take a value on one call and refuse it on the next.
   */
  pattern?: RegExp;
};

const string = (options: StringOptions): Schema<string> => {
  if (options.pattern?.global || options.pattern?.sticky) {
    throw new Error(
      `A string schema's pattern may not have the g or y flag: /${options.pattern.source}/${options.pattern.flags}`,
    );
  }
  return {
    parse(input, _mode, path = "") {
      if (typeof input !== "string") return fail(path, "expected a string");
      let value = options.collapse ? input.replace(/\s+/g, " ").trim() : input;
      if (value.length > options.max) {
        if (!options.truncate) return fail(path, `longer than ${options.max}`);
        value = value.slice(0, options.max);
      }
      if (value.length < (options.min ?? 0)) {
        return fail(path, `shorter than ${options.min}`);
      }
      if (options.pattern && !options.pattern.test(value)) {
        return fail(path, `does not match ${options.pattern.source}`);
      }
      return value;
    },
  };
};

type NumberOptions = { min?: number; max?: number };

const numberWith =
  (integer: boolean) =>
  (options: NumberOptions = {}): Schema<number> => ({
    parse(input, _mode, path = "") {
      if (typeof input !== "number" || !Number.isFinite(input)) {
        return fail(path, "expected a finite number");
      }
      if (integer && !Number.isInteger(input)) {
        return fail(path, "expected an integer");
      }
      if (options.min !== undefined && input < options.min) {
        return fail(path, `below ${options.min}`);
      }
      if (options.max !== undefined && input > options.max) {
        return fail(path, `above ${options.max}`);
      }
      return input;
    },
  });

const boolean = (): Schema<boolean> => ({
  parse(input, _mode, path = "") {
    return typeof input === "boolean" ? input : fail(path, "expected a boolean");
  },
});

const nullValue = (): Schema<null> => ({
  parse(input, _mode, path = "") {
    return input === null ? null : fail(path, "expected null");
  },
});

const oneOf = <const V extends readonly (string | number | boolean)[]>(
  values: V,
): Schema<V[number]> => ({
  parse(input, _mode, path = "") {
    const match = values.find((value) => value === input);
    return match === undefined
      ? fail(path, `expected one of ${values.join(", ")}`)
      : match;
  },
});

const array = <T>(
  item: Schema<T>,
  options: { min?: number; max: number },
): Schema<T[]> => ({
  parse(input, mode, path = "") {
    if (!Array.isArray(input)) return fail(path, "expected an array");
    if (input.length > options.max) {
      return fail(path, `more than ${options.max} items`);
    }
    if (input.length < (options.min ?? 0)) {
      return fail(path, `fewer than ${options.min} items`);
    }
    return input.map((entry, index) =>
      item.parse(entry, mode, `${path}[${index}]`),
    );
  },
});

const object = <S extends Shape>(shape: S): Schema<InferShape<S>> => {
  const keys = Object.keys(shape);
  const known = new Set(keys);
  return {
    parse(input, mode = "strip", path = "") {
      if (!isPlainObject(input)) return fail(path, "expected an object");
      if (mode === "strict") {
        for (const key of Object.keys(input)) {
          if (!known.has(key)) fail(`${path}.${key}`, "unexpected field");
        }
      }
      const output: Record<string, unknown> = {};
      for (const key of keys) {
        const parsed = shape[key].parse(input[key], mode, `${path}.${key}`);
        if (parsed !== undefined) output[key] = parsed;
      }
      return output as InferShape<S>;
    },
  };
};

const optional = <T>(schema: Schema<T>): OptionalSchema<T> => ({
  optional: true,
  parse(input, mode, path) {
    return input === undefined ? undefined : schema.parse(input, mode, path);
  },
});

const nullable = <T>(schema: Schema<T>): Schema<T | null> => ({
  parse(input, mode, path) {
    return input === null ? null : schema.parse(input, mode, path);
  },
});

/** A map with caller-chosen keys, such as option id to vote count. */
const record = <T>(
  value: Schema<T>,
  options: { maxKeys: number; maxKeyLength?: number },
): Schema<Record<string, T>> => ({
  parse(input, mode, path = "") {
    if (!isPlainObject(input)) return fail(path, "expected an object");
    const entries = Object.entries(input);
    if (entries.length > options.maxKeys) {
      return fail(path, `more than ${options.maxKeys} keys`);
    }
    const maxKeyLength = options.maxKeyLength ?? 64;
    const output: Record<string, T> = {};
    for (const [key, entry] of entries) {
      // Assigning these would set the object's prototype, not a key.
      if (
        key.length === 0 ||
        key.length > maxKeyLength ||
        key === "__proto__" ||
        key === "constructor" ||
        key === "prototype"
      ) {
        fail(`${path}.${key}`, "invalid key");
      }
      output[key] = value.parse(entry, mode, `${path}.${key}`);
    }
    return output;
  },
});

export const s = {
  string,
  number: numberWith(false),
  int: numberWith(true),
  boolean,
  null: nullValue,
  oneOf,
  array,
  object,
  optional,
  nullable,
  record,
};

const MAX_JSON_DEPTH = 32;
const utf8 = new TextEncoder();

export const jsonBytes = (encoded: string): number =>
  utf8.encode(encoded).length;

/**
 * Size in bytes of `value` as JSON, or `limit + 1` when it is larger or is
 * not JSON at all. A first pass counts characters and stops as soon as the
 * limit is passed, so a hostile megabyte payload costs a few kilobytes of
 * work to refuse. Only a value that might fit is encoded and measured.
 */
export const boundedJsonBytes = (value: unknown, limit: number): number => {
  const over = limit + 1;
  let floor = 0;
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > MAX_JSON_DEPTH) return false;
    if (typeof node === "string") floor += node.length + 2;
    else if (Array.isArray(node)) {
      floor += 2;
      for (const entry of node) {
        floor += 1;
        if (floor > limit || !visit(entry, depth + 1)) return false;
      }
    } else if (node !== null && typeof node === "object") {
      floor += 2;
      for (const [key, entry] of Object.entries(node)) {
        floor += key.length + 4;
        if (floor > limit || !visit(entry, depth + 1)) return false;
      }
    } else if (
      typeof node === "function" ||
      typeof node === "symbol" ||
      typeof node === "bigint"
    ) {
      return false;
    } else {
      floor += 1;
    }
    return floor <= limit;
  };
  if (!visit(value, 0)) return over;
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? Math.min(jsonBytes(encoded), over) : over;
};
