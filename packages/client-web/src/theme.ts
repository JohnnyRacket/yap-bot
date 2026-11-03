// Light, dark, or the system's (the default), and the colors: the agent's (ui.colors) with this
// device's picks over them (Settings → Appearance). index.html applies light/dark before the first
// paint too.
import { useSyncExternalStore } from "react";
import type { UiColors, UiPalette } from "yap-bot/protocol";

export type ThemeChoice = "system" | "light" | "dark";
export type Scheme = "light" | "dark";
export type ColorKey = keyof UiPalette;
type DeviceColors = Partial<Record<Scheme, UiPalette>>;

const THEME_KEY = "yap-bot-theme";
const COLORS_KEY = "yap-bot-colors";
const media = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

let choice = (localStorage.getItem(THEME_KEY) as ThemeChoice | null) ?? "system";
let agentColors: UiColors | undefined;
let deviceColors: DeviceColors = JSON.parse(localStorage.getItem(COLORS_KEY) ?? "{}");

export const COLOR_KEYS: ColorKey[] = ["accent", "background", "userBubble", "botBubble"];

/** Ready-made palettes, light and dark. "Default" clears this device's colors. */
export const PRESETS: { name: string; colors: DeviceColors }[] = [
  { name: "Default", colors: {} },
  {
    name: "Graphite",
    colors: { light: { accent: "#3a3a3c", userBubble: "#3a3a3c", background: "#fafafa", botBubble: "#ececee" }, dark: { accent: "#aeaeb2", userBubble: "#48484a", background: "#121212", botBubble: "#262628" } },
  },
  {
    name: "Mint",
    colors: { light: { accent: "#00a67e", background: "#f5fbf9", botBubble: "#e3f1ec" }, dark: { accent: "#34d3a6", userBubble: "#0f8a69", background: "#0e1614", botBubble: "#1d2a26" } },
  },
  {
    name: "Sunset",
    colors: { light: { accent: "#f2662e", background: "#fffaf6", botBubble: "#f5e9e1" }, dark: { accent: "#ff8a5c", userBubble: "#d95a2b", background: "#18120f", botBubble: "#2c221d" } },
  },
  {
    name: "Lavender",
    colors: { light: { accent: "#7c5cf0", background: "#faf8ff", botBubble: "#ece8f8" }, dark: { accent: "#a78bfa", userBubble: "#6d4fe0", background: "#14121b", botBubble: "#25212f" } },
  },
  {
    name: "Rose",
    colors: { light: { accent: "#e0457b", background: "#fff8fa", botBubble: "#f6e6ec" }, dark: { accent: "#ff6b9a", userBubble: "#c93a6b", background: "#1a1114", botBubble: "#2d1f25" } },
  },
];

// --- colors ------------------------------------------------------------------------------------

const probe = document.createElement("canvas").getContext("2d")!;

