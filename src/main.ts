import { config as loadEnvConfig } from 'dotenv';

import { Database } from './anonymization/database';
import { Anonymize } from './anonymization/anonymize';
import { parseArgs } from './config';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const log = require('bunyan').createLogger({ name: 'Main' });
loadEnvConfig();

export async function main() {
  const config = parseArgs(process.argv);

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

async function getBatch(cursor: any, batchSize: number) {
  const batch = [];
  for (let i = 0; i < batchSize && (await cursor.hasNext()); i++) {
    batch.push(await cursor.next());
  }
  return batch;
}
