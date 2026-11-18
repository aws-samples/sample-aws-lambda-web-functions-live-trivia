import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import yaml from 'js-yaml';

const root = resolve(import.meta.dirname, '..');

async function validator() {
  return (await import('./scanner-reports.mjs')).validateReport;
}

test('scanner reports reject status failures, findings, parser errors, and empty scans', async () => {
  const validate = await validator();
  const banditExceptions = JSON.parse(
    await readFile(join(root, 'scripts/scanners/bandit-exceptions.json'), 'utf8'),
  );
  const bandit = {
    errors: [],
    results: [],
    metrics: {
      _totals: { loc: 20, nosec: 0, skipped_tests: 2 },
      './scripts/environment.test.py': { skipped_tests: 2 },
    },
  };
  const semgrep = {
    errors: [],
    results: [],
    paths: { scanned: ['packages/api/src/app.ts'] },
    skipped_rules: [],
  };
  const checkov = {
    check_type: 'terraform',
    results: { passed_checks: [{}], failed_checks: [], skipped_checks: [], parsing_errors: [] },
    summary: { resource_count: 1, passed: 1, failed: 0, skipped: 0, parsing_errors: 0 },
  };
  for (const [tool, report, exceptions] of [
    ['bandit', bandit, banditExceptions],
    ['semgrep', semgrep, []],
  ]) {
    assert.doesNotThrow(() => validate(tool, report, 0, exceptions));
    assert.throws(() => validate(tool, report, 2, exceptions), /status/i);
    assert.throws(() => validate(tool, {}, 0, exceptions), /report/i);
  }
  assert.throws(() => validate('checkov', checkov, 0, []), /policy/i);
  for (const patch of [
    { errors: [{ reason: 'SyntaxError' }] },
    { results: [{ test_id: 'B603' }] },
    { metrics: { _totals: { loc: 0 } } },
  ])
    assert.throws(() => validate('bandit', { ...bandit, ...patch }, 0, banditExceptions));
  for (const patch of [
    { errors: [{ type: 'PartialParsing' }] },
    { results: [{ check_id: 'node-shell-injection' }] },
    { paths: { scanned: [] } },
  ])
    assert.throws(() => validate('semgrep', { ...semgrep, ...patch }, 0, []));
  for (const patch of [
    { summary: { ...checkov.summary, resource_count: 0 } },
    { summary: { ...checkov.summary, parsing_errors: 1 } },
    { results: { ...checkov.results, parsing_errors: ['broken.tf'] } },
    { results: { ...checkov.results, failed_checks: [{ check_id: 'CKV_AWS_18' }] } },
  ])
    assert.throws(() => validate('checkov', { ...checkov, ...patch }, 0, []));
  assert.throws(() => validate('gitleaks', [{ RuleID: 'generic-api-key' }], 0), /finding/i);
  assert.doesNotThrow(() => validate('gitleaks', [], 0));
  assert.throws(() => validate('gitleaks', {}, 0), /report/i);
});

test('Semgrep must examine every tracked JavaScript/TypeScript input', async () => {
  const validate = await validator();
  const report = {
    errors: [],
    results: [],
    paths: { scanned: ['packages/api/src/app.ts'] },
    skipped_rules: [],
  };
  assert.doesNotThrow(() => validate('semgrep', report, 0, [], ['packages/api/src/app.ts']));
  assert.throws(
    () =>
      validate('semgrep', report, 0, [], ['packages/api/src/app.ts', 'packages/web/src/App.tsx']),
    /coverage|unscanned/i,
  );
  assert.throws(
    () =>
      validate(
        'semgrep',
        {
          ...report,
          skipped_rules: [{ rule_id: 'broken' }],
        },
        0,
      ),
    /skip/i,
  );
});

