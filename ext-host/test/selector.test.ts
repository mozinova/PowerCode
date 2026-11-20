// `languages.match` scores document selectors as VS Code does. A selector with only a
// pattern (GitHub Actions: `{ pattern: "**/.github/workflows/*.yml" }`) once matched
// every document, so its YAML language server reported errors in every file.
// Run with `bun test`.

import { describe, expect, test } from "bun:test";
import { match } from "../src/providers";
import { RelativePattern, Uri } from "../src/types";

const doc = (path: string, languageId: string, scheme = "file") => ({
  languageId,
  uri: scheme === "file" ? Uri.file(path) : Uri.parse(`${scheme}:${path}`),
});

describe("document selectors", () => {
  const workflow = doc("C:/work/app/.github/workflows/ci.yml", "yaml");
  const readme = doc("C:/work/app/README.md", "markdown");

  test("a pattern only matches the files it names", () => {
    const selector = [{ pattern: "**/.github/workflows/*.{yaml,yml}" }, { pattern: "**/action.{yml,yaml}" }];
    expect(match(selector, workflow)).toBe(10);
    expect(match(selector, readme)).toBe(0);
    expect(match(selector, doc("C:/work/app/action.yaml", "yaml"))).toBe(10);
  });

  test("language, scheme and pattern must all match", () => {
    expect(match({ language: "typescript", scheme: "file" }, doc("C:/a.ts", "typescript"))).toBe(10);
    expect(match({ language: "typescript", scheme: "file" }, doc("/a.ts", "typescript", "untitled"))).toBe(0);
    expect(match({ language: "yaml", pattern: "**/*.yml" }, doc("C:/x/a.yml", "markdown"))).toBe(0);
    expect(match({ scheme: "*" }, readme)).toBe(5);
  });

  test("strings and `*`", () => {
    expect(match("markdown", readme)).toBe(10);
    expect(match("*", readme)).toBe(5);
    expect(match(["yaml", "*"], readme)).toBe(5);
    expect(match("rust", readme)).toBe(0);
  });

  test("relative patterns are matched under their base", () => {
    const selector = { pattern: new RelativePattern(Uri.file("C:/work/app"), "src/**/*.rs") };
    expect(match(selector, doc("C:/work/app/src/main.rs", "rust"))).toBe(10);
    expect(match(selector, doc("C:/other/src/main.rs", "rust"))).toBe(0);
  });

  test("empty filters and notebook filters match no text document", () => {
    expect(match({}, readme)).toBe(0);
    expect(match({ notebookType: "jupyter-notebook", language: "python" }, doc("C:/a.py", "python"))).toBe(0);
  });
});
