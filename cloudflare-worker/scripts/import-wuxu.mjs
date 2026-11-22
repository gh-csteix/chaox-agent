#!/usr/bin/env node
import { pathToFileURL } from "node:url";
export { loadWuxuDirectory, parseWuxuArticleMarkdown } from "../../server/scripts/import-wuxu.mjs";

const targetUrl = new URL("../../server/scripts/import-wuxu.mjs", import.meta.url);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.argv[1] = targetUrl.pathname;
  await import(targetUrl.href);
}
