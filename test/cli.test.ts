import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

function cli(...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--no-warnings',
      new URL('../src/cli.ts', import.meta.url).pathname,
      ...args,
    ],
    { encoding: 'utf8', env: {}, timeout: 30_000 },
  );
}

describe('cli', () => {
  it('prints the package version', () => {
    const result = cli('--version');

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(version);
  });

  it('exits with 1 when a required option is missing', () => {
    const result = cli('--sourceUri', 'mongodb://127.0.0.1/a');

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Missing required argument: targetUri/);
  });

  it('exits with 1 and logs the error when the run fails', () => {
    const result = cli(
      '--sourceUri',
      'mongodb://127.0.0.1:1/a?serverSelectionTimeoutMS=500',
      '--targetUri',
      'mongodb://127.0.0.1:1/b?serverSelectionTimeoutMS=500',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/ERROR Failed to connect to source database/);
  });

  it('exits with 1 when a URI names no database', () => {
    const result = cli(
      '--sourceUri',
      'mongodb://127.0.0.1:1',
      '--targetUri',
      'mongodb://127.0.0.1:1/b',
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/source URI must name a database/);
  });
});
