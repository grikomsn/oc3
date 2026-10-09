/** Mask an API key for display: `…7890` (last four characters), `••••••` for short keys, or "not set". */
export function maskKey(value: string | undefined): string {
  if (!value) return "not set";
  if (value.length <= 8) return "••••••";
  return `…${value.slice(-4)}`;
}
