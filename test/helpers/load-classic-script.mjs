import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function createBrowserLikeContext(overrides = {}) {
  const context = vm.createContext({
    AbortController,
    Blob,
    DOMException,
    Response,
    URL,
    URLSearchParams,
    clearInterval,
    clearTimeout,
    console,
    fetch,
    setInterval,
    setTimeout,
    ...overrides,
  });
  context.globalThis = context;
  return context;
}

export function loadClassicScript(relativePath, globalName, context = createBrowserLikeContext()) {
  const filename = path.join(projectRoot, relativePath);
  vm.runInContext(readFileSync(filename, 'utf8'), context, { filename });
  return {
    context,
    exported: vm.runInContext(globalName, context),
  };
}
