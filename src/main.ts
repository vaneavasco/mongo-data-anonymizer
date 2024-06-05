import { Database } from './anonymization/database';
import { Anonymize } from './anonymization/anonymize';

const log = require('bunyan').createLogger({ name: "Main" });

interface Config {
    sourceUri: string;
    targetUri: string;
    fieldList: string[];
    fakerLocale?: string;
    ignoreCollections: string[];
    collectionList: string[];
    batchSize: number;
}

export async function main() {
    const config: Config = parseArgs(process.argv);

    const sourceDb = new Database(config.sourceUri, 'source');
    const targetDb = new Database(config.targetUri, 'target');
    const anonymizer = new Anonymize();

    try {
        await sourceDb.connect();
        await targetDb.connect();

        const collections = await sourceDb.getCollections();

        for (const collectionName of collections) {
            if (config.ignoreCollections.includes(collectionName)) {
                log.info(`Ignoring collection: ${collectionName}`);
                continue;
            }

            if (config.collectionList.length > 0 && !config.collectionList.includes(collectionName)) {
                log.info(`Ignoring collection: ${collectionName}`);
                continue;
            }

            log.info(`Anonymizing collection: ${collectionName}`);
            const cursor = sourceDb.getCursor(collectionName);

            while (await cursor?.hasNext()) {
                const batch = await getBatch(cursor, config.batchSize);
                const anonymizedBatch = anonymizer.anonymizeBatch(batch, collectionName, config.fieldList);
                await targetDb.insertAnonymizedBatch(collectionName, anonymizedBatch);
            }
        }

        log.info("Anonymization process completed successfully!");
    } catch (error) {
        log.error(`An error occurred during the anonymization process: ${(error as Error).message}`);
    } finally {
        await sourceDb.close();
        await targetDb.close();
    }
}

function parseArgs(argv: string[]): Config {
    const yargs = require('yargs/yargs');
    const { hideBin } = require('yargs/helpers');
    const args = yargs(hideBin(argv))
        .option('sourceUri', { type: 'string', demandOption: true, alias: 's' })
        .option('targetUri', { type: 'string', demandOption: true, alias: 't' })
        .option('fieldList', { type: 'string', demandOption: true, alias: 'f', default: 'email,name,description,address,city,country,phone,comment,birthdate'})
        .option('fakerLocale', { type: 'string', alias: 'l', default: 'en'})
        .option('collectionList', { type: 'string', alias: 'c', default: '' })
        .option('ignoreCollections', { type: 'string', alias: 'i', default: '' })
        .option('batchSize', { type: 'number', alias: 'b', default: 1000 })
        .argv;

    return {
        sourceUri: args.sourceUri,
        targetUri: args.targetUri,
        fieldList: args.fieldList.split(','),
        fakerLocale: args.fakerLocale,
        ignoreCollections: args.ignoreCollections.split(','),
        collectionList: args.collectionList.split(','),
        batchSize: args.batchSize,
    };
}

async function getBatch(cursor: any, batchSize: number) {
    const batch = [];
    for (let i = 0; i < batchSize && await cursor.hasNext(); i++) {
        batch.push(await cursor.next());
    }
    return batch;
}
