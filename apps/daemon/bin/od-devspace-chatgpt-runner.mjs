#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const entryDir = dirname(fileURLToPath(import.meta.url));
const distEntry = resolve(entryDir, '../dist/integrations/chatgpt-web/devspace-mcp-runner.js');

if (!existsSync(distEntry)) {
  throw new Error(
    `OpenDesign DevSpace runner dist entry not found at ${distEntry}. Run "pnpm --filter @open-design/daemon build" first.`,
  );
}

const { main } = await import(pathToFileURL(distEntry).href);
const exitCode = await main();
process.exitCode = exitCode;
