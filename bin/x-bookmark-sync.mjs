#!/usr/bin/env node
import { archiveSyncMain } from '../dist/archive-sync.js';

try {
  await archiveSyncMain();
} catch (error) {
  console.error(`x-bookmark-sync: ${error.message}`);
  process.exitCode = 1;
}
