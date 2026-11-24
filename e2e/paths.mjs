// Repo-relative paths for e2e scripts (no machine-specific absolute paths).
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const WWW = join(ROOT, 'android/www');
export const SERVER_DIR = join(ROOT, 'server');
export const OUT = join(dirname(fileURLToPath(import.meta.url)), 'output');
mkdirSync(OUT, { recursive: true });
export const shot = (name) => join(OUT, name);
