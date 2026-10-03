import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');

test('startup scripts and styles are bundled, integrity-checked, and available offline', () => {
  const context = createBrowserLikeContext({ self: { addEventListener() {}, skipWaiting() {} } });
  const { exported: shell } = loadClassicScript('sw.js', 'APP_SHELL', context);
  const tags = html.match(/<(?:script\b[^>]*\bsrc=|link\b[^>]*\brel="stylesheet")[^>]*>/g);
  assert.ok(tags.length > 0);
  for (const tag of tags) {
    const path = tag.match(/(?:src|href)="([^"]+)"/)[1];
    assert.doesNotMatch(path, /^(?:https?:)?\/\//, `Remote startup dependency: ${path}`);
    assert.ok(existsSync(new URL(path, root)), `Missing asset: ${path}`);
    assert.ok(shell.includes(`./${path}`), `Not cached offline: ${path}`);
    const integrity = tag.match(/integrity="([^"]+)"/)?.[1];
    if (integrity) {
      const actual = createHash('sha256').update(readFileSync(new URL(path, root))).digest('base64');
      assert.equal(integrity, `sha256-${actual}`, `Invalid integrity: ${path}`);
    }
  }
  for (const path of shell) {
    assert.ok(existsSync(new URL(path, root)), `Missing offline shell file: ${path}`);
  }
});
