/**
 * What an Angular template uses that may be declared in our code: custom element tags (`app-foo`), camelCase attributes
 * (`[appFoo]`, from `appFoo`, `[appFoo]=` or `(appFoo)=`) and pipes (`|money`, inside `{{ }}` or a quoted binding).
 * Regex scan: comments are not stripped, so a commented-out use still counts. Built-in names simply match no owner.
 */
export function customElements(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<([a-z][a-z0-9]*-[a-z0-9-]*)[\s/>]/g)) out.add(m[1]);
  for (const m of html.matchAll(/[\s[(*]([a-z]+[A-Z]\w*)[\])]*\s*(?==|\s|>|\/)/g)) out.add(`[${m[1]}]`);
  const bindings = [...html.matchAll(/\{\{([\s\S]*?)\}\}/g), ...html.matchAll(/="([^"]*)"/g)];
  for (const b of bindings) for (const m of b[1].matchAll(/(?<!\|)\|(?!\|)\s*([A-Za-z_]\w*)/g)) out.add(`|${m[1]}`);
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** A directive selector we can match by attribute name: `[appFoo]` or `button[appFoo]`. */
export function attributeSelector(selector: string): string | undefined {
  const m = /^(?:[a-z][a-z0-9-]*)?\[([a-z]+[A-Z]\w*)\]$/.exec(selector.trim());
  return m ? `[${m[1]}]` : undefined;
}

/** A selector we can match by tag name: a single plain element selector like `app-login`. */
export function elementSelector(selector: string): string | undefined {
  return /^[a-z][a-z0-9]*-[a-z0-9-]*$/.test(selector.trim()) ? selector.trim() : undefined;
}
