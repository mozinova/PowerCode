const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Theme JSON may hold `null` (VS Code's "unset") or other non-colour values,
 * which make Monaco throw; only valid hex colours are kept.
 */
export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR.test(value);
}

/** Monaco token rules take `RRGGBB` without `#` or alpha. */
export function ruleColor(value: unknown): string | undefined {
  if (!isHexColor(value)) return undefined;
  let hex = value.slice(1);
  if (hex.length <= 4) hex = [...hex.slice(0, 3)].map((c) => c + c).join("");
  return hex.slice(0, 6);
}
