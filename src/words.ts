import { promises as fs } from "node:fs";

const EN = ["the", "and", "for", "how", "what", "where", "with", "from", "that", "this", "change", "fix", "add", "use"];
const NL = ["een", "het", "van", "voor", "met", "hoe", "naar", "bij", "aan", "ook", "niet", "als", "dan", "maar", "uit", "over", "door", "tot", "dat", "die", "dit", "deze", "moet", "moeten", "kan", "kunnen", "wordt", "worden", "zijn", "waar", "wat", "welke", "alle", "andere", "graag", "wil", "zodat", "nieuwe", "aanpassen", "wijzigen", "veranderen", "toevoegen", "gebruiken"];
export const STOPWORDS = new Set([...EN, ...NL]);

/**
 * Small built-in Dutch to English glossary for common development words, because tasks are often written in Dutch while
 * code is English. A hint, not a translator: the original word is kept and the English words are added.
 */
export const GLOSSARY: Record<string, string[]> = {
  inloggen: ["login"], inlog: ["login"], aanmelden: ["login"], uitloggen: ["logout"], afmelden: ["logout"],
  wachtwoord: ["password"], gebruiker: ["user"], gebruikers: ["user"], taal: ["language"], talen: ["language"], vertaling: ["translation", "texts"], vertalen: ["translation", "texts"],
  scherm: ["screen", "window"], venster: ["window"], vensters: ["window"], taakbalk: ["taskbar"], menubalk: ["menu"], bureaublad: ["desktop"],
  opslaan: ["save", "store"], verwijderen: ["delete", "remove"], bestand: ["file"], bestanden: ["file"], instellingen: ["settings", "config"],
  beveiliging: ["security"], beveiligingsheaders: ["security", "header"], sessie: ["session"], koekje: ["cookie"], levensduur: ["lifetime", "expiry"],
  begrenzen: ["limit", "rate"], beperken: ["limit", "rate"], blokkeren: ["lock", "block", "limiter"], pogingen: ["attempts", "rate", "limiter"],
  hoogste: ["highscore", "score"], scores: ["score", "highscore"], punten: ["score"], pagina: ["page"], paginas: ["page"], bezoek: ["pageview", "view"], bezoeken: ["pageview", "view"],
  tabel: ["table"], kolom: ["column"], veld: ["field", "column"], foutmelding: ["error", "exception"], fout: ["error", "exception"], melding: ["message", "notification"],
  geheimen: ["secret"], geheim: ["secret"], omgeving: ["env", "environment"], opstarten: ["start", "boot"], versie: ["version"], koppeling: ["link", "integration"],
};

/** Words used for matching: lower-cased, stop words dropped, glossary and user synonyms added. */
export function taskWords(task: string, synonyms: Record<string, string[]> = {}): string[] {
  const base = task.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  const out = new Set(base);
  for (const w of base) for (const x of [...(GLOSSARY[w] ?? []), ...(synonyms[w] ?? [])]) out.add(x.toLowerCase());
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
