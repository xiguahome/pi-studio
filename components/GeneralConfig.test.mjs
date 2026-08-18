import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./GeneralConfig.tsx", import.meta.url), "utf8");
const settingsSource = await readFile(new URL("./SettingsDialog.tsx", import.meta.url), "utf8");

test("language block switches locale through useI18n setLocale", () => {
  assert.match(source, /const \{ t, locale, setLocale, supportedLocales \} = useI18n\(\);/);
  assert.match(source, /<select[\s\S]*?value=\{locale\}[\s\S]*?setLocale\(e\.target\.value as typeof locale\)/);
  assert.match(source, /supportedLocales\.map\(\(plugin\) =>/);
});

test("theme block offers auto/dark/light and calls setPreference", () => {
  assert.match(source, /const \{ preference, setPreference \} = useTheme\(\);/);
  assert.match(source, /\{ value: "auto", labelKey: "general\.theme\.auto" \}/);
  assert.match(source, /\{ value: "dark", labelKey: "general\.theme\.dark" \}/);
  assert.match(source, /\{ value: "light", labelKey: "general\.theme\.light" \}/);
  assert.match(source, /onClick=\{\(\) => setPreference\(value\)\}/);
});

test("proxy block reuses NetworkConfig instead of duplicating the form", () => {
  assert.match(source, /<NetworkConfig embedded \/>/);
});

test("SettingsDialog replaces the network section with general", () => {
  assert.match(settingsSource, /type Section = "models" \| "skills" \| "plugins" \| "general";/);
  assert.match(settingsSource, /key: "general",\s*label: t\("common\.general"\),\s*disabled: false,/);
  assert.match(settingsSource, /<GeneralConfig key="general" embedded \/>/);
  assert.doesNotMatch(settingsSource, /key: "network"/);
  assert.doesNotMatch(settingsSource, /NetworkConfig/);
});
