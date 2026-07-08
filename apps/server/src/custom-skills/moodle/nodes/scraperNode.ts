import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createAgentBrowserClient, type AgentBrowserClient } from "../agentBrowserClient.ts";
import {
  createBrowserLoginConfig,
  dismissCommonAgentBrowserOverlays,
  dismissCommonOverlays,
  ensureAgentBrowserLoggedIn,
  ensureLoggedIn,
} from "../browserAuth.ts";
import {
  assertSafeClick,
  extractLinksFromSnapshot,
  hasBodyText,
  isAuthFailure,
  safeFileName,
  snapshotToText,
} from "../browserSafety.ts";
import type { LangGraphAgentState } from "../state.ts";
import type { MoodleRuntimeConfig } from "../types.ts";

interface CrawlPage {
  url: string;
  depth: number;
}

export interface ScraperNodeDependencies {
  agentBrowser?: AgentBrowserClient;
}

export function createScraperNode(
  config: MoodleRuntimeConfig,
  dependencies: ScraperNodeDependencies = {},
) {
  return async function scraperNode(
    _state: LangGraphAgentState,
  ): Promise<Partial<LangGraphAgentState>> {
    if (config.browserBackend === "agent-browser") {
      return scrapeWithAgentBrowser(
        config,
        _state,
        dependencies.agentBrowser ?? createAgentBrowserClient(config),
      );
    }

    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: config.headless });
      const context = await browser.newContext(
        config.storageState ? { storageState: config.storageState } : undefined,
      );
      const page = await context.newPage();
      await ensureLoggedIn(
        page,
        createBrowserLoginConfig({
          serviceName: "Moodle",
          targetUrl: config.moodleUrl || config.dashboardUrl,
          username: config.username,
          password: config.password,
        }),
      );

      const visited = new Set<string>();
      const queue: CrawlPage[] = [{ url: config.moodleUrl, depth: 0 }];
      const chunks: string[] = [];
      const sourcesDir = path.join(config.runDir, "sources");
      await mkdir(sourcesDir, { recursive: true });

      while (queue.length > 0 && visited.size < config.maxPages) {
        const next = queue.shift();
        if (!next || visited.has(next.url)) {
          continue;
        }
        visited.add(next.url);
        await page.goto(next.url, { waitUntil: "networkidle", timeout: 45_000 });
        await dismissCommonOverlays(page);

        const title = await page.title().catch(() => next.url);
        const text = await page
          .locator("body")
          .innerText({ timeout: 15_000 })
          .catch(() => "");
        chunks.push(formatSourceChunk({ title, url: next.url, text }));

        if (config.allowFileDownloads) {
          await capturePlaywrightFileLinks(page, sourcesDir, chunks);
        }

        if (next.depth < config.maxDepth) {
          const links = await extractMoodleLinks(page, config.baseUrl, config.prompt);
          for (const link of links) {
            if (!visited.has(link) && queue.length + visited.size < config.maxPages) {
              queue.push({ url: link, depth: next.depth + 1 });
            }
          }
        }
      }

      return {
        moodle_raw_text: [_state.moodle_raw_text, chunks.join("\n\n")]
          .filter((part) => part.trim())
          .join("\n\n"),
        source_coverage: {
          ..._state.source_coverage,
          moodle: {
            status: chunks.some((chunk) => hasBodyText(chunk)) ? "success" : "empty",
            detail: chunks.some((chunk) => hasBodyText(chunk))
              ? `Fetched ${visited.size} Moodle page(s).`
              : "Moodle was reachable, but no readable page text was extracted.",
            urls: [...visited],
            pages: visited.size,
          },
        },
        error_log: null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        moodle_raw_text: [
          _state.moodle_raw_text,
          [`[Moodle warning]`, `Moodle scrape failed: ${message}`].join("\n"),
        ]
          .filter((part) => part.trim())
          .join("\n\n"),
        source_coverage: {
          ..._state.source_coverage,
          moodle: {
            status: isAuthFailure(message) ? "failed_auth" : "failed",
            detail: message,
            urls: [config.moodleUrl],
            pages: 0,
          },
        },
        error_log: null,
      };
    } finally {
      await browser?.close();
    }
  };
}