/** Any CSS color as #rrggbb (what a color input needs), or undefined if it isn't one. */
export function toHex(color: string | undefined): string | undefined {
  if (!color?.trim()) return undefined;
  probe.fillStyle = "#010203";
  probe.fillStyle = color.trim();
  const out = String(probe.fillStyle);
  if (out === "#010203" && color.trim().toLowerCase() !== "#010203") return undefined;
  if (out.startsWith("#")) return out;
  const m = out.match(/[\d.]+/g); // rgba(r, g, b, a) for colors with alpha
  return m ? `#${m.slice(0, 3).map((n) => Math.round(+n).toString(16).padStart(2, "0")).join("")}` : undefined;
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Text that reads on a color: near-black on light ones, white on the rest (as Apple does on its blue). */
const textOn = (hex: string) => (luminance(hex) > 0.4 ? "#1d1d1f" : "#ffffff");

function agentPalette(scheme: Scheme): UiPalette {
  if (!agentColors) return {};
  if ("light" in agentColors || "dark" in agentColors) return (agentColors as { light?: UiPalette; dark?: UiPalette })[scheme] ?? {};
  return agentColors as UiPalette;
}

export const scheme = (): Scheme => (choice === "dark" || (choice === "system" && media.matches) ? "dark" : "light");

// --- applying them ----------------------------------------------------------------------------------

/** What each color is right now, as #rrggbb, and which ones this device chose. */
interface ColorState {
  scheme: Scheme;
  resolved: Record<ColorKey, string>;
  device: UiPalette;
  agent: UiPalette;
}
let colorState: ColorState;

const VARS: Record<ColorKey, string> = { accent: "--primary", background: "--background", userBubble: "--bubble-user", botBubble: "--bubble-bot" };

function apply() {
  const s = scheme();
  const root = document.documentElement;
  root.classList.toggle("dark", s === "dark");
  root.style.colorScheme = s;

  const palette: UiPalette = { ...agentPalette(s), ...deviceColors[s] };
  const set = (name: string, value?: string) => (value ? root.style.setProperty(name, value) : root.style.removeProperty(name));
  const accent = toHex(palette.accent);
  set("--primary", accent);
  set("--ring", accent);
  set("--primary-foreground", accent && textOn(accent));
  const bg = toHex(palette.background);
  set("--background", bg);
  // the sidebar and grouped lists sit a shade off the page
  set("--canvas", bg && `color-mix(in srgb, ${bg} ${s === "dark" ? 88 : 96}%, black)`);
  const user = toHex(palette.userBubble);
  set("--bubble-user", user);
  set("--bubble-user-foreground", user && textOn(user));
  const bot = toHex(palette.botBubble);
  set("--bubble-bot", bot);
  set("--bubble-bot-foreground", bot && textOn(bot));

  const css = getComputedStyle(root);
  const resolved = Object.fromEntries(COLOR_KEYS.map((k) => [k, toHex(css.getPropertyValue(VARS[k])) ?? "#000000"])) as Record<ColorKey, string>;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved.background);
  colorState = { scheme: s, resolved, device: deviceColors[s] ?? {}, agent: agentPalette(s) };
  listeners.forEach((l) => l());
}

media.addEventListener("change", () => choice === "system" && apply());
apply();

/** Reads the colors again once the stylesheet is in (main.tsx, after importing it). */
export const refreshColors = apply;
addEventListener("load", apply);

function saveColors() {
  if (!deviceColors.light && !deviceColors.dark) localStorage.removeItem(COLORS_KEY);
  else localStorage.setItem(COLORS_KEY, JSON.stringify(deviceColors));
  apply();
}

export function setTheme(next: ThemeChoice) {
  choice = next;
  if (next === "system") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, next);
  apply();
}

/** From the agent's welcome. */
export function setAgentColors(colors: UiColors | undefined) {
  if (JSON.stringify(colors) === JSON.stringify(agentColors)) return;
  agentColors = colors;
  apply();
}

/** One color for the theme on screen now, on this device. */
export function setColor(key: ColorKey, value: string) {
  const s = scheme();
  deviceColors = { ...deviceColors, [s]: { ...deviceColors[s], [key]: value } };
  saveColors();
}

/** A preset for both themes; Default goes back to the agent's colors. */
export function setPreset(colors: DeviceColors) {
  deviceColors = structuredClone(colors);
  saveColors();
}

export function resetColors() {
  deviceColors = {};
  saveColors();
}

/** The preset this device's colors match, if any. */
export function currentPreset(): string | undefined {
  const same = (a: DeviceColors, b: DeviceColors) => JSON.stringify({ l: a.light ?? {}, d: a.dark ?? {} }) === JSON.stringify({ l: b.light ?? {}, d: b.dark ?? {} });
  return PRESETS.find((p) => same(p.colors, deviceColors))?.name;
}

// --- React ---------------------------------------------------------------------------------------

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

export function useTheme(): ThemeChoice {
  return useSyncExternalStore(subscribe, () => choice);
}

export function useColors(): ColorState {
  return useSyncExternalStore(subscribe, () => colorState);
}
