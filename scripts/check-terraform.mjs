import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { scannerEnvironment } from './scanner-environment.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'serverlessq-terraform-home-'));
const environment = scannerEnvironment(directory);
function terraform(args, workspace) {
  const result = spawnSync('terraform', args, {
    cwd: root,
    env: { ...environment, ...(workspace ? { TF_WORKSPACE: workspace } : {}) },
    stdio: 'inherit',
    timeout: 10 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Terraform failed with status ${result.status}`);
}
try {
  const version = spawnSync('terraform', ['version', '-json'], {
    env: environment,
    encoding: 'utf8',
  });
  if (version.error) throw version.error;
  if (version.status !== 0 || JSON.parse(version.stdout).terraform_version !== '1.16.3') {
    throw new Error('Terraform 1.16.3 is required for the publication gate');
  }
  terraform(['-chdir=infra/terraform', 'fmt', '-check', '-recursive']);
  terraform([
    '-chdir=infra/terraform',
    'init',
    '-backend=false',
    '-input=false',
    '-lockfile=readonly',
  ]);
  terraform(['-chdir=infra/terraform', 'validate', '-no-color']);
  terraform(['-chdir=infra/terraform', 'test', '-no-color'], 'demo1');
  terraform(
    ['-chdir=infra/terraform', 'test', '-no-color', '-test-directory=tests/legacy'],
    'default',
  );
  terraform(
    ['-chdir=infra/terraform', 'test', '-no-color', '-test-directory=tests/long-names'],
    'abcdefghijklmnopqrst',
  );
} catch (error) {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
