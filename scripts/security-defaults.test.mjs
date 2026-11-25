import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(import.meta.dirname, '..');

async function read(relativePath) {
  return readFile(resolve(repositoryRoot, relativePath), 'utf8');
}

test('local server defaults bind only to loopback', async () => {
  const [makefile, apiServer, webServer, webPackageText] = await Promise.all([
    read('Makefile'),
    read('packages/api/src/app.ts'),
    read('packages/web/index.js'),
    read('packages/web/package.json'),
  ]);
  const webPackage = JSON.parse(webPackageText);

  assert.match(makefile, /^API_ENDPOINT \?= 127\.0\.0\.1:3000$/m);
  assert.match(makefile, /^WEB_ENDPOINT \?= 127\.0\.0\.1:3001$/m);
  assert.match(
    apiServer,
    /process\.env\.AWS_LAMBDA_HTTP_ENDPOINT \|\| '127\.0\.0\.1:3000'/,
  );
  assert.match(
    webServer,
    /process\.env\.AWS_LAMBDA_HTTP_ENDPOINT \|\| '127\.0\.0\.1:3001'/,
  );
  assert.equal(webPackage.scripts.dev, 'vite --host 127.0.0.1 --port 5173');
});

test('Lambda-provided bind addresses still take precedence', async () => {
  const [apiServer, webServer] = await Promise.all([
    read('packages/api/src/app.ts'),
    read('packages/web/index.js'),
  ]);

  assert.match(apiServer, /process\.env\.AWS_LAMBDA_HTTP_ENDPOINT \|\|/);
  assert.match(webServer, /process\.env\.AWS_LAMBDA_HTTP_ENDPOINT \|\|/);
});
