import type { Locale } from "../i18n";

/*
 * Release notes come in up to three files per version, side by side in every
 * repo:
 *
 *   vX.Y.Z.md      Traditional Chinese -- always there, the one every manifest
 *                  links (older firmware/Hub/Gateway know only this URL)
 *   vX.Y.Z.ja.md   Japanese
 *   vX.Y.Z.en.md   English
 *
 * Older releases have only the first, so every lookup falls back to it. The
 * Chinese UI (Simplified) reads the Traditional original.
 */

export type NotesLanguage = "zh" | "ja" | "en";

export function notesLanguageFor(locale: Locale): NotesLanguage {
  if (locale === "ja") return "ja";
  if (locale === "en") return "en";
  return "zh";
}

// The translated sibling of a notes URL, or null when the original is wanted
// or the URL does not name a .md file.
export function localizedNotesUrl(url: string, locale: Locale): string | null {
  const language = notesLanguageFor(locale);
  if (language === "zh") return null;
  const match = /^(.*\/v[^/?#]+?)\.md([?#].*)?$/.exec(url);
  if (!match || /\.(ja|en)$/.test(match[1])) return null;
  return `${match[1]}.${language}.md${match[2] ?? ""}`;
}

// Fetches the notes in the UI language, falling back to the original when no
// translation exists. Errors are the original's, as before.
export async function fetchReleaseNotes(
  url: string,
  locale: Locale,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const localized = localizedNotesUrl(url, locale);
  if (localized) {
    try {
      const response = await fetchImpl(localized);
      if (response.ok) {
        const text = (await response.text()).trim();
        if (text) return text;
      }
    } catch {
      // No translation reachable: use the original below.
    }
  }
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`http_${response.status}`);
  return (await response.text()).trim();
}

// "v1.2.3.md" -> { version: "v1.2.3", language: "zh" }, "v1.2.3.ja.md" -> ja.
export function parseNotesFileName(name: string): { version: string; language: NotesLanguage } | null {
  const match = /^(v[^/]+?)(?:\.(ja|en))?\.md$/.exec(name);
  if (!match) return null;
  return { version: match[1], language: (match[2] as NotesLanguage | undefined) ?? "zh" };
}

// Groups note files by version; each version keeps the loader for every
// language it has.
export function groupNotesByVersion<T>(
  entries: { name: string; value: T }[],
): Map<string, Partial<Record<NotesLanguage, T>>> {
  const versions = new Map<string, Partial<Record<NotesLanguage, T>>>();
  for (const { name, value } of entries) {
    const parsed = parseNotesFileName(name);
    if (!parsed) continue;
    const languages = versions.get(parsed.version) ?? {};
    languages[parsed.language] = value;
    versions.set(parsed.version, languages);
  }
  return versions;
}

// The language to show for one version: the UI's, else the original, else
// whatever exists.
export function pickNotes<T>(languages: Partial<Record<NotesLanguage, T>>, locale: Locale): T | undefined {
  return languages[notesLanguageFor(locale)] ?? languages.zh ?? languages.en ?? languages.ja;
}
