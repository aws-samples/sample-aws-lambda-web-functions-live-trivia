import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFile(resolve(root, path), 'utf8');

test('presentation and rehearsal subsystems are absent from the release', () => {
  for (const path of [
    'observability',
    'scripts/observability',
    'scripts/demo',
    'scripts/experiments',
    'infra/terraform-observability',
    'scripts/gen-snippets.ts',
    'scripts/gen-snippets.test.mjs',
    'scripts/prep-live-' + 'code.ts',
    'scripts/demo-env.sh',
    'scripts/demo-reset.sh',
    'scripts/build-code.sh',
    'scripts/package.sh',
    'infra/terraform/live.tfvars.example',
    'infra/terraform/observability.tf',
    'infra/terraform/observability-migrations.tf',
    'infra/terraform/cloudwatch.tf.disabled',
    'infra/terraform/tests/observability.tftest.hcl',
    'infra/terraform/tests/stage-dashboard.tftest.hcl.disabled',
  ]) {
    assert.equal(existsSync(resolve(root, path)), false, `${path} must be removed`);
  }
});

test('supported scripts and Terraform expose only generic application deployment', async () => {
  const terraform = await readdir(resolve(root, 'infra/terraform'));
  const paths = [
    'scripts/environment.sh',
    'scripts/deploy.sh',
    'scripts/teardown.sh',
    'scripts/per-region-ddb.sh',
    'infra/terraform/terraform.tfvars.example',
    ...terraform.filter((path) => path.endsWith('.tf')).map((path) => `infra/terraform/${path}`),
  ];
  for (const path of paths) {
    const source = await read(path);
    assert.doesNotMatch(
      source,
      /-prepared\b|-canary\b|prepared_(?:api|web|env|lane)|(?:stage|canary)_(?:api|web|function|env)|observability_|enable_observability|enable_client_telemetry|publisher_principal_arns|client_publisher|client_log_group|aws_cloudwatch_dashboard|aws_lambda_function\.widget|custom.widget|TRIVIA_PACKAGE_DIR|OBS_ENDPOINT_NAME|scripts\/(?:demo|observability|experiments|package\.sh|build-code\.sh)|recorded.rehearsal|on.stage|presenter|talk\//i,
      path,
    );
  }
  const manifest = JSON.parse(await read('package.json'));
  assert.equal(Object.keys(manifest.scripts).some((name) => name.startsWith('talk:')), false);
  assert.equal(manifest.scripts['test:observability'], undefined);
  assert.doesNotMatch(manifest.scripts['test:scripts'], /scripts\/(?:demo|observability)|gen-snippets/);
  assert.doesNotMatch(await read('packages/api/src/routers/public.ts'), /\/api\/demo\/probe/);
});
