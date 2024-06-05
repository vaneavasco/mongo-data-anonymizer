import { MongoClient, Db } from 'mongodb';
import * as bunyan from 'bunyan';

const log = bunyan.createLogger({ name: "DatabaseHandler" });

export class Database {
    private client: MongoClient | null = null;
    private db: Db | null = null;

    constructor(private uri: string, private name: string) {}

    async connect() {
        try {
            log.info(`Connecting to ${this.name} database...`);
            this.client = new MongoClient(this.uri);
            await this.client.connect();
            this.db = this.client.db();
            log.info(`Successfully connected to ${this.name} database`);
        } catch (error) {
            throw new Error(`Failed to connect to ${this.name} database: ${(error as Error).message}`);
        }
    }

    async close() {
        await this?.client?.close();
        log.info(`Closed database connection`);
    }

    async getCollections(): Promise<string[]> {
        const collections = await this?.db?.listCollections().toArray();
        return collections ? collections.map((item) => item.name) : [];
    }

    getCursor(collectionName: string) {
        return this.db ? this.db.collection(collectionName).find() : null;
    }

    async insertAnonymizedBatch(collectionName: string, anonymizedBatch: any[]) {
        if (this.db) {
            await this.db.collection(collectionName).insertMany(anonymizedBatch);
        }
    }

    async dropCollectionIfExists(collectionName: string) {
        if (this.db && await this.db.collection(collectionName).countDocuments() > 0) {
            await this.db.collection(collectionName).drop();
            log.info(`Dropped existing collection: ${collectionName}`);
        }
    }
}
