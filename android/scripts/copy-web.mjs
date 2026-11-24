// Copies the shared web UI from ../server/app/static into www/ (single source of truth)
// and adds the native-only JS (Capacitor core runtime + BLE plugin wrapper).
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '..', 'server', 'app', 'static');
const dst = join(root, 'www');
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true, filter: (p) => !p.endsWith('manifest.webmanifest') });
const nm = join(root, 'node_modules');
cpSync(join(nm, '@capacitor/core/dist/capacitor.js'), join(dst, 'vendor/capacitor.js'));
cpSync(join(nm, '@capacitor-community/bluetooth-le/dist/plugin.js'), join(dst, 'vendor/bluetooth-le.js'));
const idx = join(dst, 'index.html');
const html = readFileSync(idx, 'utf8').replace('<script src="core.js"></script>',
  '<script src="vendor/capacitor.js"></script>\n  <script src="vendor/bluetooth-le.js"></script>\n  <script src="core.js"></script>');
writeFileSync(idx, html);
console.log('copied', src, '->', dst, '(+ native vendor scripts)');
