import { chromium } from "playwright";

const INGEST_URL = process.env.SHOVID_INGEST_URL ?? "";
const RUNNER_ID = process.env.SHOVID_RUNNER_ID ?? "";
const TOKEN = process.env.SHOVID_INGEST_TOKEN ?? "";
const RUN_ID = process.env.GITHUB_RUN_ID ?? "0";
const EVENT = process.env.GITHUB_EVENT_NAME ?? "schedule";
const startedAt = new Date().toISOString();

function compactError(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.split(":", 1)[0].slice(0, 100) || "COLLECTOR_FAILED";
}

async function send(payload) {
  if (!INGEST_URL || !RUNNER_ID || !TOKEN || !/^\d+$/.test(RUN_ID)) {
    throw new Error("RUNNER_ENV_MISSING");
  }
  const response = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer " + TOKEN,
      "x-shovid-runner-id": RUNNER_ID,
    },
    body: JSON.stringify({ ...payload, githubRunId: RUN_ID, event: EVENT, startedAt }),
  });
  if (!response.ok) throw new Error("INGEST_" + response.status);
  return response.json();
}

async function collect() {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-blink-features=AutomationControlled"],
  });
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();
    await page.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(2500);
    const response = await page.evaluate(async () => {
      try {
        const result = await fetch(
          "https://www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1&source=6&is_lite=0&web_search_code=",
          { credentials: "include" },
        );
        return result.ok ? result.json() : null;
      } catch {
        return null;
      }
    });
    const words = Array.isArray(response?.data?.word_list) ? response.data.word_list : [];
    const trends = words.slice(0, 30).flatMap((item, index) => {
      const title = typeof item?.word === "string" ? item.word.trim() : "";
      if (!title) return [];
      const hot = Number(item.hot_value ?? item.hotValue);
      return [{
        externalId: String(item.sentence_id ?? item.word_id ?? title),
        title,
        url: "https://www.douyin.com/search/" + encodeURIComponent(title) + "?type=general",
        rank: index + 1,
        hotScore: Number.isFinite(hot) ? hot : null,
        language: "zh",
      }];
    });
    if (!trends.length) {
      await page.goto("https://www.douyin.com/discover", { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2000);
      const fallback = await page.evaluate(() => {
        const selectors = [
          ".hot-list-item",
          ".HotBoardItem",
          "[class*='HotList'] [class*='item']",
          "[class*='hot-search'] [class*='item']",
          "[class*='hotboard'] a",
        ];
        for (const selector of selectors) {
          const nodes = Array.from(document.querySelectorAll(selector)).slice(0, 30);
          const items = nodes.map((node, index) => {
            const titleNode = node.querySelector("[class*='title'], [class*='text'], [class*='word'], span") ?? node;
            const title = (titleNode.textContent ?? "").replace(/\s+/g, " ").trim();
            const href = node instanceof HTMLAnchorElement ? node.getAttribute("href") : node.querySelector("a")?.getAttribute("href");
            return { title, href, rank: index + 1 };
          }).filter((item) => item.title.length >= 2);
          if (items.length) return items;
        }
        return [];
      });
      trends.push(...fallback.map((item) => ({
        externalId: item.title,
        title: item.title,
        url: item.href ? new URL(item.href, "https://www.douyin.com/").toString() : "https://www.douyin.com/search/" + encodeURIComponent(item.title) + "?type=general",
        rank: item.rank,
        hotScore: null,
        language: "zh",
      })));
    }
    if (!trends.length) throw new Error("COLLECTOR_EMPTY");
    return trends;
  } finally {
    await browser.close();
  }
}

let trends = [];
let errorCode = null;
try {
  trends = await collect();
} catch (error) {
  errorCode = compactError(error);
}

const completedAt = new Date().toISOString();
const durationSeconds = Math.max(0, Math.round((Date.parse(completedAt) - Date.parse(startedAt)) / 1000));
await send({
  sourceKey: "douyin",
  outcome: errorCode ? "failed" : "success",
  errorCode,
  trends,
  completedAt,
  durationSeconds,
});
if (errorCode) throw new Error(errorCode);
console.log("Collected " + trends.length + " Douyin trends");
