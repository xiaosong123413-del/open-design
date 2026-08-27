#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entryDir = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(entryDir, '../dist/integrations/chatgpt-web/cli.js');

if (!existsSync(distEntry)) {
  throw new Error(
    `OpenDesign ChatGPT Web bridge entry not found at ${distEntry}. Run "pnpm bootstrap" after install (or "pnpm --filter @open-design/daemon build").`,
  );
}

const { main } = await import(pathToFileURL(distEntry).href);
const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
