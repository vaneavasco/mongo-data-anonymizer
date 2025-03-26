import { config as loadEnvConfig } from 'dotenv';
import { z } from 'zod';
import yargs from 'yargs';

loadEnvConfig();
export const ConfigSchema = z.object({
  database: z.string().min(1, { message: 'Database name cannot be empty' }),
  olderThan: z
    .number()
    .int()
    .min(0, { message: 'Older than (in days) must be a non-negative integer' }),
  fieldList: z.string().transform((fields) => fields.split(',')),
  ignoreCollections: z.string().transform((fields) => fields.split(',')),
  collectionList: z.string().transform((fields) => fields.split(',')),
  batchSize: z
    .number()
    .int()
    .positive({ message: 'Batch size must be a positive integer' }),
  copyNonAnonymized: z.boolean(),
});

export type Config = z.infer<typeof ConfigSchema>;

const yargOptions = {
  database: { type: 'string', demandOption: false },
  olderThan: { type: 'number', default: 14 },
  fieldList: { type: 'string', demandOption: false },
  collectionList: { type: 'string' },
  ignoreCollections: { type: 'string' },
  batchSize: { type: 'number', default: 1000 },
  copyNonAnonymized: { type: 'boolean', default: false },
};

const validKeys: (keyof typeof yargOptions)[] = [
  'database',
  'olderThan',
  'fieldList',
  'ignoreCollections',
  'collectionList',
  'batchSize',
  'copyNonAnonymized',
];

export function parseArgs(): Required<Config> {
  // @ts-expect-error lol
  const args = yargs(process.argv.slice(2)).options(yargOptions).parse();

  // @ts-expect-error lol
  const envArgs = yargs(process.env).options(yargOptions).parse();

  // merge the args
  // @ts-expect-error lol
  let config = Object.assign({}, envArgs, args) as Config;

  config = validKeys.reduce((prev, curr) => {
    // @ts-expect-error lol
    prev[curr] = config[curr];
    return prev;
  }, {} as Config);

  config = ConfigSchema.parse(config);
  return config;
}
