/** Require a value whose absence violates the caller's contract. */
export function requireDefined<T>(value: T | undefined, context: string): T {
  if (value === undefined) throw new Error(`Missing required value: ${context}`);
  return value;
}

type DefinedProperties<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Omit absent fields when constructing a plain data object; preserve null and other values. */
export function omitUndefined<T extends object>(value: T): DefinedProperties<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as DefinedProperties<T>;
}

type ScalarObject = Date | Uint8Array | ReadonlyMap<unknown, unknown> | ReadonlySet<unknown>;

type DefinedData<T> = T extends ScalarObject
  ? T
  : T extends readonly unknown[]
    ? { [K in keyof T]: DefinedData<T[K]> }
    : T extends object
      ? { [K in keyof T as undefined extends T[K] ? never : K]: DefinedData<T[K]> } & {
          [K in keyof T as undefined extends T[K] ? K : never]?: DefinedData<
            Exclude<T[K], undefined>
          >;
        }
      : T;

/** Normalize validated configuration/schema data to absent optional properties. */
export function omitUndefinedDeep<T>(value: T): DefinedData<T> {
  if (Array.isArray(value)) return value.map(omitUndefinedDeep) as DefinedData<T>;
  if (value !== null && typeof value === "object") {
    // YAML tags can produce Date, Buffer, and Set values inside unknown fields.
    // Only plain records contain schema properties that need normalization.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return value as DefinedData<T>;
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, omitUndefinedDeep(entry)]),
    ) as DefinedData<T>;
  }
  return value as DefinedData<T>;
}