async function scrapeWithAgentBrowser(
  config: MoodleRuntimeConfig,
  state: LangGraphAgentState,
  client: AgentBrowserClient,
): Promise<Partial<LangGraphAgentState>> {
  try {
    await ensureAgentBrowserLoggedIn(
      client,
      createBrowserLoginConfig({
        serviceName: "Moodle",
        targetUrl: config.moodleUrl || config.dashboardUrl,
        username: config.username,
        password: config.password,
      }),
    );

    const visited = new Set<string>();
    const queue: CrawlPage[] = [{ url: config.moodleUrl, depth: 0 }];
    const chunks: string[] = [];
    const sourcesDir = path.join(config.runDir, "sources");
    await mkdir(sourcesDir, { recursive: true });

    while (queue.length > 0 && visited.size < config.maxPages) {
      const next = queue.shift();
      if (!next || visited.has(next.url)) {
        continue;
      }
      visited.add(next.url);
      await client.open(next.url);
      await dismissCommonAgentBrowserOverlays(client);

      const snapshot = await client
        .snapshot({ interactive: true, urls: true, compact: true })
        .catch(() => null);
      const title = snapshot?.origin || next.url;
      const text = await getAgentBrowserPageText(client, snapshot?.snapshot);
      if (snapshot) {
        await writeFile(
          path.join(sourcesDir, safeFileName(`${visited.size}-${title || "snapshot"}.json`)),
          `${JSON.stringify(snapshot, null, 2)}\n`,
          "utf8",
        );
      }
      chunks.push(formatSourceChunk({ title, url: next.url, text }));

      if (config.allowFileDownloads && snapshot) {
        await captureAgentBrowserFileLinks(
          client,
          snapshot.snapshot,
          snapshot.refs,
          sourcesDir,
          chunks,
        );
      }

      if (next.depth < config.maxDepth && snapshot) {
        const links = extractMoodleLinksFromSnapshot(
          snapshot.snapshot,
          snapshot.refs,
          config.baseUrl,
          config.prompt,
        );
        for (const link of links) {
          if (!visited.has(link) && queue.length + visited.size < config.maxPages) {
            queue.push({ url: link, depth: next.depth + 1 });
          }
        }
      }
    }

    return {
      moodle_raw_text: [state.moodle_raw_text, chunks.join("\n\n")]
        .filter((part) => part.trim())
        .join("\n\n"),
      source_coverage: {
        ...state.source_coverage,
        moodle: {
          status: chunks.some((chunk) => hasBodyText(chunk)) ? "success" : "empty",
          detail: chunks.some((chunk) => hasBodyText(chunk))
            ? `Fetched ${visited.size} Moodle page(s) with agent-browser.`
            : "Moodle was reachable, but no readable page text was extracted.",
          urls: [...visited],
          pages: visited.size,
        },
      },
      error_log: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      moodle_raw_text: [
        state.moodle_raw_text,
        [`[Moodle warning]`, `Moodle scrape failed: ${message}`].join("\n"),
      ]
        .filter((part) => part.trim())
        .join("\n\n"),
      source_coverage: {
        ...state.source_coverage,
        moodle: {
          status: isAuthFailure(message) ? "failed_auth" : "failed",
          detail: message,
          urls: [config.moodleUrl],
          pages: 0,
        },
      },
      error_log: null,
    };
  } finally {
    if (!config.keepBrowserOpen && config.cisUrls.length === 0) {
      await client.close().catch(() => undefined);
    }
  }
}

async function extractMoodleLinks(page: Page, baseUrl: string, prompt: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const hrefs = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: (anchor as HTMLAnchorElement).href,
      label: (
        (anchor as HTMLAnchorElement).innerText ||
        (anchor as HTMLAnchorElement).textContent ||
        ""
      ).trim(),
    })),
  );
  const seen = new Set<string>();
  return selectRelevantMoodleLinks(
    hrefs
      .filter(({ href }) => href.startsWith(origin))
      .filter(
        ({ href }) =>
          href.includes("/course/") || href.includes("/mod/") || href.includes("/pluginfile.php"),
      )
      .filter(({ href }) => {
        if (seen.has(href)) {
          return false;
        }
        seen.add(href);
        return true;
      }),
    prompt,
  );
}

async function capturePlaywrightFileLinks(
  page: Page,
  sourcesDir: string,
  chunks: string[],
): Promise<void> {
  const hrefs = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: (anchor as HTMLAnchorElement).href,
      label: (
        (anchor as HTMLAnchorElement).innerText ||
        (anchor as HTMLAnchorElement).textContent ||
        ""
      ).trim(),
    })),
  );
  const fileLinks = hrefs.filter(({ href }) => /\.(pdf|txt|md)$/i.test(new URL(href).pathname));
  for (const [index, link] of fileLinks.entries()) {
    const filename = safeFileName(
      `${index + 1}-${link.label || path.basename(new URL(link.href).pathname)}`,
    );
    const target = path.join(sourcesDir, filename);
    const response = await page
      .context()
      .request.get(link.href)
      .catch(() => null);
    if (!response?.ok()) {
      chunks.push(
        `[Linked file]\nTitle: ${link.label || filename}\nURL: ${link.href}\nDownload failed`,
      );
      continue;
    }

    const body = await response.body();
    await writeFile(target, body);
    const pathname = new URL(link.href).pathname.toLowerCase();
    const text =
      pathname.endsWith(".txt") || pathname.endsWith(".md")
        ? `\n\n${body.toString("utf8").trim()}`
        : "\n\nBinary file saved for future extraction.";
    chunks.push(
      `[Linked file]\nTitle: ${link.label || filename}\nURL: ${link.href}\nSaved path: ${target}${text}`,
    );
  }
}