test('link reports reject missing counters, empty scans, parser errors, and failures', async () => {
  const validate = await validator();
  const report = {
    total: 9,
    successful: 9,
    excludes: 0,
    unknown: 0,
    unsupported: 0,
    timeouts: 0,
    errors: 0,
    error_map: {},
    timeout_map: {},
    excluded_map: {},
  };
  assert.doesNotThrow(() => validate('lychee', report, 0));
  for (const patch of [
    { total: 0 },
    { successful: 0 },
    { excludes: 1, excluded_map: { 'README.md': ['https://example.invalid'] } },
    { errors: 1 },
    { errors: undefined },
    { unknown: 1 },
    { unsupported: 1 },
    { timeouts: 1 },
    { error_map: { 'index.html': [{ url: 'error:' }] } },
  ])
    assert.throws(() => validate('lychee', { ...report, ...patch }, 0));
  assert.throws(() => validate('lychee', report, 2), /status/i);

  const offlineExternal = {
    ...report,
    total: 11,
    successful: 9,
    excludes: 2,
    excluded_map: {
      'SECURITY.md': [
        { url: 'https://hackerone.com/aws_vdp' },
        { url: 'mailto:aws-security@amazon.com' },
      ],
    },
  };
  assert.doesNotThrow(() =>
    validate('lychee', offlineExternal, 0, [], [], { offlineExternalExclusions: true }),
  );
  assert.throws(() => validate('lychee', offlineExternal, 0));
  for (const invalid of [
    {
      ...offlineExternal,
      excluded_map: { 'README.md': [{ url: 'file:///tmp/private' }, { url: 'README.md' }] },
    },
    { ...offlineExternal, excludes: 1 },
  ])
    assert.throws(() =>
      validate('lychee', invalid, 0, [], [], { offlineExternalExclusions: true }),
    );
});

