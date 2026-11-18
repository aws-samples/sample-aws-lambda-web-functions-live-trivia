import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { scannerEnvironment } from './scanner-environment.mjs';
import { validateReport } from './scanner-reports.mjs';
import {
  validateBanditSourceExceptions,
  validateCheckovExceptionPolicy,
} from './scanner-policy.mjs';

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: 15 * 60 * 1000,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function git(root, args) {
  const result = command('git', args, { cwd: root });
  if (result.status !== 0) throw new Error(`Git failed: ${result.stderr}`);
  return result.stdout;
}

/** Index contents give all publication checks the same staged source tree. */
export async function trackedSnapshot(root, directory) {
  const entries = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean);
  if (!entries.length) throw new Error('Empty tracked publication tree');
  const files = [];
  for (const entry of entries) {
    const [metadata, file] = [
      entry.slice(0, entry.indexOf('\t')),
      entry.slice(entry.indexOf('\t') + 1),
    ];
    const [mode, object, stage] = metadata.split(' ');
    if (!['100644', '100755'].includes(mode) || stage !== '0') {
      throw new Error(`Unsupported/unmerged publication file: ${file}`);
    }
    if (
      !file ||
      file.startsWith('/') ||
      file.split('/').some((part) => !part || part === '.' || part === '..')
    ) {
      throw new Error('Invalid tracked publication path');
    }
    const content = command('git', ['cat-file', 'blob', object], { cwd: root, encoding: null });
    if (content.status !== 0) throw new Error(`Cannot read indexed file: ${file}`);
    const target = join(directory, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content.stdout, { mode: mode === '100755' ? 0o755 : 0o644 });
    files.push(file);
  }
  return { directory, files };
}

function requireInputs(files, expression, label) {
  const inputs = files.filter((file) => expression.test(file));
  if (!inputs.length) throw new Error(`Empty ${label} scan input set`);
  return inputs;
}

