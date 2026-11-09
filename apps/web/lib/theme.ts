export type ThemePreference = "light" | "dark" | "system";
export const THEME_KEY = "rooq-theme";

/**
 * Runs in <head> before first paint so the page never flashes the wrong theme. Public pages default to
 * light; the app follows the stored choice, then the OS, then light (04-BRAND/design.md).
 */
export const THEME_BOOTSTRAP = `(function(){var d=document.documentElement;try{var s=localStorage.getItem("${THEME_KEY}");var app=location.pathname.indexOf("/app")===0;var t=(s==="light"||s==="dark")?s:((s==="system"||app)&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");d.dataset.theme=t;d.dataset.themePref=s||"default";}catch(e){d.dataset.theme="light";d.dataset.themePref="default";}})();`;

export function applyTheme(pref: ThemePreference): void {
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.dataset.themePref = pref;
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch (error) {
    console.warn("theme preference not persisted", error);
  }
}

export function readThemePreference(): ThemePreference {
  const pref = document.documentElement.dataset.themePref;
  return pref === "light" || pref === "dark" || pref === "system" ? pref : "system";
}