test('installer refuses nonempty targets without changing their content', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'publication-installer-test-'));
  try {
    await writeFile(join(fixture, 'keep.txt'), 'existing content\n');
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/install-scanners.mjs'),
        '--destination',
        fixture,
        '--python',
        'missing-test-python',
      ],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /empty/i);
    assert.equal(await readFile(join(fixture, 'keep.txt'), 'utf8'), 'existing content\n');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('installer rejects altered binary downloads before extracting or executing them', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'publication-checksum-test-'));
  try {
    const python = join(fixture, 'python');
    await writeFile(
      python,
      `#!${process.execPath}\nif (process.argv[2] !== '-c') process.exit(3);\n`,
      { mode: 0o755 },
    );
    await writeFile(
      join(fixture, 'curl'),
      `#!${process.execPath}\nprocess.stdout.write('untrusted download');\n`,
      { mode: 0o755 },
    );
    const destination = join(fixture, 'tools');
    const result = spawnSync(
      process.execPath,
      [
        join(root, 'scripts/install-scanners.mjs'),
        '--destination',
        destination,
        '--python',
        python,
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${fixture}:${process.env.PATH}` } },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /checksum mismatch/i);
    await assert.rejects(readFile(join(destination, 'bin/gitleaks')), /ENOENT/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('scanner environments discard inherited credentials and disable AWS configuration/metadata', async () => {
  const { scannerEnvironment } = await import('./scanner-environment.mjs');
  const keys = [
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'GITHUB_TOKEN',
    'SEMGREP_APP_TOKEN',
    'BC_API_KEY',
  ];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'synthetic-test-value';
    const environment = scannerEnvironment('/tmp/scanner-home');
    for (const key of keys) assert.equal(environment[key], undefined);
    assert.equal(environment.AWS_EC2_METADATA_DISABLED, 'true');
    assert.equal(environment.AWS_CONFIG_FILE, '/dev/null');
    assert.equal(environment.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
    assert.equal(environment.HOME, '/tmp/scanner-home');
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test('Terraform wrapper runs only locked initialization, validation, and the three mock suites', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'publication-terraform-test-'));
  try {
    const log = join(fixture, 'calls.jsonl');
    await writeFile(
      join(fixture, 'terraform'),
      `#!${process.execPath}
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2), workspace: process.env.TF_WORKSPACE,
  metadata: process.env.AWS_EC2_METADATA_DISABLED,
  config: process.env.AWS_CONFIG_FILE,
  credentialsFile: process.env.AWS_SHARED_CREDENTIALS_FILE,
  inheritedCredential: process.env.AWS_ACCESS_KEY_ID !== undefined,
}) + '\\n');
if (process.argv[2] === 'version') console.log('{"terraform_version":"1.16.3"}');
`,
      { mode: 0o755 },
    );
    const result = spawnSync(process.execPath, [join(root, 'scripts/check-terraform.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fixture}:${process.env.PATH}`,
        AWS_ACCESS_KEY_ID: 'synthetic-test-value',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['version', '-json'],
        ['-chdir=infra/terraform', 'fmt', '-check', '-recursive'],
        ['-chdir=infra/terraform', 'init', '-backend=false', '-input=false', '-lockfile=readonly'],
        ['-chdir=infra/terraform', 'validate', '-no-color'],
        ['-chdir=infra/terraform', 'test', '-no-color'],
        ['-chdir=infra/terraform', 'test', '-no-color', '-test-directory=tests/legacy'],
        ['-chdir=infra/terraform', 'test', '-no-color', '-test-directory=tests/long-names'],
      ],
    );
    assert.deepEqual(
      calls.slice(-3).map((call) => call.workspace),
      ['demo1', 'default', 'abcdefghijklmnopqrst'],
    );
    for (const call of calls) {
      assert.equal(call.metadata, 'true');
      assert.equal(call.config, '/dev/null');
      assert.equal(call.credentialsFile, '/dev/null');
      assert.equal(call.inheritedCredential, false);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('Checkov skips must match resource, rule, file, and exact documented rationale', async () => {
  const validate = await validator();
  const exceptions = JSON.parse(
    await readFile(join(root, 'scripts/scanners/checkov-exceptions.json'), 'utf8'),
  );
  const skips = exceptions.map((exception) => ({
    check_id: exception.check_id,
    resource: exception.resource,
    file_path: `/${exception.file}`,
    check_result: { result: 'SKIPPED', suppress_comment: exception.rationale },
  }));
  const report = {
    check_type: 'terraform',
    results: { passed_checks: [{}], failed_checks: [], skipped_checks: skips, parsing_errors: [] },
    summary: {
      resource_count: 7,
      passed: 1,
      failed: 0,
      skipped: skips.length,
      parsing_errors: 0,
    },
  };
  assert.doesNotThrow(() => validate('checkov', report, 0, exceptions));
  assert.throws(() => validate('checkov', report, 0, []), /policy/i);
  for (const patch of [{ check_id: 'CKV_AWS_21' }, { resource: 'aws_s3_bucket.unrelated' }]) {
    const altered = exceptions.map((entry, index) => (index === 0 ? { ...entry, ...patch } : entry));
    assert.throws(
      () => validate('checkov', report, 0, altered),
      /policy/i,
    );
  }
  const versioning = {
    check_id: 'CKV_AWS_21',
    resource: 'aws_s3_bucket.code',
    file: 's3.tf',
    rationale: 'Invented versioning exception must never be accepted by this sample policy.',
  };
  assert.throws(() => validate('checkov', report, 0, [...exceptions, versioning]), /policy/i);
  assert.throws(
    () =>
      validate(
        'checkov',
        {
          ...report,
          results: { ...report.results, skipped_checks: [] },
        },
        0,
        exceptions,
      ),
    /summary/i,
  );
  assert.throws(
    () =>
      validate(
        'checkov',
        {
          ...report,
          summary: { ...report.summary, skipped: 0 },
          results: { ...report.results, skipped_checks: [] },
        },
        0,
        exceptions,
      ),
    /unused/i,
  );
});

test('Bandit suppressions are limited to two exact test-harness dispositions', async () => {
  const { validateBanditSourceExceptions } = await import('./scanner-policy.mjs');
  const exceptions = JSON.parse(
    await readFile(join(root, 'scripts/scanners/bandit-exceptions.json'), 'utf8'),
  );
  const source = await readFile(join(root, 'scripts/environment.test.py'), 'utf8');
  assert.doesNotThrow(() =>
    validateBanditSourceExceptions(
      [{ file: 'scripts/environment.test.py', content: source }],
      exceptions,
    ),
  );
  const bare = `# ${'no' + 'sec'}`;
  assert.throws(
    () =>
      validateBanditSourceExceptions(
        [{ file: 'scripts/environment.test.py', content: `${source}\n${bare}\n` }],
        exceptions,
      ),
    /bare|suppress/i,
  );
  assert.throws(
    () =>
      validateBanditSourceExceptions(
        [{ file: 'scripts/environment.test.py', content: source }],
        [...exceptions, { ...exceptions[0], line: 9 }],
      ),
    /policy/i,
  );

  const validate = await validator();
  const metrics = {
    _totals: { loc: 20, nosec: 0, skipped_tests: 2 },
    './scripts/environment.test.py': { skipped_tests: 2 },
  };
  const report = { errors: [], results: [], metrics };
  assert.doesNotThrow(() => validate('bandit', report, 0, exceptions));
  assert.throws(
    () =>
      validate(
        'bandit',
        { ...report, metrics: { ...metrics, _totals: { ...metrics._totals, nosec: 1 } } },
        0,
        exceptions,
      ),
    /bare|nosec/i,
  );
  assert.throws(
    () =>
      validate(
        'bandit',
        {
          ...report,
          metrics: { ...metrics, _totals: { ...metrics._totals, skipped_tests: 3 } },
        },
        0,
        exceptions,
      ),
    /skipped/i,
  );
});

test('scanner runner disables inline Semgrep suppressions', async () => {
  const runner = await readFile(join(root, 'scripts/run-publication-scans.mjs'), 'utf8');
  assert.match(runner, /'--disable-nosem'/);
});

test('link scanner treats option-like tracked filenames as literal inputs', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'publication-link-options-test-'));
  try {
    const repo = join(fixture, 'repo');
    const tools = join(fixture, 'tools');
    await mkdir(join(repo, 'scripts/scanners'), { recursive: true });
    await mkdir(join(tools, 'bin'), { recursive: true });
    await writeFile(join(repo, '--exclude=.*.md'), '# [safe](https://example.com)\n');
    await writeFile(join(repo, '.lychee.toml'), 'max_retries = 0\n');
    await writeFile(
      join(repo, 'scripts/scanners/versions.json'),
      await readFile(join(root, 'scripts/scanners/versions.json')),
    );
    await writeFile(
      join(tools, 'bin/lychee'),
      `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('lychee 0.24.2');
} else {
  const boundary = args.indexOf('--');
  const input = args.indexOf('--exclude=.*.md');
  if (boundary < 0 || input <= boundary) process.exit(9);
  const output = args[args.indexOf('--output') + 1];
  writeFileSync(output, JSON.stringify({
    total: 1, successful: 1, unknown: 0, unsupported: 0, timeouts: 0,
    excludes: 0, errors: 0, error_map: {}, timeout_map: {}, excluded_map: {}
  }));
}
`,
      { mode: 0o755 },
    );
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['add', '--', '.'], { cwd: repo }).status, 0);
    const result = spawnSync(
      process.execPath,
      [join(root, 'scripts/run-publication-scans.mjs'), 'links', '--offline', '--tools', tools],
      { cwd: repo, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PASS: links/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('publication workflow uses bounded, credential-free jobs with immutable action pins', async () => {
  const workflow = yaml.load(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(Object.keys(workflow.jobs).length, 3);
  const allRuns = [];
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-24.04');
    assert.ok(job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 30);
    assert.equal(job.permissions, undefined);
    for (const step of job.steps) {
      assert.equal(step['continue-on-error'], undefined);
      if (step.uses) {
        assert.match(step.uses, /^[a-z0-9-]+\/[a-z0-9-]+@[a-f0-9]{40}$/i);
        if (step.uses.startsWith('actions/checkout@')) {
          assert.equal(step.with['persist-credentials'], false);
          assert.equal(step.with.token, undefined);
        }
        if (step.uses.startsWith('actions/setup-node@')) {
          assert.equal(String(step.with['node-version']), '24');
          assert.equal(step.with['package-manager-cache'], false);
        }
      }
      if (step.run) allRuns.push(step.run);
    }
  }
  const text = JSON.stringify(workflow);
  assert.doesNotMatch(
    text,
    /pull_request_target|id-token|write-all|contents":"write|secrets\.|SARIF|upload-sarif|github-script|configure-aws-credentials/i,
  );
  assert.doesNotMatch(
    allRuns.join('\n'),
    /\|\|\s*true|--soft-fail|--skip-check|--exit-zero|\baws\s|\bterraform\s+(apply|destroy|plan)|npm\s+(install|run\s+test:(all|integration))/,
  );
  assert.ok(allRuns.some((run) => run.includes('npm ci')));
  assert.ok(allRuns.some((run) => run.includes('npm run test:scripts')));
  assert.ok(allRuns.some((run) => run.includes('npm run check:terraform')));
  assert.ok(allRuns.some((run) => run.includes('all --online')));
  assert.equal(workflow.jobs.scanners.steps[0].with['fetch-depth'], 0);
});

test('Terraform provider lock supports local macOS and GitHub Linux runners', async () => {
  const lock = await readFile(join(root, 'infra/terraform/.terraform.lock.hcl'), 'utf8');
  const packageHashes = lock.match(/"h1:[^"]+"/g) ?? [];
  assert.ok(
    packageHashes.length >= 2,
    'Regenerate the provider lock for darwin_arm64 and linux_amd64',
  );
});

test('tracked snapshots preserve filenames and omit untracked and ignored files', async () => {
  const { trackedSnapshot } = await import('./run-publication-scans.mjs');
  const fixture = await mkdtemp(join(tmpdir(), 'publication-input-test-'));
  try {
    const repo = join(fixture, 'repo');
    await mkdir(repo);
    await writeFile(join(repo, 'a document.md'), '# Hello\n');
    await writeFile(join(repo, '.gitignore'), 'ignored.md\n');
    await writeFile(join(repo, 'ignored.md'), 'local secret\n');
    await writeFile(join(repo, 'untracked.md'), 'local secret\n');
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['add', '.gitignore', 'a document.md'], { cwd: repo }).status, 0);
    const snapshot = await trackedSnapshot(repo, join(fixture, 'snapshot'));
    assert.deepEqual(snapshot.files.sort(), ['.gitignore', 'a document.md']);
    assert.equal(await readFile(join(snapshot.directory, 'a document.md'), 'utf8'), '# Hello\n');
    await assert.rejects(readFile(join(snapshot.directory, 'ignored.md')), /ENOENT/);
    await assert.rejects(readFile(join(snapshot.directory, 'untracked.md')), /ENOENT/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('scanner CLI fails for missing tools, missing JSON, and malformed JSON', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'publication-cli-test-'));
  try {
    const repo = join(fixture, 'repo');
    await mkdir(join(repo, 'scripts/scanners'), { recursive: true });
    await writeFile(join(repo, 'scripts/harness.py'), 'print("hello")\n');
    await writeFile(
      join(repo, 'scripts/scanners/versions.json'),
      await readFile(join(root, 'scripts/scanners/versions.json')),
    );
    assert.equal(spawnSync('git', ['init', '--quiet'], { cwd: repo }).status, 0);
    assert.equal(spawnSync('git', ['add', '.'], { cwd: repo }).status, 0);
    const runner = join(root, 'scripts/run-publication-scans.mjs');
    const tools = join(fixture, 'tools');
    await mkdir(join(tools, 'bandit/bin'), { recursive: true });
    const invoke = () =>
      spawnSync(process.execPath, [runner, 'bandit', '--tools', tools], {
        cwd: repo,
        encoding: 'utf8',
      });
    let result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing|ENOENT/i);
    const executable = join(tools, 'bandit/bin/bandit');
    await writeFile(
      executable,
      `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('bandit 1.9.4');\n`,
      { mode: 0o755 },
    );
    result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /report|ENOENT/i);
    await writeFile(
      executable,
      `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nif (process.argv.includes('--version')) console.log('bandit 1.9.4');\nelse writeFileSync(process.argv[process.argv.indexOf('-o') + 1], 'broken JSON');\n`,
    );
    result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /JSON|report/i);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
