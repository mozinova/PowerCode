//! Binary data in webview messages. The RPC is JSON, where a `Uint8Array` would
//! become `{"0":123,"1":125}`; so `ArrayBuffer`s and typed arrays (views with an
//! offset included) travel as `{ $pcBytes: <base64>, kind }` and are rebuilt on
//! the other side. The webview page uses the same format (src/exthost/webviewBinary.ts).

const MARKER = "$pcBytes";

type Encoded = { [MARKER]: string; kind: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;

/** `value` with its binary data encoded; the same object when it has none. */
export function encodeBinary(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return { [MARKER]: Buffer.from(value).toString("base64"), kind: "ArrayBuffer" };
  if (ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64");
    // A Node Buffer is a Uint8Array to the page, which has no Buffer.
    const kind = value instanceof DataView ? "DataView" : Buffer.isBuffer(value) ? "Uint8Array" : value.constructor.name;
    return { [MARKER]: bytes, kind };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = encodeBinary(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (isPlainObject(value)) {
    let out: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const next = encodeBinary(item);
      if (next !== item) (out ??= { ...value })[key] = next;
    }
    return out ?? value;
  }
  return value;
}

const isEncoded = (value: unknown): value is Encoded =>
  isPlainObject(value) && typeof value[MARKER] === "string" && typeof value.kind === "string";

function rebuild({ [MARKER]: base64, kind }: Encoded): unknown {
  // A copy in its own buffer: offset 0, so any element size is aligned.
  const bytes = new Uint8Array(Buffer.from(base64, "base64"));
  if (kind === "ArrayBuffer") return bytes.buffer;
  if (kind === "DataView") return new DataView(bytes.buffer);
  const Type = (globalThis as Record<string, unknown>)[kind];
  return typeof Type === "function" && kind.endsWith("Array") && kind !== "Array"
    ? new (Type as new (buffer: ArrayBuffer) => unknown)(bytes.buffer)
    : bytes;
}

/** `value` with encoded binary data rebuilt; the same object when it has none. */
export function decodeBinary(value: unknown): unknown {
  if (isEncoded(value)) return rebuild(value);
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = decodeBinary(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? out : value;
  }
  if (isPlainObject(value)) {
    let out: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) {
      const next = decodeBinary(item);
      if (next !== item) (out ??= { ...value })[key] = next;
    }
    return out ?? value;
  }
  return value;
}
