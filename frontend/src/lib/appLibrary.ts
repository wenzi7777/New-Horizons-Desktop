import { useI18n } from "../i18n";
import type { Locale } from "../i18n";

/** A per-locale string from the catalog. Only `en` is guaranteed. */
export type Localised = Partial<Record<Locale, string>> & { en: string };

export type AppPackageRef = {
  url: string;
  sha256: string;
  size: number;
};

export type AppCatalogEntry = {
  id: string;
  name: Localised;
  summary: Localised;
  version: string;
  author: string;
  license?: string;
  category?: string;
  capabilities?: string[];
  min_os: string;
  nodes?: number;
  estimated_us?: number;
  memory_bytes?: number;
  device_path: string;
  icon_url?: string;
  readme_url?: Partial<Record<Locale, string>>;
  homepage?: string;
  package: AppPackageRef;
};

export type AppCatalog = {
  items: AppCatalogEntry[];
  generated_at?: string;
  cell_count?: number;
  source?: string;
  /** True when the backend served a cached copy because the library was unreachable. */
  stale?: boolean;
  error?: string | null;
};

/** A validated package, ready to be written to a device. */
export type AppPackage = {
  id: string;
  version: string;
  min_os: string;
  nodes: number;
  capabilities: string[];
  device_path: string;
  sha256: string;
  size: number;
  cache_key: string;
  /** Hex, because `file_write_chunk` takes hex -- no re-encoding on the way out. */
  data_hex: string;
};

/** Resolve a localised catalog string, falling back to English. */
export function localised(value: Localised | string | undefined, locale: Locale): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value[locale] || value.en || "";
}

export function useLocalised() {
  const { locale } = useI18n();
  return (value: Localised | string | undefined) => localised(value, locale);
}

/** Compare `v1.2.3`-style versions, tolerating the `v` prefix the firmware uses. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) =>
    String(value || "").replace(/^v/i, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

/** True when a device running `firmwareVersion` can run this app. */
export function satisfiesMinOs(entry: AppCatalogEntry, firmwareVersion: string | undefined): boolean {
  if (!firmwareVersion) return true; // unknown firmware: let the device decide
  return compareVersions(firmwareVersion, entry.min_os) >= 0;
}

export function categoriesOf(items: AppCatalogEntry[]): string[] {
  const seen = new Set<string>();
  items.forEach((item) => seen.add(item.category || "other"));
  return Array.from(seen).sort();
}
