// Binary data in webview messages keeps its type through the JSON of the RPC, both ways
// (issue #1: Codex's webview got `{"0":123,"1":125}` for a Uint8Array).
// Run with `bun test`.

import { describe, expect, test } from "bun:test";
import { WEBVIEW_BINARY_CODEC } from "../../src/exthost/webviewBinary";
import { decodeBinary, encodeBinary } from "../src/binary";

/** The page's functions, as the webview bootstrap defines them. */
const page = new Function(`${WEBVIEW_BINARY_CODEC}; return { encode: pcEncodeBinary, decode: pcDecodeBinary };`)() as {
  encode: (value: unknown) => unknown;
  decode: (value: unknown) => unknown;
};

/** What crossing the RPC does to a message. */
const overJson = (value: unknown) => JSON.parse(JSON.stringify(value));

describe("extension → webview", () => {
  test("nested Uint8Array arrives as a Uint8Array", () => {
    const message = { type: "response", body: { kind: "bytes", value: new Uint8Array([123, 125]) }, list: [new Uint8Array([1, 2, 3])] };
    const received = page.decode(overJson(encodeBinary(message))) as any;
    expect(received.body.value).toBeInstanceOf(Uint8Array);
    expect([...received.body.value]).toEqual([123, 125]);
    expect(new TextDecoder().decode(received.body.value)).toBe("{}");
    expect([...received.list[0]]).toEqual([1, 2, 3]);
    expect(received.type).toBe("response");
  });

  test("a view with an offset sends only its own bytes", () => {
    const buffer = new Uint8Array([9, 9, 1, 2, 3, 9]).buffer;
    const view = new Uint8Array(buffer, 2, 3);
    const received = page.decode(overJson(encodeBinary({ data: view }))) as { data: Uint8Array };
    expect(received.data).toBeInstanceOf(Uint8Array);
    expect([...received.data]).toEqual([1, 2, 3]);
    expect(received.data.byteOffset).toBe(0);
  });

  test("other kinds keep their type: Buffer as Uint8Array, Int16Array, ArrayBuffer, DataView", () => {
    const int16 = new Int16Array([-2, 300]);
    const received = page.decode(
      overJson(encodeBinary({ buffer: Buffer.from("hi"), int16, raw: new Uint8Array([7, 8]).buffer, view: new DataView(new Uint8Array([5, 6]).buffer) })),
    ) as any;
    expect(received.buffer.constructor).toBe(Uint8Array);
    expect(new TextDecoder().decode(received.buffer)).toBe("hi");
    expect(received.int16).toBeInstanceOf(Int16Array);
    expect([...received.int16]).toEqual([-2, 300]);
    expect(received.raw).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(received.raw)]).toEqual([7, 8]);
    expect(received.view).toBeInstanceOf(DataView);
    expect(received.view.getUint8(1)).toBe(6);
  });
});

describe("webview → extension", () => {
  test("binary data the page posts reaches the extension typed", () => {
    const view = new Uint8Array([0, 0, 200, 201]).subarray(2);
    const received = decodeBinary(overJson(page.encode({ command: "save", chunks: [view, new Float32Array([1.5])] }))) as any;
    expect(received.command).toBe("save");
    expect(received.chunks[0]).toBeInstanceOf(Uint8Array);
    expect([...received.chunks[0]]).toEqual([200, 201]);
    expect(received.chunks[1]).toBeInstanceOf(Float32Array);
    expect(received.chunks[1][0]).toBe(1.5);
  });
});

describe("messages without binary data", () => {
  test("pass through unchanged, as the same objects", () => {
    const message = { a: [1, { b: "x" }], c: null, d: { $notBytes: 1 } };
    expect(encodeBinary(message)).toBe(message);
    expect(decodeBinary(message)).toBe(message);
    expect(page.encode(message)).toBe(message);
    expect(page.decode(message)).toBe(message);
  });

  test("an object that merely resembles the encoding stays as it is when incomplete", () => {
    const message = { $pcBytes: 42, kind: "Uint8Array" };
    expect(decodeBinary(message)).toBe(message);
    expect(page.decode(message)).toBe(message);
  });
});
