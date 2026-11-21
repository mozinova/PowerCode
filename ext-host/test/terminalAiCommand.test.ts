import { describe, expect, test } from "bun:test";
import { cleanTerminalCommand, terminalCommandPrompt } from "../../src/terminal/aiCommand";

test("remote command suggestions use the host directory and shell", () => {
  const wsl = terminalCommandPrompt("list files", "\\\\wsl.localhost\\Ubuntu\\home\\me", "PowerShell");
  expect(wsl).toContain("Linux (WSL)");
  expect(wsl).toContain("Working directory: /home/me");
  expect(wsl).not.toContain("PowerShell");
  const ssh = terminalCommandPrompt("list files", "ssh://build/var/project", null);
  expect(ssh).toContain("POSIX shell syntax");
  expect(ssh).toContain("Working directory: /var/project");
});

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
