import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const files = [
  ...readdirSync('js').filter(file => file.endsWith('.js')).map(file => `js/${file}`),
  'sw.js',
];

for (const file of files) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
