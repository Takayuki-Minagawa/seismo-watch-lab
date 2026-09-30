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

function createSettingsForm({ search = '', savedSearches = [] } = {}) {
  const createElement = () => {
    const listeners = new Map();
    return {
      value: '',
      style: {},
      appendChild: () => {},
      addEventListener(type, handler) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(handler);
      },
      dispatch(type) {
        for (const handler of listeners.get(type) || []) handler({ type });
      },
    };
  };
  const fields = Object.fromEntries([
    'startdate', 'enddate', 'minmag', 'maxdepth', 'region', 'limit',
    'custom-minlat', 'custom-maxlat', 'custom-minlon', 'custom-maxlon',
    'circle-latitude', 'circle-longitude', 'circle-radius',
    'custom-bounds', 'circle-bounds', 'saved-conditions',
    'btn-save-condition', 'btn-delete-condition', 'btn-reset', 'btn-share',
  ].map(id => [id, createElement()]));
  fields.region.value = 'global';
  fields.minmag.value = '4';
  fields.limit.value = '200';
  const prompts = [];
  const context = createBrowserLikeContext({
    document: {
      getElementById: id => fields[id],
      createElement,
    },
    localStorage: {
      getItem: () => JSON.stringify(savedSearches),
      setItem: () => {},
    },
    location: { search, origin: 'https://example.test', pathname: '/seismo-watch-lab/' },
    navigator: {},
    prompt: (...args) => prompts.push(args),
  });
  const { exported: Settings } = loadClassicScript('js/settings.js', 'Settings', context);
  return { Settings, fields, prompts };
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

test('loading saved conditions restores quick mode and clears it for a manual search', () => {
  const { Settings, fields } = createSettingsForm({ savedSearches: [
    { name: 'recent', params: { quick: '24h-4.5', region: 'global' } },
    { name: 'japan', params: { region: 'japan', minmag: '2' } },
  ] });
  Settings.initSavedSearches();
  Settings.setActiveQuickType('365d-7.0');
  fields['saved-conditions'].value = 'recent';
  fields['saved-conditions'].dispatch('change');
  assert.equal(Settings.getActiveQuickType(), '24h-4.5');
  assert.equal(Settings.getCurrentSearchParams().quick, '24h-4.5');

  fields['saved-conditions'].value = 'japan';
  fields['saved-conditions'].dispatch('change');
  assert.equal(Settings.getActiveQuickType(), null);
  assert.equal(Settings.getCurrentSearchParams().quick, undefined);
  assert.equal(fields.region.value, 'japan');
});

test('deliberate form edits and reset switch saved or shared conditions to manual mode', () => {
  const { Settings, fields } = createSettingsForm();
  Settings.initSavedSearches();
  for (const [id, event] of [
    ['startdate', 'input'], ['region', 'change'],
    ['circle-radius', 'input'], ['btn-reset', 'click'],
  ]) {
    Settings.setActiveQuickType('24h-4.5');
    fields[id].dispatch(event);
    assert.equal(Settings.getActiveQuickType(), null, `${id} ${event}`);
  }
});

test('unknown quick modes do not override valid manual URL filters', () => {
  const { Settings, fields } = createSettingsForm({ search: '?quick=unknown&region=japan&minmag=2' });
  assert.equal(Settings.restoreFromURL(), 'manual');
  assert.equal(Settings.getActiveQuickType(), null);
  assert.equal(fields.region.value, 'japan');
  assert.equal(fields.minmag.value, '2');
  Settings.setActiveQuickType('unknown');
  assert.equal(Settings.getActiveQuickType(), null);
  Settings.applySearchParams({ quick: 'unknown' });
  assert.equal(Settings.getActiveQuickType(), null);
});

test('valid quick URLs retain their rolling preset', () => {
  const { Settings } = createSettingsForm({ search: '?quick=7d-5.0' });
  assert.equal(Settings.restoreFromURL(), 'quick');
  assert.equal(Settings.getActiveQuickType(), '7d-5.0');
});

test('circle searches share and restore all coordinates, zero values, and empty dates', () => {
  const source = createSettingsForm();
  source.Settings.applySearchParams({
    startdate: '', enddate: '', minmag: '2', region: 'circle',
    latitude: '0', longitude: '-179.5', maxradiuskm: '150',
  });
  assert.equal(source.fields['circle-bounds'].style.display, 'grid');
  assert.equal(source.fields['custom-bounds'].style.display, 'none');
  source.Settings.initShare();
  source.fields['btn-share'].dispatch('click');
  const url = new URL(source.prompts[0][1]);
  assert.equal(url.searchParams.get('latitude'), '0');
  assert.equal(url.searchParams.get('startdate'), '');

  const restored = createSettingsForm({ search: url.search });
  restored.fields.startdate.value = '2026-09-23';
  restored.fields.enddate.value = '2026-09-30';
  assert.equal(restored.Settings.restoreFromURL(), 'manual');
  assert.deepEqual(
    JSON.parse(JSON.stringify(restored.Settings.getCurrentSearchParams())),
    JSON.parse(JSON.stringify(source.Settings.getCurrentSearchParams()))
  );
  assert.equal(restored.fields['circle-bounds'].style.display, 'grid');
  restored.Settings.applySearchParams({ region: 'custom' });
  assert.equal(restored.fields['circle-bounds'].style.display, 'none');
  assert.equal(restored.fields['custom-bounds'].style.display, 'grid');
});

test('partial manual URLs preserve defaults for unspecified fields', () => {
  const { Settings, fields } = createSettingsForm({ search: '?region=japan' });
  assert.equal(Settings.restoreFromURL(), 'manual');
  assert.equal(fields.minmag.value, '4');
  assert.equal(fields.limit.value, '200');
});
