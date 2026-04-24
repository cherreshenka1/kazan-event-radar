import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PROFILE_DIR = path.join(ROOT, "data", "playwright", "kassir-profile");
const STATE_PATH = path.join(ROOT, "data", "playwright", "kassir-browser-state.json");
const DEFAULT_URL = "https://kzn.kassir.ru";

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});

async function main() {
  const executablePath = await findBrowserExecutable();
  await fs.mkdir(PROFILE_DIR, { recursive: true });

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath,
    headless: false,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    viewport: { width: 1440, height: 1200 }
  });

  const browser = context.browser();
  const page = context.pages()[0] || await context.newPage();
  await page.setExtraHTTPHeaders({
    "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7"
  });

  console.log("Kassir profile:", PROFILE_DIR);
  const warmupUrl = await resolveWarmupUrl();
  console.log("Open page:", warmupUrl);
  console.log("Pass anti-bot or captcha in this browser window, wait for the normal Kassir page, then close the window.");

  await page.goto(warmupUrl, { waitUntil: "domcontentloaded", timeout: 180000 });

  if (!browser) {
    await new Promise(() => {});
    return;
  }

  await new Promise((resolve) => {
    browser.once("disconnected", resolve);
  });
}

async function resolveWarmupUrl() {
  const cliUrl = process.argv.slice(2).find((value) => /^https?:\/\//i.test(value));
  if (cliUrl) return cliUrl;

  try {
    const state = JSON.parse(await fs.readFile(STATE_PATH, "utf8"));
    const blockedLink = state?.lastRun?.blockedLink;
    if (/^https?:\/\//i.test(blockedLink || "")) {
      return blockedLink;
    }
  } catch {
    // no previous blocked URL yet
  }

  return DEFAULT_URL;
}

async function findBrowserExecutable() {
  const candidates = [
    process.env.PLAYWRIGHT_BROWSER_PATH,
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.PROGRAMFILES || "", "Yandex", "YandexBrowser", "Application", "browser.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Yandex", "YandexBrowser", "Application", "browser.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }

  throw new Error("Browser executable was not found. Install Chrome/Edge/Yandex Browser or set PLAYWRIGHT_BROWSER_PATH.");
}
