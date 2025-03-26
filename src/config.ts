import { config as loadEnvConfig } from 'dotenv';
import { z } from 'zod';
import { getFieldList } from './utils/field-utils';

loadEnvConfig();
interface Config {
  database: string;
  olderThan: number; // in days
  fieldList: string[];
  ignoreCollections: string[];
  collectionList: string[];
  batchSize: number;
  copyNonAnonymized: boolean;
}

export function parseArgs(argv: string[]): Config {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const yargs = require('yargs/yargs');

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { hideBin } = require('yargs/helpers');

  const args = yargs(hideBin(argv))
    .option('database', { type: 'string', demandOption: true })
    .option('olderThan', { type: 'number', default: 14 })
    .option('fieldList', {
      type: 'string',
      demandOption: true,
    })
    .option('collectionList', { type: 'string' })
    .option('ignoreCollections', { type: 'string' })
    .option('batchSize', { type: 'number', default: 1000 })
    .option('copyNonAnonymized', { type: 'boolean', default: false }).argv;

  return {
    database: args.database,
    olderThan: args.olderThan,
    fieldList: getFieldList(args.fieldList, []),
    ignoreCollections: args.ignoreCollections?.split(',') || [],
    collectionList: args.collectionList?.split(',') || [],
    batchSize: args.batchSize,
    copyNonAnonymized: args.copyNonAnonymized,
  };
}
