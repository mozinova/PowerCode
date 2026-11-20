// Links found in terminal text, and the paths a written path may mean.
import { describe, expect, test } from "bun:test";
import { findLinks, resolveCandidates } from "../../src/terminal/linkMatching";

const texts = (line: string) => findLinks(line).map((f) => line.slice(f.start, f.start + f.length));

describe("findLinks", () => {
  test("URLs without the sentence's punctuation", () => {
    const line = "Local:   http://localhost:1420/. See (https://en.wikipedia.org/wiki/Rust_(language)).";
    expect(findLinks(line).filter((f) => f.kind === "url").map((f) => f.target)).toEqual([
      "http://localhost:1420/",
      "https://en.wikipedia.org/wiki/Rust_(language)",
    ]);
  });

  test("paths with a line and column", () => {
    const [link] = findLinks("error[E0425]: cannot find value `x` --> src/main.rs:12:5");
    expect(link).toMatchObject({ kind: "path", target: "src/main.rs", line: 12, column: 5 });
    expect(texts("src/a.ts(3,7): error TS2304")).toEqual(["src/a.ts(3,7)"]);
    expect(findLinks("src/a.ts(3,7): error")[0]).toMatchObject({ target: "src/a.ts", line: 3, column: 7 });
  });

  test("absolute Windows and Unix paths, bare file names", () => {
    expect(texts("Compiling powercode v0.1.91 (C:\\Users\\mozin\\powercode\\PowerCode\\src-tauri)")).toEqual([
      "C:\\Users\\mozin\\powercode\\PowerCode\\src-tauri",
    ]);
    expect(texts("wrote /home/daniel/app/out.log and package.json.")).toEqual(["/home/daniel/app/out.log", "package.json"]);
  });

  test("a URL is not also read as paths", () => {
    expect(findLinks("open https://github.com/mozinova/PowerCode/releases now").map((f) => f.kind)).toEqual(["url"]);
  });

  test("Python tracebacks", () => {
    const [link] = findLinks('  File "C:\\w\\app.py", line 42, in main');
    expect(link).toMatchObject({ kind: "path", target: "C:\\w\\app.py", line: 42 });
  });

  test("words and versions are not paths", () => {
    expect(findLinks("hello world v1 0.1.92 done")).toEqual([]);
  });
});

describe("resolveCandidates", () => {
  test("relative paths from the terminal's folder, then the project", () => {
    expect(resolveCandidates("./src/a.ts", "C:\\w\\sub", "C:\\w", true)).toEqual(["C:\\w\\sub\\src\\a.ts", "C:\\w\\src\\a.ts"]);
  });

  test("Git Bash's /c/ paths on Windows", () => {
    expect(resolveCandidates("/c/Users/mozin/a.ts", "C:\\w", "C:\\w", true)).toEqual(["C:/Users/mozin/a.ts"]);
  });

  test("Linux paths on the terminal's WSL distribution and SSH host", () => {
    const wsl = "\\\\wsl.localhost\\Ubuntu\\home\\daniel\\CMS";
    expect(resolveCandidates("/etc/hosts", wsl, wsl, true)).toEqual(["\\\\wsl.localhost\\Ubuntu\\etc\\hosts"]);
    expect(resolveCandidates("src/a.ts", wsl, wsl, true)).toEqual(["\\\\wsl.localhost\\Ubuntu\\home\\daniel\\CMS\\src\\a.ts"]);
    expect(resolveCandidates("src/a.ts", "ssh://box/srv/app", "ssh://box/srv/app", true)).toEqual(["ssh://box/srv/app/src/a.ts"]);
  });
});
