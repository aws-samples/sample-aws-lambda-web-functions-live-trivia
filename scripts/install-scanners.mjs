import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { scannerEnvironment } from './scanner-environment.mjs';

const root = resolve(import.meta.dirname, '..');

function execute(executable, args, environment) {
  const result = spawnSync(executable, args, {
    env: environment,
    stdio: 'inherit',
    timeout: 15 * 60 * 1000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed with status ${result.status}`);
}

async function install() {
  const args = process.argv.slice(2);
  let destination;
  let python = 'python3';
  while (args.length) {
    const argument = args.shift();
    if (argument === '--destination' && args.length) destination = resolve(args.shift());
    else if (argument === '--python' && args.length) python = args.shift();
    else throw new Error(`Unknown/missing installation argument: ${argument}`);
  }
  if (!destination) throw new Error('Supply --destination DIRECTORY outside the repository');
  await mkdir(destination, { recursive: true });
  destination = await realpath(destination);
  const repository = await realpath(root);
  if (destination === repository || destination.startsWith(`${repository}${sep}`))
    throw new Error('Install scanners outside the repository');
  if ((await readdir(destination)).length)
    throw new Error('Choose an empty scanner installation directory');
  const manifest = JSON.parse(await readFile(join(root, 'scripts/scanners/versions.json'), 'utf8'));
  const workspace = await mkdtemp(join(tmpdir(), 'serverlessq-tool-install-'));
  const environment = scannerEnvironment(workspace);
  try {
    execute(
      python,
      [
        '-c',
        `import sys; sys.exit(0 if sys.version_info[:2] == (3, 12) else "Python ${manifest.python} is required")`,
      ],
      environment,
    );
    await mkdir(join(destination, 'bin'), { recursive: true });
    for (const [tool, settings] of Object.entries(manifest.tools)) {
      if (settings.requirements) {
        const venv = join(destination, tool);
        execute(python, ['-m', 'venv', venv], environment);
        execute(
          join(venv, 'bin/python'),
          [
            '-m',
            'pip',
            '--isolated',
            'install',
            '--disable-pip-version-check',
            '--no-input',
            '--index-url',
            'https://pypi.org/simple',
            '--require-hashes',
            '--only-binary=:all:',
            '-r',
            join(root, 'scripts/scanners', settings.requirements),
          ],
          environment,
        );
      } else {
        const asset = settings.archives[`${process.platform}-${process.arch}`];
        if (!asset || !/^[a-f0-9]{64}$/.test(asset.sha256))
          throw new Error(`No pinned ${tool} archive for this platform`);
        const download = spawnSync(
          'curl',
          [
            '--disable',
            '--fail',
            '--silent',
            '--show-error',
            '--location',
            '--proto',
            '=https',
            '--proto-redir',
            '=https',
            '--retry',
            '2',
            '--max-time',
            '120',
            asset.url,
          ],
          { env: environment, maxBuffer: 128 * 1024 * 1024, timeout: 5 * 60 * 1000 },
        );
        if (download.error) throw download.error;
        if (download.status !== 0)
          throw new Error(`${tool} archive download failed: ${download.stderr}`);
        const content = download.stdout;
        if (createHash('sha256').update(content).digest('hex') !== asset.sha256)
          throw new Error(`${tool} archive checksum mismatch`);
        const archive = join(workspace, `${tool}.tar.gz`);
        await writeFile(archive, content);
        // Extract only the expected executable, never archive-relative paths.
        const binary = spawnSync('tar', ['-xOf', archive, asset.member], {
          env: environment,
          maxBuffer: 128 * 1024 * 1024,
        });
        if (binary.error) throw binary.error;
        if (binary.status !== 0 || !binary.stdout.length)
          throw new Error(`Cannot extract pinned ${tool} executable`);
        const target = join(destination, 'bin', tool);
        await writeFile(target, binary.stdout);
        await chmod(target, 0o755);
      }
    }
    console.log(`Installed isolated scanners in ${destination}`);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

install().catch((error) => {
  console.error(`FAIL: ${error.message}`);
  process.exitCode = 1;
});
