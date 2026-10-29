import { promises as fs, readFileSync } from "node:fs";

/** Code is mostly English, so these stop words always apply, whatever the task language is. */
const EN = ["the", "and", "for", "how", "what", "where", "with", "from", "that", "this", "change", "fix", "add", "use"];

/**
 * A language pack: stop words and a small glossary that maps task words to code words, because tasks are often written in
 * another language than the code. A hint, not a translator: the original word is kept and the mapped words are added.
 */
export interface LanguagePack { name: string; stopwords: string[]; glossary: Record<string, string[]> }

const NONE: LanguagePack = { name: "none", stopwords: [], glossary: {} };

function validatePack(data: unknown, name: string): LanguagePack {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("language pack must be a JSON object");
  const d = data as { stopwords?: unknown; glossary?: unknown };
  if (d.stopwords !== undefined && (!Array.isArray(d.stopwords) || d.stopwords.some((x) => typeof x !== "string"))) throw new Error("language pack stopwords must be an array of strings");
  const glossary = d.glossary ?? {};
  if (!glossary || typeof glossary !== "object" || Array.isArray(glossary)) throw new Error("language pack glossary must be an object");
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(glossary)) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`glossary for "${k}" must be an array of strings`);
    out[k.toLowerCase()] = v as string[];
  }
  return { name, stopwords: ((d.stopwords as string[] | undefined) ?? []).map((w) => w.toLowerCase()), glossary: out };
}

/** The packs that ship with cbtg live in `lang/<name>.json` next to `dist/`. */
const packFile = (name: string) => new URL(`../lang/${name}.json`, import.meta.url);

/** Dutch stays the default so existing users see no change; it is data now, not code. */
export const DEFAULT_LANGUAGE = "nl";
export const DEFAULT_PACK: LanguagePack = validatePack(JSON.parse(readFileSync(packFile(DEFAULT_LANGUAGE), "utf8")), DEFAULT_LANGUAGE);

/**
 * Resolve `--lang`: a built-in name (`nl`), `none` (no stop words or glossary of your own language), or the path to a
 * JSON pack `{ "stopwords": [...], "glossary": { "word": ["codeword"] } }` for any other language.
 */
export async function loadLanguage(spec: string = DEFAULT_LANGUAGE): Promise<LanguagePack> {
  if (spec === "none") return NONE;
  if (spec === DEFAULT_LANGUAGE) return DEFAULT_PACK;
  if (/^[a-z]{2,3}$/.test(spec)) {
    const text = await fs.readFile(packFile(spec), "utf8").catch(() => { throw new Error(`unknown language "${spec}": use nl, none, or the path to a JSON language pack`); });
    return validatePack(JSON.parse(text), spec);
  }
  return validatePack(JSON.parse(await fs.readFile(spec, "utf8")), spec);
}

let active: LanguagePack = DEFAULT_PACK;
/** Choose the language pack that `taskWords` uses when no pack is passed (the CLI sets this from `--lang`). */
export function useLanguage(pack: LanguagePack): void { active = pack; }

/** Stop words of a language pack plus the English ones that always apply. */
export function stopWords(pack: LanguagePack = active): Set<string> { return new Set([...EN, ...pack.stopwords]); }

/** Words used for matching: lower-cased, stop words dropped, glossary and user synonyms added. */
export function taskWords(task: string, synonyms: Record<string, string[]> = {}, pack: LanguagePack = active): string[] {
  const stop = stopWords(pack);
  const base = task.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !stop.has(w));
  const out = new Set(base);
  for (const w of base) for (const x of [...(pack.glossary[w] ?? []), ...(synonyms[w] ?? [])]) out.add(x.toLowerCase());
  return [...out];
}

/** Optional user glossary: `{ "inloggen": ["login", "auth"] }`. Anything that is not a map of string arrays is rejected. */
export async function loadSynonyms(file: string): Promise<Record<string, string[]>> {
  const data = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("synonyms file must be a JSON object");
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(data)) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`synonyms for "${k}" must be an array of strings`);
    out[k.toLowerCase()] = v as string[];
  }
  return out;
}
