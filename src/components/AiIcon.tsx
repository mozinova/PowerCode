//! Logos of the AI programs and model makers, for pickers (see assets/ai/NOTICE.md).
//! Inlined, so the monochrome ones take the text color.

import claude from "../assets/ai/claude.svg?raw";
import codex from "../assets/ai/codex.svg?raw";
import openai from "../assets/ai/openai.svg?raw";
import opencode from "../assets/ai/opencode.svg?raw";
import type { AiProviderId } from "../lib/ipc";

const ICONS = { claude, codex, openai, opencode };

export type AiIconName = keyof typeof ICONS;

export function AiIcon({ name, size = 14 }: { name: AiIconName; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 [&>svg]:size-full"
      style={{ width: size, height: size }}
      // Local, trusted files (no scripts or links).
      dangerouslySetInnerHTML={{ __html: ICONS[name] }}
    />
  );
}

export function providerIcon(provider: AiProviderId): AiIconName {
  return provider;
}

/** A model's maker: Claude Code's are Claude, Codex's are OpenAI's, OpenCode's say (`anthropic/...`). */
export function modelIcon(provider: AiProviderId, model: string): AiIconName {
  if (provider === "claude") return "claude";
  if (provider === "codex") return "openai";
  const maker = model.split("/")[0].toLowerCase();
  if (maker === "anthropic" || /claude/i.test(model)) return "claude";
  if (maker === "openai" || /\bgpt|codex/i.test(model)) return "openai";
  return "opencode";
}