async function run(root, mode, tools, online) {
  const supported = ['local', 'all', 'tree', 'history', 'semgrep', 'bandit', 'checkov', 'links'];
  if (!supported.includes(mode)) throw new Error(`Expected one of: ${supported.join(', ')}`);
  if (mode === 'all' && !online) throw new Error('The complete publication gate requires --online');
  const workspace = await mkdtemp(join(tmpdir(), 'serverlessq-scans-'));
  console.log(`Scanner reports: ${workspace}`);
  const environment = scannerEnvironment(join(workspace, 'home'));
  await mkdir(environment.HOME);
  const snapshot = await trackedSnapshot(root, join(workspace, 'source'));
  const { directory, files } = snapshot;
  const manifest = JSON.parse(
    await readFile(join(directory, 'scripts/scanners/versions.json'), 'utf8'),
  );
  const modes =
    mode === 'all'
      ? ['tree', 'history', 'semgrep', 'bandit', 'checkov', 'links']
      : mode === 'local'
        ? ['tree', 'semgrep', 'bandit', 'checkov', 'links']
        : [mode];
  async function scanner(tool, args, report, cwd = directory, extraEnvironment = {}) {
    const executable = join(
      tools,
      ['bandit', 'semgrep', 'checkov'].includes(tool) ? `${tool}/bin/${tool}` : `bin/${tool}`,
    );
    const toolEnvironment = {
      ...environment,
      ...(tool === 'semgrep'
        ? { SSL_CERT_FILE: join(tools, 'semgrep/lib/python3.12/site-packages/certifi/cacert.pem') }
        : {}),
      ...extraEnvironment,
    };
    const version = command(executable, ['--version'], {
      cwd,
      env: toolEnvironment,
      timeout: 120000,
    });
    if (
      version.status !== 0 ||
      !`${version.stdout}\n${version.stderr}`.match(
        new RegExp(`(^|[^\\d.])${manifest.tools[tool].version.replaceAll('.', '\\.')}([^\\d.]|$)`),
      )
    )
      throw new Error(`Missing/wrong ${tool} version; install the tracked scanner versions`);
    const result = command(executable, args, { cwd, env: toolEnvironment });
    if (result.stderr) process.stderr.write(result.stderr);
    const data = JSON.parse(await readFile(report, 'utf8'));
    return { result, data };
  }
  try {
    for (const selected of modes) {
      const tool = ['tree', 'history'].includes(selected)
        ? 'gitleaks'
        : selected === 'links'
          ? 'lychee'
          : selected;
      const report = join(workspace, `${selected}.json`);
      let args;
      let cwd = directory;
      let extraEnvironment = {};
      let exceptions = [];
      let expectedFiles = [];
      if (tool === 'gitleaks') {
        if (selected === 'history') {
          if (git(root, ['rev-parse', '--is-shallow-repository']).trim() !== 'false')
            throw new Error('Publication history scan requires a full checkout');
          if (Number(git(root, ['rev-list', '--all', '--count']).trim()) <= 0)
            throw new Error('Empty publication history');
          cwd = root;
        }
        args = [
          selected === 'tree' ? 'dir' : 'git',
          '--no-banner',
          '--redact=100',
          '--exit-code=1',
          '--report-format=json',
          `--report-path=${report}`,
          ...(selected === 'history' ? ['--log-opts=--all'] : []),
          '.',
        ];
      } else if (tool === 'semgrep') {
        expectedFiles = requireInputs(files, /\.(?:m?js|jsx|ts|tsx)$/, 'JavaScript/TypeScript');
        const rules = await readFile(join(directory, '.semgrep/security.yml'), 'utf8');
        if (!/^\s+- id:/m.test(rules)) throw new Error('Missing/empty tracked Semgrep ruleset');
        args = [
          'scan',
          '--config',
          '.semgrep/security.yml',
          '--error',
          '--strict',
          '--metrics=off',
          '--disable-version-check',
          '--disable-nosem',
          '--no-git-ignore',
          '--no-rewrite-rule-ids',
          '--max-target-bytes',
          '0',
          '--json',
          '--output',
          report,
          ...expectedFiles,
        ];
      } else if (tool === 'bandit') {
        const pythonFiles = requireInputs(files, /\.py$/, 'Python');
        exceptions = JSON.parse(
          await readFile(join(directory, 'scripts/scanners/bandit-exceptions.json'), 'utf8'),
        );
        const sources = await Promise.all(
          pythonFiles.map(async (file) => ({
            file,
            content: await readFile(join(directory, file), 'utf8'),
          })),
        );
        validateBanditSourceExceptions(sources, exceptions);
        args = [
          '-r',
          '.',
          '--severity-level',
          'all',
          '--confidence-level',
          'all',
          '-f',
          'json',
          '-o',
          report,
        ];
      } else if (tool === 'checkov') {
        requireInputs(files, /^infra\/terraform\/.+\.tf$/, 'Terraform');
        exceptions = JSON.parse(
          await readFile(join(directory, 'scripts/scanners/checkov-exceptions.json'), 'utf8'),
        );
        if (!Array.isArray(exceptions)) throw new Error('Invalid Checkov exception manifest');
        validateCheckovExceptionPolicy(exceptions);
        args = [
          '--directory',
          'infra/terraform',
          '--framework',
          'terraform',
          '--download-external-modules',
          'false',
          '--skip-download',
          '--skip-results-upload',
          '--output',
          'json',
          '--output-file-path',
          workspace,
        ];
        extraEnvironment = { CKV_PARSE_ERROR_FAIL: 'true' };
      } else {
        const documents = requireInputs(files, /\.(?:md|html)$/, 'documentation');
        await readFile(join(directory, '.lychee.toml'), 'utf8');
        // Vite serves public/logo.svg at /logo.svg. Check that exact source
        // asset while resolving the rest of the web document's absolute links.
        const logo = pathToFileURL(join(directory, 'packages/web/logo.svg')).href.replace(
          /[.*+?^${}()|[\]\\]/g,
          '\\$&',
        );
        const logoSource = pathToFileURL(join(directory, 'packages/web/public/logo.svg')).href;
        args = [
          '--config',
          '.lychee.toml',
          '--root-dir',
          join(directory, 'packages/web'),
          '--remap',
          `^${logo}$ ${logoSource}`,
          '--format',
          'json',
          '--output',
          report,
          ...(online ? [] : ['--offline']),
          '--',
          ...documents,
        ];
      }
      // Checkov names its JSON report itself.
      const actualReport = tool === 'checkov' ? join(workspace, 'results_json.json') : report;
      const { result, data } = await scanner(tool, args, actualReport, cwd, extraEnvironment);
      validateReport(tool, data, result.status, exceptions, expectedFiles, {
        offlineExternalExclusions: tool === 'lychee' && !online,
      });
      console.log(`PASS: ${selected}`);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(environment.HOME, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const args = process.argv.slice(2);
  const mode = args.shift();
  let tools;
  let online = false;
  try {
    while (args.length) {
      const argument = args.shift();
      if (argument === '--tools' && args.length) tools = resolve(args.shift());
      else if (argument === '--online') online = true;
      else if (argument === '--offline') online = false;
      else throw new Error(`Unknown/missing scanner argument: ${argument}`);
    }
    if (!tools)
      throw new Error('Missing --tools DIRECTORY; run scripts/install-scanners.mjs first');
    const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
    await run(root, mode, tools, online);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
