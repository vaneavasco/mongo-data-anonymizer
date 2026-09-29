import { readFileSync } from 'node:fs';
import yargs from 'yargs';
import { DEFAULT_FIELDS, getFieldList } from './anonymization/rules.ts';
import type { RunConfig } from './run.ts';

const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

function parseCommitQuorum(value: string): number | string {
  if (/^\d+$/.test(value)) return Number(value);
  if (value === 'majority' || value === 'votingMembers') return value;
  throw new Error(
    `--indexCommitQuorum must be a number of members, "majority" or "votingMembers", got "${value}"`,
  );
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

const OPTIONS = [
  'sourceUri',
  'targetUri',
  'fieldList',
  'collectionList',
  'ignoreCollections',
  'copyNonAnonymized',
  'dropTarget',
  'dryRun',
  'strict',
  'assumeDifferentTarget',
  'scrubEmails',
  'sampleSize',
  'indexCommitQuorum',
  'indexTimeout',
  'batchSize',
  'secret',
];

/** `sourceUri` → `ANONYMIZER_SOURCE_URI`. */
function envName(option: string): string {
  return `ANONYMIZER_${option.replace(/([A-Z])/g, '_$1').toUpperCase()}`;
}

const BOOLEAN_OPTIONS = new Set([
  'copyNonAnonymized',
  'dropTarget',
  'dryRun',
  'strict',
  'assumeDifferentTarget',
  'scrubEmails',
]);

function envBoolean(name: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['', '0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be true or false, got "${value}"`);
}

/**
 * Options set through the environment, as arguments placed before the real
 * ones (so the command line wins). Only known variables are read: an
 * unrelated ANONYMIZER_* variable must not make the strict parser fail.
 */
function envArgs(env: NodeJS.ProcessEnv): string[] {
  return OPTIONS.flatMap((option) => {
    const name = envName(option);
    const value = env[name];
    if (value === undefined) return [];
    if (BOOLEAN_OPTIONS.has(option)) {
      return [envBoolean(name, value) ? `--${option}` : `--no-${option}`];
    }
    return [`--${option}=${value}`];
  });
}

/**
 * Parses command-line arguments. Every option can also be set through an
 * environment variable prefixed with ANONYMIZER_ (e.g. ANONYMIZER_SOURCE_URI,
 * ANONYMIZER_SECRET), which keeps credentials out of the shell history.
 */
export function parseArgs(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
): RunConfig {
  const argv = yargs([...envArgs(env), ...args])
    .scriptName('mongo-data-anonymizer')
    .usage('$0 --sourceUri <uri> --targetUri <uri> [options]')
    .parserConfiguration({ 'duplicate-arguments-array': false })
    .option('sourceUri', {
      type: 'string',
      demandOption: true,
      describe: 'Source MongoDB URI',
    })
    .option('targetUri', {
      type: 'string',
      demandOption: true,
      describe: 'Target MongoDB URI',
    })
    .option('fieldList', {
      type: 'string',
      describe: `Fields to anonymize: [collection.]field[:replacement]. Prefix items with + or - to adjust the defaults (${DEFAULT_FIELDS.join(', ')})`,
    })
    .option('collectionList', {
      type: 'string',
      describe: 'Only anonymize these collections',
    })
    .option('ignoreCollections', {
      type: 'string',
      describe: 'Never anonymize these collections',
    })
    .option('copyNonAnonymized', {
      type: 'boolean',
      default: false,
      describe:
        'Copy collections that are not anonymized as-is instead of skipping them',
    })
    .option('dropTarget', {
      type: 'boolean',
      default: false,
      describe: 'Drop target collections that already exist',
    })
    .option('dryRun', {
      type: 'boolean',
      default: false,
      describe: 'Show what would be done without writing anything',
    })
    .option('strict', {
      type: 'boolean',
      default: false,
      describe:
        'Fail instead of warning when a matched value cannot be anonymized (ObjectId, Binary, Decimal128, ...)',
    })
    .option('assumeDifferentTarget', {
      type: 'boolean',
      default: false,
      describe:
        'Allow a target that shares collection UUIDs or hosts with the source (e.g. a restored copy of it); writes are still checked not to reach the source',
    })
    .option('scrubEmails', {
      type: 'boolean',
      default: true,
      describe:
        'Replace email addresses found in any string, including free text (--no-scrubEmails to turn off)',
    })
    .option('sampleSize', {
      type: 'number',
      default: 1000,
      describe:
        'Documents per collection a dry run checks for unmatched personal data (0 = all)',
    })
    .option('indexCommitQuorum', {
      type: 'string',
      default: '1',
      describe:
        'Commit quorum for index builds on a replica set target: a number of members, "majority" or "votingMembers"',
    })
    .option('indexTimeout', {
      type: 'number',
      default: 900,
      describe:
        "Seconds to wait for a collection's indexes to build before skipping them with a warning (0 = no limit)",
    })
    .option('batchSize', {
      type: 'number',
      default: 1000,
      describe: 'Documents per batch',
    })
    .option('secret', {
      type: 'string',
      describe:
        'Secret for deterministic fake values (prefer ANONYMIZER_SECRET)',
    })
    .strict()
    .help()
    .version(version)
    .parseSync();

  return {
    sourceUri: argv.sourceUri,
    targetUri: argv.targetUri,
    fieldList: getFieldList(argv.fieldList),
    collectionList: list(argv.collectionList),
    ignoreCollections: list(argv.ignoreCollections),
    batchSize: argv.batchSize,
    copyNonAnonymized: argv.copyNonAnonymized,
    dropTarget: argv.dropTarget,
    dryRun: argv.dryRun,
    strict: argv.strict,
    assumeDifferentTarget: argv.assumeDifferentTarget,
    scrubEmails: argv.scrubEmails,
    sampleSize: argv.sampleSize,
    indexCommitQuorum: parseCommitQuorum(argv.indexCommitQuorum),
    indexTimeoutSeconds: argv.indexTimeout,
    ...(argv.secret ? { secret: argv.secret } : {}),
  };
}
