import { Database } from './anonymization/database';
import { Anonymize } from './anonymization/anonymize';
import { getFieldList } from './utils/field-utils';

const log = require('bunyan').createLogger({ name: 'Main' });

interface Config {
  database: string;
  olderThan: number; // in days
  fieldList: string[];
  ignoreCollections: string[];
  collectionList: string[];
  batchSize: number;
  copyNonAnonymized: boolean;
}

const defaultFields = [
  'email',
  'name',
  'description',
  'address',
  'city',
  'country',
  'phone',
  'comment',
  'birthdate',
  'firstname',
  'lastname',
  'fullname',
];

export async function main() {
  const config: Config = parseArgs(process.argv);

  const db = new Database(config.database, 'source');
  const anonymizer = new Anonymize();

  try {
    await db.connect();

    const collections = await db.getCollections();

    for (const collectionName of collections) {
      const copyNonAnonymized =
        config.copyNonAnonymized &&
        (!config.collectionList.includes(collectionName) ||
          config.ignoreCollections.includes(collectionName));

      if (
        config.ignoreCollections.includes(collectionName) &&
        !config.copyNonAnonymized
      ) {
        log.info(
          `Skipping collection anonymization for ${collectionName}. Collection is in ignore list.`,
        );
        continue;
      }

      if (
        config.collectionList.length > 0 &&
        !config.collectionList.includes(collectionName) &&
        !config.copyNonAnonymized
      ) {
        log.info(
          `Skipping collection anonymization for ${collectionName}. Collection is not in the collection list.`,
        );
        continue;
      }

      if (!copyNonAnonymized) {
        log.info(`Anonymizing collection ${collectionName}.`);
      } else {
        log.info(`Copying collection ${collectionName} without anonymization.`);
      }

      const cursor = db.getCursor(collectionName, 14);

      while (await cursor?.hasNext()) {
        const batch = await getBatch(cursor, config.batchSize);
        const anonymizedBatch = !copyNonAnonymized
          ? anonymizer.anonymizeBatch(batch, config.fieldList)
          : batch;
        await db.replaceAnonymizedBatch(collectionName, anonymizedBatch);
      }
    }

    log.info('Anonymization process completed successfully!');
  } catch (error) {
    log.error(
      `An error occurred during the anonymization process: ${
        (error as Error).message
      }`,
    );
  } finally {
    await db.close();
  }
}

function parseArgs(argv: string[]): Config {
  const yargs = require('yargs/yargs');
  const { hideBin } = require('yargs/helpers');
  const args = yargs(hideBin(argv))
    .option('database', { type: 'string', demandOption: true })
    .option('olderThan', { type: 'number', default: 14 })
    .option('fieldList', {
      type: 'string',
      demandOption: true,
      default: defaultFields.join(','),
    })
    .option('collectionList', { type: 'string' })
    .option('ignoreCollections', { type: 'string' })
    .option('batchSize', { type: 'number', default: 1000 })
    .option('copyNonAnonymized', { type: 'boolean', default: false }).argv;

  return {
    database: args.database,
    olderThan: args.olderThan,
    fieldList: getFieldList(args.fieldList, defaultFields),
    ignoreCollections: args.ignoreCollections?.split(',') || [],
    collectionList: args.collectionList?.split(',') || [],
    batchSize: args.batchSize,
    copyNonAnonymized: args.copyNonAnonymized,
  };
}

async function getBatch(cursor: any, batchSize: number) {
  const batch = [];
  for (let i = 0; i < batchSize && (await cursor.hasNext()); i++) {
    batch.push(await cursor.next());
  }
  return batch;
}
