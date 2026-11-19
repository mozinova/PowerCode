//! Binary data in webview messages, on the page's side: the functions the webview
//! bootstrap includes to rebuild what the extension host encoded (and to encode
//! what the page sends back). Same format as ext-host/src/binary.ts:
//! `{ $pcBytes: <base64>, kind: "Uint8Array" | "ArrayBuffer" | "DataView" | ... }`.

/** Plain JavaScript (it runs in the page): defines `pcEncodeBinary` and `pcDecodeBinary`. */
export const WEBVIEW_BINARY_CODEC = `
  var pcIsPlain = function (v) { return !!v && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype; };
  var pcToBase64 = function (bytes) {
    var text = "";
    for (var i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(text);
  };
  var pcFromBase64 = function (base64) {
    var text = atob(base64);
    var bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes;
  };
  /** Walks arrays and plain objects; returns the same value when nothing changed. */
  var pcMap = function (value, convert) {
    var replaced = convert(value);
    if (replaced !== undefined) return replaced;
    if (Array.isArray(value)) {
      var changed = false;
      var list = value.map(function (item) { var next = pcMap(item, convert); if (next !== item) changed = true; return next; });
      return changed ? list : value;
    }
    if (pcIsPlain(value)) {
      var out;
      for (var key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        var next = pcMap(value[key], convert);
        if (next !== value[key]) { if (!out) out = Object.assign({}, value); out[key] = next; }
      }
      return out || value;
    }
    return value;
  };
  var pcEncodeBinary = function (value) {
    return pcMap(value, function (v) {
      if (v instanceof ArrayBuffer) return { $pcBytes: pcToBase64(new Uint8Array(v)), kind: "ArrayBuffer" };
      if (ArrayBuffer.isView(v)) {
        var kind = v instanceof DataView ? "DataView" : v.constructor.name;
        return { $pcBytes: pcToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)), kind: kind };
      }
      return undefined;
    });
  };
  var pcDecodeBinary = function (value) {
    return pcMap(value, function (v) {
      if (!pcIsPlain(v) || typeof v.$pcBytes !== "string" || typeof v.kind !== "string") return undefined;
      var bytes = pcFromBase64(v.$pcBytes);
      if (v.kind === "ArrayBuffer") return bytes.buffer;
      if (v.kind === "DataView") return new DataView(bytes.buffer);
      var Type = globalThis[v.kind];
      return typeof Type === "function" && /Array$/.test(v.kind) && v.kind !== "Array" ? new Type(bytes.buffer) : bytes;
    });
  };
`;
