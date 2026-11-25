import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');

function atLeast(version, minimum) {
  const actual = version.split('.').map(Number);
  const target = minimum.split('.').map(Number);
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== target[index]) return actual[index] > target[index];
  }
  return true;
}

function resolvedDependency(lock, packagePath, name) {
  const parts = packagePath ? packagePath.split('/') : [];
  while (true) {
    const key = [...parts, 'node_modules', name].join('/');
    if (lock.packages[key]) return lock.packages[key];
    if (!parts.length) return undefined;
    parts.pop();
  }
}

for (const path of [
  'package-lock.json',
  'deploy/locks/api/package-lock.json',
  'deploy/locks/web/package-lock.json',
]) {
  test(`${path} locks compatible patched parsers from public npm`, async () => {
    const lock = JSON.parse(await readFile(resolve(root, path), 'utf8'));
    for (const [name, minimum, major] of [
      ['body-parser', '2.4.0', '2'],
      ['qs', '6.16.1', '6'],
    ]) {
      const entries = Object.entries(lock.packages).filter(
        ([key]) => key.endsWith(`/node_modules/${name}`) || key === `node_modules/${name}`,
      );
      assert.ok(entries.length > 0, `Missing ${name} runtime dependency`);
      for (const [key, pkg] of entries) {
        assert.ok(atLeast(pkg.version, minimum), `${key} ${pkg.version} must be >= ${minimum}`);
        assert.equal(pkg.version.split('.')[0], major, `${name} must retain a compatible major`);
        assert.ok(pkg.resolved.startsWith('https://registry.npmjs.org/'));
        assert.ok(pkg.integrity.startsWith('sha512-'));
      }
    }
    if (path !== 'deploy/locks/web/package-lock.json') {
      const zod =
        path === 'package-lock.json'
          ? resolvedDependency(lock, 'packages/api', 'zod')
          : resolvedDependency(lock, '', 'zod');
      assert.ok(zod, 'Missing Zod runtime dependency');
      assert.ok(atLeast(zod.version, '4.6.6'), `Zod ${zod.version} must be >= 4.6.6`);
      assert.equal(zod.version.split('.')[0], '4', 'Zod must use the patched major');
      assert.ok(zod.resolved.startsWith('https://registry.npmjs.org/'));
      assert.ok(zod.integrity.startsWith('sha512-'));
      if (path === 'package-lock.json') {
        assert.equal(lock.packages['packages/api'].dependencies.zod, '^4.6.6');
      }
    }
  });
}
