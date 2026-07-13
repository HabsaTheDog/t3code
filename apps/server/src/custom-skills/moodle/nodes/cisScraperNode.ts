import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { createAgentBrowserClient, type AgentBrowserClient } from "../agentBrowserClient.ts";
import { redactSensitiveValues } from "../browserSecurity.ts";
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

export interface CisScraperNodeDependencies {
  agentBrowser?: AgentBrowserClient;
}

export function createCisScraperNode(
  config: MoodleRuntimeConfig,
  dependencies: CisScraperNodeDependencies = {},
) {
  return async function cisScraperNode(
    state: LangGraphAgentState,
  ): Promise<Partial<LangGraphAgentState>> {
    if (config.cisUrls.length === 0) {
      return {
        source_coverage: {
          ...state.source_coverage,
          cis: {
            status: "not_requested",
            detail: "No CIS URLs were configured.",
            urls: [],
            pages: 0,
          },
        },
      };
    }

    if (config.cisBrowserBackend === "agent-browser") {
      return scrapeCisWithAgentBrowser(
        config,
        state,
        dependencies.agentBrowser ?? createAgentBrowserClient(config),
      );
    }

    let browser: Browser | null = null;
    try {
      browser = await chromium.launch({ headless: config.headless });
      const context = await browser.newContext({
        ...(config.cisStorageState ? { storageState: config.cisStorageState } : {}),
        ...(config.cisUsername && config.cisPassword
          ? {
              httpCredentials: {
                username: config.cisUsername,
                password: config.cisPassword,
              },
            }
          : {}),
      });
      const page = await context.newPage();
      await ensureLoggedIn(
        page,
        createBrowserLoginConfig({
          serviceName: "CIS",
          targetUrl: config.cisDashboardUrl || config.cisUrls[0],
          username: config.cisUsername,
          password: config.cisPassword,
          allowedOrigins: config.cisLoginAllowedOrigins,
          allowInteractiveUserAction: !config.headless,
        }),
      );

      const chunks: string[] = [];
      const sourcesDir = path.join(config.runDir, "cis-sources");
      await mkdir(sourcesDir, { recursive: true });
      await crawlCisPages(page, config, chunks);

      return {
        moodle_raw_text: [state.moodle_raw_text, chunks.join("\n\n")]
          .filter((part) => part.trim())
          .join("\n\n"),
        source_coverage: {
          ...state.source_coverage,
          cis: {
            status: chunks.some((chunk) => hasBodyText(chunk)) ? "success" : "empty",
            detail: chunks.some((chunk) => hasBodyText(chunk))
              ? `Fetched ${countCisPages(chunks)} CIS page(s).`
              : "CIS was reachable, but no readable page text was extracted.",
            urls: extractChunkUrls(chunks),
            pages: countCisPages(chunks),
          },
        },
        error_log: null,
      };
    } catch (error) {
      const message = redactContent(config, error instanceof Error ? error.message : String(error));
      const warningChunk = [`[CIS warning]`, `CIS scrape failed: ${message}`].join("\n");
      return {
        moodle_raw_text: [state.moodle_raw_text, warningChunk]
          .filter((part) => part.trim())
          .join("\n\n"),
        source_coverage: {
          ...state.source_coverage,
          cis: {
            status: isAuthFailure(message) ? "failed_auth" : "failed",
            detail: message,
            urls: config.cisUrls,
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

async function crawlCisPages(
  page: Page,
  config: MoodleRuntimeConfig,
  chunks: string[],
): Promise<void> {
  const visited = new Set<string>();
  const queue: CrawlPage[] = seedCisUrls(config).map((url) => ({ url, depth: 0 }));

  while (queue.length > 0 && visited.size < config.maxCisPages) {
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
    chunks.push(redactContent(config, formatCisChunk({ title, url: next.url, text })));

    await capturePlaywrightReadableFiles(
      page,
      path.join(config.runDir, "cis-sources"),
      chunks,
      config,
    );

    if (next.depth < config.maxDepth) {
      const links = await extractCisLinks(page, config.cisBaseUrl, config.prompt);
      queue.unshift(
        ...links
          .filter((link) => !visited.has(link))
          .map((url) => ({ url, depth: next.depth + 1 })),
      );
    }
  }
}

async function scrapeCisWithAgentBrowser(
  config: MoodleRuntimeConfig,
  state: LangGraphAgentState,
  client: AgentBrowserClient,
): Promise<Partial<LangGraphAgentState>> {
  try {
    await ensureAgentBrowserLoggedIn(
      client,
      createBrowserLoginConfig({
        serviceName: "CIS",
        targetUrl: config.cisDashboardUrl || config.cisUrls[0],
        username: config.cisUsername,
        password: config.cisPassword,
        allowedOrigins: config.cisLoginAllowedOrigins,
        allowInteractiveUserAction: !config.headless,
      }),
    );

    const chunks: string[] = [];
    const sourcesDir = path.join(config.runDir, "cis-sources");
    await mkdir(sourcesDir, { recursive: true });
    const visited = await crawlCisPagesWithAgentBrowser(client, config, chunks, sourcesDir);

    return {
      moodle_raw_text: [state.moodle_raw_text, chunks.join("\n\n")]
        .filter((part) => part.trim())
        .join("\n\n"),
      source_coverage: {
        ...state.source_coverage,
        cis: {
          status: chunks.some((chunk) => hasBodyText(chunk)) ? "success" : "empty",
          detail: chunks.some((chunk) => hasBodyText(chunk))
            ? `Fetched ${visited.size} CIS page(s) with agent-browser.`
            : "CIS was reachable, but no readable page text was extracted.",
          urls: [...visited],
          pages: visited.size,
        },
      },
      error_log: null,
    };
  } catch (error) {
    const message = redactContent(config, error instanceof Error ? error.message : String(error));
    const warningChunk = [`[CIS warning]`, `CIS scrape failed: ${message}`].join("\n");
    return {
      moodle_raw_text: [state.moodle_raw_text, warningChunk]
        .filter((part) => part.trim())
        .join("\n\n"),
      source_coverage: {
        ...state.source_coverage,
        cis: {
          status: isAuthFailure(message) ? "failed_auth" : "failed",
          detail: message,
          urls: config.cisUrls,
          pages: 0,
        },
      },
      error_log: null,
    };
  } finally {
    if (!config.keepBrowserOpen) {
      await client.close().catch(() => undefined);
    }
  }
}

async function crawlCisPagesWithAgentBrowser(
  client: AgentBrowserClient,
  config: MoodleRuntimeConfig,
  chunks: string[],
  sourcesDir: string,
): Promise<Set<string>> {
  const visited = new Set<string>();
  const queue: CrawlPage[] = seedCisUrls(config).map((url) => ({ url, depth: 0 }));

  while (queue.length > 0 && visited.size < config.maxCisPages) {
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
    chunks.push(redactContent(config, formatCisChunk({ title, url: next.url, text })));

    if (snapshot) {
      await captureAgentBrowserReadableFiles(
        client,
        snapshot.snapshot,
        snapshot.refs,
        sourcesDir,
        chunks,
        config,
      );
    }

    if (next.depth < config.maxDepth && snapshot) {
      const links = extractCisLinksFromSnapshot(
        snapshot.snapshot,
        snapshot.refs,
        config.cisBaseUrl,
        config.prompt,
      );
      queue.unshift(
        ...links
          .filter((link) => !visited.has(link))
          .map((url) => ({ url, depth: next.depth + 1 })),
      );
    }
  }

  return visited;
}

async function extractCisLinks(page: Page, baseUrl: string, prompt: string): Promise<string[]> {
  const origin = new URL(baseUrl).origin;
  const links = await page.locator("a[href]").evaluateAll((anchors) =>
    anchors.map((anchor) => ({
      href: (anchor as HTMLAnchorElement).href,
      label: ((anchor as HTMLAnchorElement).innerText || anchor.textContent || "").trim(),
      context: (
        (anchor.closest("tr, article, section, .card, .panel, li, div") as HTMLElement | null)
          ?.innerText || ""
      )
        .trim()
        .slice(0, 2_000),
    })),
  );
  return uniqueCisLinks(links)
    .filter(({ href }) => href.startsWith(origin))
    .filter(({ href }) => !href.includes("logout"))
    .filter(({ href }) => !/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(new URL(href).pathname))
    .sort((a, b) => cisLinkScore(b, prompt) - cisLinkScore(a, prompt))
    .map(({ href }) => href);
}

async function capturePlaywrightReadableFiles(
  page: Page,
  sourcesDir: string,
  chunks: string[],
  config: MoodleRuntimeConfig,
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
  const fileLinks = hrefs.filter(({ href }) => /\.(ics|csv|txt|md)$/i.test(new URL(href).pathname));
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
        `[CIS linked file]\nTitle: ${link.label || filename}\nURL: ${link.href}\nDownload failed`,
      );
      continue;
    }

    const body = redactContent(config, (await response.body()).toString("utf8"));
    await writeFile(target, body, "utf8");
    chunks.push(
      `[CIS linked file]\nTitle: ${link.label || filename}\nURL: ${link.href}\nSaved path: ${target}\n\n${body.trim()}`,
    );
  }
}

async function captureAgentBrowserReadableFiles(
  client: AgentBrowserClient,
  snapshot: string,
  refs: Parameters<typeof extractLinksFromSnapshot>[1],
  sourcesDir: string,
  chunks: string[],
  config: MoodleRuntimeConfig,
): Promise<void> {
  const fileLinks = extractLinksFromSnapshot(snapshot, refs).filter(({ href }) =>
    /\.(ics|csv|txt|md)$/i.test(new URL(href).pathname),
  );
  for (const [index, link] of fileLinks.entries()) {
    const filename = safeFileName(
      `${index + 1}-${link.label || path.basename(new URL(link.href).pathname)}`,
    );
    const target = path.join(sourcesDir, filename);
    try {
      assertSafeClick(link.label);
      await client.download(`@${link.ref}`, target);
      const safeText = redactContent(config, await readFile(target, "utf8"));
      await writeFile(target, safeText, "utf8");
      chunks.push(
        `[CIS linked file]\nTitle: ${link.label || filename}\nURL: ${link.href}\nSaved path: ${target}\n\n${safeText.trim()}`,
      );
    } catch {
      chunks.push(
        `[CIS linked file]\nTitle: ${link.label || filename}\nURL: ${link.href}\nDownload failed`,
      );
    }
  }
}

function redactContent(config: MoodleRuntimeConfig, value: string): string {
  return redactSensitiveValues(value, [
    config.username,
    config.password,
    config.cisUsername,
    config.cisPassword,
    config.calendarUrl,
  ]);
}

function formatCisChunk(input: { title: string; url: string; text: string }): string {
  return [`[CIS page]`, `Title: ${input.title}`, `URL: ${input.url}`, "", input.text.trim()].join(
    "\n",
  );
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

function countCisPages(chunks: string[]): number {
  return chunks.filter((chunk) => chunk.startsWith("[CIS page]")).length;
}

function extractChunkUrls(chunks: string[]): string[] {
  const urls = chunks
    .map((chunk) => /^URL:\s*(.+)$/m.exec(chunk)?.[1]?.trim())
    .filter((url): url is string => Boolean(url));
  return [...new Set(urls)];
}

function extractCisLinksFromSnapshot(
  snapshot: string,
  refs: Parameters<typeof extractLinksFromSnapshot>[1],
  baseUrl: string,
  prompt: string,
): string[] {
  const origin = new URL(baseUrl).origin;
  return uniqueCisLinks(extractLinksFromSnapshot(snapshot, refs))
    .filter(({ href }) => href.startsWith(origin))
    .filter(({ href }) => !href.includes("logout"))
    .filter(({ href }) => !/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(new URL(href).pathname))
    .sort((a, b) => cisLinkScore(b, prompt) - cisLinkScore(a, prompt))
    .map(({ href }) => href);
}

function seedCisUrls(config: MoodleRuntimeConfig): string[] {
  const base = config.cisBaseUrl.replace(/\/$/, "");
  return [`${base}/cis.php/Cis/MyLv`, `${base}/cis.php/Cis/MyLvPlan`, ...config.cisUrls];
}

function uniqueCisLinks<T extends { href: string }>(links: T[]): T[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const normalized = link.href.replace(/#.*$/, "").replace(/\/$/, "");
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function cisLinkScore(
  link: { href: string; label?: string; context?: string },
  prompt: string,
): number {
  const text = `${link.href} ${link.label ?? ""}`.toLowerCase();
  const contextMatches = requestedCourseTerms(prompt).some((term) =>
    (link.context ?? link.label ?? "").toLowerCase().includes(term),
  );
  if (/alle\s+termine\s+dieser\s+lv/.test(text)) return contextMatches ? 1_000 : 500;
  if (/lehrveranstaltungsinformationen|lv-info|lvinfo/.test(text))
    return contextMatches ? 900 : 400;
  if (/termin|exam|prüfung|pruefung/.test(text)) return contextMatches ? 800 : 300;
  return contextMatches ? 200 : 0;
}

function requestedCourseTerms(prompt: string): string[] {
  const terms = prompt.toLowerCase().match(/[a-z0-9äöüß]{3,}/g) ?? [];
  return terms.filter(
    (term) =>
      /\d/.test(term) ||
      ["maschinenelemente", "dynamik", "mathematik", "elektrotechnik"].includes(term),
  );
}
