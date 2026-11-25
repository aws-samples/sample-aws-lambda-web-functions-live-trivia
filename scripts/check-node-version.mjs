import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function checkNodeVersion(version = process.versions.node) {
  const major = Number(version.split('.')[0]);

  if (!Number.isInteger(major) || major < 24) {
    throw new Error(
      `Node.js 24 or newer is required (detected ${version}). Run "nvm install 24" and "nvm use 24".`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    checkNodeVersion();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
