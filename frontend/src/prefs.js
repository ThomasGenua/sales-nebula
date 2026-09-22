/**
 * How the signed-in user reads dates, times and numbers.
 *
 * Every date on screen was formatted in the browser's own locale and time
 * zone, with no way to choose: a rep travelling, or a team spread across
 * zones, read the same deadline at different hours. The profile now stores a
 * time zone and a locale, and every toLocale*String() call takes its
 * arguments from here. Unset, both fall back to the browser, as before.
 */
let current = { locale: undefined, timeZone: undefined };

export function setUserPrefs(user) {
  current = { locale: user?.locale || undefined, timeZone: user?.timezone || undefined };
}

/**
 * Arguments for toLocaleString / toLocaleDateString / toLocaleTimeString:
 * `date.toLocaleDateString(...fmt({ month: "short" }))`. Numbers ignore the
 * time zone and take the locale.
 */
export function fmt(options = {}) {
  return [current.locale, current.timeZone ? { ...options, timeZone: current.timeZone } : options];
}

/** Time zones this browser knows, for the profile picker. */
export function timeZones() {
  try { return Intl.supportedValuesOf("timeZone"); } catch { return ["UTC"]; }
}

/** Locales offered on the profile; any valid BCP 47 tag is accepted by the API. */
export const LOCALES = [
  ["en-US", "English (United States)"], ["en-GB", "English (United Kingdom)"], ["en-CA", "English (Canada)"],
  ["en-AU", "English (Australia)"], ["en-IN", "English (India)"], ["fr-FR", "Français (France)"],
  ["fr-CA", "Français (Canada)"], ["de-DE", "Deutsch (Deutschland)"], ["es-ES", "Español (España)"],
  ["es-MX", "Español (México)"], ["it-IT", "Italiano (Italia)"], ["pt-BR", "Português (Brasil)"],
  ["nl-NL", "Nederlands (Nederland)"], ["sv-SE", "Svenska (Sverige)"], ["pl-PL", "Polski (Polska)"],
  ["ja-JP", "日本語 (日本)"], ["zh-CN", "中文 (中国)"], ["ko-KR", "한국어 (대한민국)"],
];
