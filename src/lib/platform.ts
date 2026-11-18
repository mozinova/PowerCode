/** Name of the OS file manager action, e.g. in context menus. */
export const REVEAL_LABEL = navigator.userAgent.includes("Windows")
  ? "Reveal in Explorer"
  : navigator.userAgent.includes("Mac")
    ? "Reveal in Finder"
    : "Reveal in File Manager";

export const IS_WINDOWS = navigator.userAgent.includes("Windows");

/** Key for comparing paths: Windows paths are case-insensitive. */
export function pathKey(path: string): string {
  return IS_WINDOWS ? path.toLowerCase() : path;
}
