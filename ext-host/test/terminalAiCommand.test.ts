import { describe, expect, test } from "bun:test";
import { cleanTerminalCommand } from "../../src/terminal/aiCommand";

describe("cleanTerminalCommand", () => {
  test("plain command stays unchanged", () => {
    expect(cleanTerminalCommand("git status")).toBe("git status");
    expect(cleanTerminalCommand("npm run build")).toBe("npm run build");
  });

  test("strips fenced code blocks", () => {
    const raw = "```bash\nfind . -name \"*.ts\"\n```";
    expect(cleanTerminalCommand(raw)).toBe("find . -name \"*.ts\"");
  });

  test("strips markdown inline backticks", () => {
    expect(cleanTerminalCommand("`docker ps -a`")).toBe("docker ps -a");
  });

  test("picks the first non-comment line when multiple lines returned", () => {
    const raw = "# Run this command:\ngit checkout -b feature/test\n# done";
    expect(cleanTerminalCommand(raw)).toBe("git checkout -b feature/test");
  });
});
