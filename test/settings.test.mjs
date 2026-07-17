import assert from 'node:assert/strict';
import test from 'node:test';

import { createBrowserLikeContext, loadClassicScript } from './helpers/load-classic-script.mjs';

function loadSettings(storedValue) {
  const context = createBrowserLikeContext({
    localStorage: {
      getItem: () => storedValue,
      setItem: () => {},
    },
  });
  return loadClassicScript('js/settings.js', 'Settings', context).exported;
}

test('saved searches recover from valid JSON with the wrong schema', () => {
  assert.deepEqual(Array.from(loadSettings('{}').getSavedSearches()), []);
  assert.deepEqual(Array.from(loadSettings('null').getSavedSearches()), []);
});

test('saved searches discard malformed entries without breaking valid ones', () => {
  const Settings = loadSettings(JSON.stringify([
    { name: 'valid', params: { region: 'japan' } },
    { name: '', params: {} },
    { name: 'bad-params', params: [] },
    null,
  ]));
  const saved = Settings.getSavedSearches();
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'valid');
});

test('saved searches recover when storage access is blocked', () => {
  const context = createBrowserLikeContext({
    localStorage: {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    },
  });
  const Settings = loadClassicScript('js/settings.js', 'Settings', context).exported;
  assert.deepEqual(Array.from(Settings.getSavedSearches()), []);
});
