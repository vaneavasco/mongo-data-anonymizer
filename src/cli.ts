#!/usr/bin/env node
import { hideBin } from 'yargs/helpers';
import { parseArgs } from './config.ts';
import { consoleLogger } from './logger.ts';
import { run } from './run.ts';

try {
  await run(parseArgs(hideBin(process.argv)), consoleLogger);
} catch (error) {
  consoleLogger.error((error as Error).message);
  process.exitCode = 1;
}
