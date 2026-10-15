/** Custom element tags (`app-foo`) used in an Angular template. Regex scan: comments are not stripped, so a commented-out tag still counts. */
export function customElements(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]*)[\s/>]/g)) out.add(m[1]);
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** A selector we can match by tag name: a single plain element selector like `app-login`. */
export function elementSelector(selector: string): string | undefined {
  return /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(selector.trim()) ? selector.trim() : undefined;
}
