//! Prompts and cleaning for natural language terminal commands.

export function terminalCommandPrompt(query: string, cwd: string | null, profile: string | null): string {
  const isWin = typeof navigator !== "undefined" && navigator.userAgent.includes("Windows");
  const isMac = typeof navigator !== "undefined" && navigator.userAgent.includes("Mac");
  const osName = isWin ? "Windows" : isMac ? "macOS" : "Linux";
  const shellName = profile || (isWin ? "PowerShell" : "bash");

  return [
    `You are a CLI command generator. Translate the user's natural language request into a single terminal command for ${osName} (${shellName}).`,
    cwd ? `Working directory: ${cwd}` : "",
    `User request: "${query}"`,
    "",
    "Rules:",
    "- Output ONLY the exact shell command line.",
    "- Do NOT enclose in markdown code blocks or backticks.",
    "- Do NOT include explanations, comments, or notes.",
    "- The response must be immediately runnable by pressing Enter in the terminal.",
  ].filter(Boolean).join("\n");
}

export function cleanTerminalCommand(text: string): string {
  let cmd = text.trim();
  const fenced = /^```[\w-]*\r?\n([\s\S]*?)\r?\n```$/.exec(cmd);
  if (fenced) cmd = fenced[1].trim();
  if (cmd.startsWith("`") && cmd.endsWith("`") && cmd.length >= 2) {
    cmd = cmd.slice(1, -1).trim();
  }
  const lines = cmd.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  return lines[0] ?? cmd;
}
