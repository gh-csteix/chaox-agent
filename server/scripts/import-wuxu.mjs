#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ARTICLE_DIRECTORIES = ["wuxu", "reading-the-craft"];
const VALID_DIMENSIONS = ["chaos", "spacetime", "existence", "ix"];
const DIMENSION_MAP = {
  chaos: "chaos",
  "混沌": "chaos",
  spacetime: "spacetime",
  "空时": "spacetime",
  existence: "existence",
  "存在": "existence",
  ix: "ix",
  "i-seek": "ix",
  "我求": "ix"
};
const NON_DIMENSION_LABELS = new Set(["务虚", "读术", "reading the craft", "wuxu"]);
const TRANSLATION_LINK_PATTERN = /^(?:English:|中文请见)\s*\[[^\]]+\]\(\.\/([^\s)]+\.md)\)\.?$/;
const TIMESTAMP_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?(?:\s*（([^）]+)）|\s+\(([^)]+)\))?$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function zonedLocalToUtcIso(year, month, day, hour, minute, timeZone) {
  const targetUtcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const check = new Date(targetUtcMs);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  ) {
    throw new Error(`Invalid calendar timestamp '${year}-${month}-${day} ${hour}:${minute}'.`);
  }

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });

  const partsMs = (ms) => {
    const parts = formatter.formatToParts(new Date(ms));
    const map = {};
    for (const part of parts) {
      if (part.type !== "literal") map[part.type] = Number(part.value);
    }
    const h = map.hour === 24 ? 0 : map.hour;
    return Date.UTC(map.year, map.month - 1, map.day, h, map.minute, map.second, 0);
  };

  let guess = targetUtcMs;
  for (let i = 0; i < 3; i += 1) {
    const diff = partsMs(guess) - targetUtcMs;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess).toISOString();
}