async function captureAgentBrowserFileLinks(
  client: AgentBrowserClient,
  snapshot: string,
  refs: Parameters<typeof extractLinksFromSnapshot>[1],
  sourcesDir: string,
  chunks: string[],
): Promise<void> {
  const fileLinks = extractLinksFromSnapshot(snapshot, refs).filter(({ href }) =>
    /\.(txt|md)$/i.test(new URL(href).pathname),
  );
  for (const [index, link] of fileLinks.entries()) {
    const filename = safeFileName(
      `${index + 1}-${link.label || path.basename(new URL(link.href).pathname)}`,
    );
    const target = path.join(sourcesDir, filename);
    try {
      assertSafeClick(link.label);
      await client.download(`@${link.ref}`, target);
      const pathname = new URL(link.href).pathname.toLowerCase();
      const text =
        pathname.endsWith(".txt") || pathname.endsWith(".md")
          ? `\n\n${(await readFile(target, "utf8")).trim()}`
          : "\n\nBinary file saved for future extraction.";
      chunks.push(
        `[Linked file]\nTitle: ${link.label || filename}\nURL: ${link.href}\nSaved path: ${target}${text}`,
      );
    } catch {
      chunks.push(
        `[Linked file]\nTitle: ${link.label || filename}\nURL: ${link.href}\nDownload failed`,
      );
    }
  }
}

function formatSourceChunk(input: { title: string; url: string; text: string }): string {
  return [
    `[Moodle page]`,
    `Title: ${input.title}`,
    `URL: ${input.url}`,
    "",
    input.text.trim(),
  ].join("\n");
}

async function getAgentBrowserPageText(
  client: AgentBrowserClient,
  snapshot: string | undefined,
): Promise<string> {
  const snapshotText = snapshot ? snapshotToText(snapshot) : "";
  if (snapshotText.trim()) {
    return snapshotText;
  }
  return "";
}

function scoreMoodleLink(link: { href: string; label: string }, prompt: string): number {
  const haystack = `${link.href}\n${link.label}`.toLowerCase();
  const haystackTokens = new Set(textTokens(haystack));
  let score = 0;
  if (link.href.includes("/course/view.php")) {
    score += 40;
  }
  if (link.href.includes("/mod/assign/")) {
    score += 25;
  }
  if (link.href.includes("/mod/page/")) {
    score += 20;
  }
  if (link.href.includes("/pluginfile.php")) {
    score -= 10;
  }
  for (const token of promptTokens(prompt)) {
    if (haystackTokens.has(token)) {
      score += 100;
    }
  }
  return score;
}

function promptTokens(prompt: string): string[] {
  return textTokens(prompt).filter((token) => !PROMPT_TOKEN_STOPWORDS.has(token));
}

function textTokens(text: string): string[] {
  return [...new Set(text.toLowerCase().match(/[a-z0-9äöüß_-]{3,}/gi) ?? [])];
}

const PROMPT_TOKEN_STOPWORDS = new Set([
  "alle",
  "antworten",
  "berrichtes",
  "berichte",
  "box",
  "brauchen",
  "copy",
  "der",
  "die",
  "du",
  "eine",
  "erstellen",
  "für",
  "ich",
  "infos",
  "kannst",
  "key",
  "laborbericht",
  "laborberrichtes",
  "lektor",
  "meine",
  "paste",
  "pastabel",
  "sidn",
  "sowie",
  "termine",
  "und",
  "weitere",
  "welche",
  "wie",
  "wir",
  "zum",
]);

function extractMoodleLinksFromSnapshot(
  snapshot: string,
  refs: Parameters<typeof extractLinksFromSnapshot>[1],
  baseUrl: string,
  prompt: string,
): string[] {
  const origin = new URL(baseUrl).origin;
  const seen = new Set<string>();
  return selectRelevantMoodleLinks(
    extractLinksFromSnapshot(snapshot, refs)
      .filter(({ href }) => href.startsWith(origin))
      .filter(
        ({ href }) =>
          href.includes("/course/") || href.includes("/mod/") || href.includes("/pluginfile.php"),
      )
      .filter(({ href }) => {
        if (seen.has(href)) {
          return false;
        }
        seen.add(href);
        return true;
      }),
    prompt,
  );
}

function selectRelevantMoodleLinks(
  links: { href: string; label: string }[],
  prompt: string,
): string[] {
  const scored = links
    .map((link) => ({ ...link, score: scoreMoodleLink(link, prompt) }))
    .sort((left, right) => right.score - left.score);
  const topScore = scored[0]?.score ?? 0;
  const selected =
    topScore >= 200 ? scored.filter((link) => link.score >= Math.max(200, topScore - 100)) : scored;
  return selected.map(({ href }) => href);
}
