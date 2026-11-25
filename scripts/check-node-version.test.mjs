import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkNodeVersion } from './check-node-version.mjs';

const checkerUrl = new URL('./check-node-version.mjs', import.meta.url);
const checkerPath = fileURLToPath(checkerUrl);

for (const version of ['18.20.8', '23.9.0']) {
  test(`rejects unsupported Node.js ${version}`, () => {
    assert.throws(
      () => checkNodeVersion(version),
      (error) => /Node\.js 24 or newer/.test(error.message) && error.message.includes(version),
    );
  });
}

for (const version of ['24.0.0', '24.21.0', '25.1.0']) {
  test(`accepts supported Node.js ${version}`, () => {
    assert.doesNotThrow(() => checkNodeVersion(version));
  });
}

test('the CLI succeeds quietly on the supported runtime', () => {
  const result = spawnSync(process.execPath, [checkerPath], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

test('the CLI fails with upgrade guidance on an unsupported runtime', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      'data:text/javascript,Object.defineProperty(process.versions,"node",{value:"23.9.0"});',
      checkerPath,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Node\.js 24 or newer/);
  assert.match(result.stderr, /23\.9\.0/);
  assert.match(result.stderr, /nvm use 24/);
});

test('importing the checker without a CLI path does not run the preflight', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `delete process.argv[1];
       Object.defineProperty(process.versions, 'node', { value: '23.9.0' });
       await import(${JSON.stringify(checkerUrl.href)});`,
    ],
    { encoding: 'utf8' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