function extractHeadings(body) {
  return body
    .split("\n")
    .filter((line) => line.startsWith("## "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function extractLeavingLines(body) {
  const match = /(?:^|\n)##\s*留下来的几句[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(body);
  if (!match) return [];
  return match[1]
    .split("\n")
    .map((line) =>
      line
        .replace(/^[-*+]\s+/, "")
        .replace(/^>\s*/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .trim()
    )
    .filter(Boolean);
}

export function parseWuxuArticleMarkdown(rawContent, fileLabel) {
  const normalized = rawContent.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let idx = 0;
  while (idx < lines.length && lines[idx].trim() === "") idx += 1;

  if (idx >= lines.length || !lines[idx].startsWith("# ")) {
    throw new Error(`${fileLabel}: missing leading '# Title' heading.`);
  }
  const title = lines[idx].slice(2).trim();
  if (!title) {
    throw new Error(`${fileLabel}: empty '# Title' heading.`);
  }
  idx += 1;

  while (idx < lines.length && lines[idx].trim() === "") idx += 1;
  const subtitleLine = lines[idx]?.trim() ?? "";
  if (!/^\*CHAOX.*\*$/.test(subtitleLine)) {
    throw new Error(`${fileLabel}: missing '*CHAOX ...*' subtitle line (found '${subtitleLine}').`);
  }
  const rawLabels = subtitleLine
    .slice(1, -1)
    .split("·")
    .slice(1)
    .map((label) => label.trim())
    .filter(Boolean);

  const dimensionSet = new Set();
  const unknownLabels = [];
  for (const label of rawLabels) {
    if (NON_DIMENSION_LABELS.has(label.toLowerCase()) || NON_DIMENSION_LABELS.has(label)) {
      continue;
    }
    const mapped = DIMENSION_MAP[label.toLowerCase()] ?? DIMENSION_MAP[label];
    if (!mapped) {
      unknownLabels.push(label);
    } else {
      dimensionSet.add(mapped);
    }
  }
  if (unknownLabels.length > 0) {
    throw new Error(`${fileLabel}: unknown dimension label(s): ${unknownLabels.join(", ")}`);
  }
  const dimensions = VALID_DIMENSIONS.filter((dim) => dimensionSet.has(dim));
  if (dimensions.length === 0) {
    throw new Error(`${fileLabel}: missing CSTEIX dimension tag in subtitle '${subtitleLine}'.`);
  }
  idx += 1;

  while (idx < lines.length && lines[idx].trim() === "") idx += 1;
  let translationFile = null;
  if (idx < lines.length && TRANSLATION_LINK_PATTERN.test(lines[idx].trim())) {
    translationFile = lines[idx].trim().match(TRANSLATION_LINK_PATTERN)[1];
    idx += 1;
    while (idx < lines.length && lines[idx].trim() === "") idx += 1;
  }

  const stampLine = lines[idx]?.trim() ?? "";
  const stampMatch = TIMESTAMP_PATTERN.exec(stampLine);
  if (!stampMatch) {
    throw new Error(`${fileLabel}: missing valid timestamp line (found '${stampLine}').`);
  }
  const [, dateStr, timeStr = "00:00", zhZone, enZone] = stampMatch;
  const rawZone = (zhZone ?? enZone ?? "Asia/Shanghai").split(/[，,]/)[0].trim();
  const timezone = rawZone || "Asia/Shanghai";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new Error(`${fileLabel}: invalid IANA timezone '${timezone}'.`);
  }

  const [year, month, day] = dateStr.split("-").map(Number);
  const [hour, minute] = timeStr.split(":").map(Number);
  const writtenAt = zonedLocalToUtcIso(year, month, day, hour, minute, timezone);
  idx += 1;

  while (idx < lines.length && lines[idx].trim() === "") idx += 1;
  const body = lines.slice(idx).join("\n").trim();
  if (!body) {
    throw new Error(`${fileLabel}: article body is empty after stripping header skeleton.`);
  }

  return {
    title,
    dimensions,
    date: dateStr,
    time: timeStr,
    timezone,
    writtenAt,
    translationFile,
    body,
    headings: extractHeadings(body),
    leavingLines: extractLeavingLines(body)
  };
}

export function loadWuxuDirectory(repoDir) {
  const resolvedDir = path.resolve(repoDir);
  if (!existsSync(resolvedDir)) {
    throw new Error(`Directory does not exist: ${resolvedDir}`);
  }

  const zhFiles = new Map();
  const enFiles = new Map();
  const rawFiles = new Map();
  let totalMarkdownFiles = 0;

  for (const subDir of ARTICLE_DIRECTORIES) {
    const fullSubDir = path.join(resolvedDir, subDir);
    if (!existsSync(fullSubDir)) continue;
    const entries = readdirSync(fullSubDir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      totalMarkdownFiles += 1;
      const relPath = `${subDir}/${entry.name}`;
      const content = readFileSync(path.join(fullSubDir, entry.name), "utf8");

      if (entry.name.endsWith(".en.raw.md")) {
        throw new Error(`${relPath}: raw notes belong to the canonical Chinese file, not .en.raw.md.`);
      }
      if (entry.name.endsWith(".raw.md")) {
        const slug = entry.name.slice(0, -".raw.md".length);
        if (rawFiles.has(slug)) {
          throw new Error(`Duplicate raw notes slug '${slug}' (${relPath}).`);
        }
        rawFiles.set(slug, { relPath, content: content.replace(/\r\n/g, "\n").trim() });
      } else if (entry.name.endsWith(".en.md")) {
        const slug = entry.name.slice(0, -".en.md".length);
        if (enFiles.has(slug)) {
          throw new Error(`Duplicate English translation slug '${slug}' (${relPath}).`);
        }
        enFiles.set(slug, { relPath, content });
      } else {
        const slug = entry.name.slice(0, -".md".length);
        if (!SLUG_PATTERN.test(slug)) {
          throw new Error(`${relPath}: slug '${slug}' is not lowercase kebab-case.`);
        }
        if (zhFiles.has(slug)) {
          throw new Error(`Duplicate article slug '${slug}' (${relPath}).`);
        }
        zhFiles.set(slug, { relPath, content });
      }
    }
  }

  for (const [slug, enEntry] of enFiles.entries()) {
    if (!zhFiles.has(slug)) {
      throw new Error(`${enEntry.relPath}: missing canonical Chinese article for slug '${slug}'.`);
    }
  }
  for (const [slug, rawEntry] of rawFiles.entries()) {
    if (!zhFiles.has(slug)) {
      throw new Error(`${rawEntry.relPath}: missing canonical Chinese article for slug '${slug}'.`);
    }
    if (!rawEntry.content) {
      throw new Error(`${rawEntry.relPath}: companion raw notes file is empty.`);
    }
  }

  const articles = [];
  for (const [slug, zhEntry] of zhFiles.entries()) {
    const parsedZh = parseWuxuArticleMarkdown(zhEntry.content, zhEntry.relPath);
    const enEntry = enFiles.get(slug);
    const parsedEn = enEntry ? parseWuxuArticleMarkdown(enEntry.content, enEntry.relPath) : null;
    const rawEntry = rawFiles.get(slug);

    articles.push({
      slug,
      sourcePath: zhEntry.relPath,
      enSourcePath: enEntry?.relPath ?? null,
      rawSourcePath: rawEntry?.relPath ?? null,
      title: parsedZh.title,
      titleEn: parsedEn?.title ?? null,
      dimensions: parsedZh.dimensions,
      writtenAt: parsedZh.writtenAt,
      localStamp: `${parsedZh.date} ${parsedZh.time}`,
      timezone: parsedZh.timezone,
      bodyZh: parsedZh.body,
      bodyEn: parsedEn?.body ?? null,
      rawNotes: rawEntry?.content ?? null,
      headingsCount: parsedZh.headings.length,
      leavingLinesCount: parsedZh.leavingLines.length
    });
  }

  articles.sort(
    (a, b) => b.writtenAt.localeCompare(a.writtenAt) || a.slug.localeCompare(b.slug)
  );

  return {
    directory: resolvedDir,
    totalMarkdownFiles,
    articleCount: articles.length,
    englishCount: enFiles.size,
    rawCount: rawFiles.size,
    articles
  };
}

function normalizeServerBaseUrl(raw) {
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed.endsWith("/mcp") ? trimmed.slice(0, -4).replace(/\/+$/, "") : trimmed;
}

function parseCliArgs(argv) {
  const opts = {
    dir: null,
    url: process.env.CHAOX_SERVER_URL?.trim() || process.env.CHAOX_WORKER_URL?.trim() || null,
    dryRun: false
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--dir" && argv[i + 1]) {
      opts.dir = argv[++i];
    } else if (arg === "--url" && argv[i + 1]) {
      opts.url = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: node scripts/import-wuxu.mjs [--dir <chaoxwuxu-repo>] [--url <server-url>] [--dry-run]\n" +
          "Environment: CHAOX_AUTH_TOKEN (required without --dry-run), CHAOX_SERVER_URL (or CHAOX_WORKER_URL)"
      );
      process.exit(0);
    } else if (!arg.startsWith("-") && !opts.dir) {
      opts.dir = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!opts.dir) {
    opts.dir = process.cwd();
  }
  return opts;
}

async function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  const loaded = loadWuxuDirectory(opts.dir);

  console.log(
    `Parsed ${loaded.articleCount} canonical Wuxu articles ` +
      `(${loaded.englishCount} English companion, ${loaded.rawCount} raw notes; ` +
      `${loaded.totalMarkdownFiles} Markdown files scanned) from ${loaded.directory}`
  );

  for (const article of loaded.articles) {
    const flags = [
      article.bodyEn ? "EN" : "--",
      article.rawNotes ? "RAW" : "---"
    ].join(" ");
    console.log(
      `  ${article.localStamp} [${article.dimensions.join(",")}] ${article.slug} ` +
        `(${flags}, h2=${article.headingsCount}, leaving=${article.leavingLinesCount}, zh=${article.bodyZh.length}c) — ${article.title}`
    );
  }

  if (opts.dryRun) {
    console.log("\n[dry-run] Validation succeeded with 0 errors. No network request sent.");
    return;
  }

  if (!opts.url) {
    throw new Error("Missing server URL. Pass --url https://<your-server> or set CHAOX_SERVER_URL.");
  }
  const token = process.env.CHAOX_AUTH_TOKEN?.trim();
  if (!token) {
    throw new Error("Missing CHAOX_AUTH_TOKEN environment variable.");
  }

  const endpoint = `${normalizeServerBaseUrl(opts.url)}/sync/csteix/wuxu/import`;
  const payload = {
    articles: loaded.articles.map((article) => ({
      slug: article.slug,
      title: article.title,
      titleEn: article.titleEn,
      dimensions: article.dimensions,
      writtenAt: article.writtenAt,
      timezone: article.timezone,
      bodyZh: article.bodyZh,
      bodyEn: article.bodyEn,
      rawNotes: article.rawNotes
    }))
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Import failed with HTTP ${response.status}: ${text}`);
  }
  const summary = JSON.parse(text);
  console.log(
    `\nImported to ${endpoint}: inserted=${summary.inserted}, updated=${summary.updated}, ` +
      `unchanged=${summary.unchanged}, totalProcessed=${summary.totalProcessed}`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
