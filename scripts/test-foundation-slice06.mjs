// Local candidate verification only; restores every dependency link.
// Usage: node scripts/test-foundation-slice06.mjs /absolute/path/protocol.tgz
import { mkdtempSync, readFileSync, writeFileSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tarball = resolve(process.argv[2] ?? 'missing-protocol-tarball');
const integrity = 'sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64');
if (!readFileSync(join(repo, 'pnpm-lock.yaml'), 'utf8').includes(integrity)) throw new Error('candidate tarball does not match lockfile integrity');
const fixture = mkdtempSync(join(tmpdir(), 'memora-slice06-sdk-'));
const run = (command, args, cwd = repo) => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status}`);
};
run('tar', ['-xzf', tarball, '-C', fixture]);
const candidate = join(fixture, 'package');
const version = JSON.parse(readFileSync(join(candidate, 'package.json'))).version;
symlinkSync(join(repo, 'packages/verifier/node_modules'), join(candidate, 'node_modules'), 'dir');
const originals = [];
try {
  for (const name of ['sdk', 'cli', 'verifier']) {
    const path = join(repo, 'packages', name, 'node_modules/@memora-hq/memora-protocol');
    const pin = JSON.parse(readFileSync(join(repo, 'packages', name, 'package.json'))).dependencies['@memora-hq/memora-protocol'];
    if (pin !== version) throw new Error(`candidate version differs from ${name} pin`);
    const target = readlinkSync(path);
    unlinkSync(path); originals.push({ path, target }); symlinkSync(candidate, path, 'dir');
  }
  if (!process.argv.includes('--types-only')) {
    run('pnpm', ['build']);
    run('pnpm', ['test']);
  }
  run('pnpm', ['--filter', '@memora-hq/memora-verifier', '--filter', '@memora-hq/memora-cli', 'exec', 'tsc', '--noEmit']);
  const productionConfig = join(fixture, 'sdk-production-tsconfig.json');
  writeFileSync(productionConfig, JSON.stringify({ extends: join(repo, 'packages/sdk/tsconfig.release.json'), compilerOptions: { typeRoots: [join(repo, 'packages/verifier/node_modules/@types')] }, exclude: [join(repo, 'packages/sdk/src/**/*.test.ts')] }));
  run('pnpm', ['--filter', '@memora-hq/memora-core', 'exec', 'tsc', '--noEmit', '-p', productionConfig]);
  run('pnpm', ['check:local-boundary']);
} finally {
  for (const { path, target } of originals.reverse()) { unlinkSync(path); symlinkSync(target, path, 'dir'); }
}
console.log(`Verified public SDK against packed protocol ${version}; dependency links restored. Fixture: ${fixture}`);
