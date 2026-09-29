import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_FIELDS } from '../src/anonymization/rules.ts';
import { silentLogger } from '../src/logger.ts';
import { run, type RunConfig } from '../src/run.ts';

// A replica set whose secondary is down: index builds that wait for every
// voting member never finish (what a stuck secondary does in practice).
let replSet: MongoMemoryReplSet;
let client: MongoClient;
let primary: (db: string) => string;

beforeAll(async () => {
  replSet = await MongoMemoryReplSet.create({
    replSet: { count: 3, storageEngine: 'wiredTiger' },
  });
  client = await MongoClient.connect(replSet.getUri());
  await client
    .db('source')
    .collection('users')
    .insertMany(
      Array.from({ length: 50 }, (_, i) => ({ email: `u${i}@x.com`, n: i })),
    );
  await client
    .db('source')
    .collection('users')
    .createIndexes([{ key: { n: 1 } }, { key: { email: 1 }, unique: true }]);

  const hello = await client.db('admin').command({ hello: 1 });
  const port = String(hello.primary).split(':').pop();
  primary = (db) => `mongodb://127.0.0.1:${port}/${db}?directConnection=true`;

  const secondary = replSet.servers.find(
    (server) => String(server.instanceInfo?.port) !== port,
  );
  await secondary?.stop({ doCleanup: false, force: true });
});

afterAll(async () => {
  await client?.close();
  await replSet?.stop();
});

function config(overrides: Partial<RunConfig>): RunConfig {
  return {
    sourceUri: primary('source'),
    targetUri: primary('target'),
    fieldList: DEFAULT_FIELDS,
    collectionList: [],
    ignoreCollections: [],
    batchSize: 10,
    copyNonAnonymized: false,
    dropTarget: true,
    dryRun: false,
    secret: 's',
    ...overrides,
  };
}

describe('run on a replica set with an unavailable secondary', () => {
  it('builds indexes without waiting for the secondary (commit quorum 1)', async () => {
    const started = Date.now();
    const report = await run(config({}), silentLogger);

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(report.warnings).toEqual([]);
    const indexes = await client.db('target').collection('users').indexes();
    expect(indexes.map(({ name }) => name).sort()).toEqual([
      '_id_',
      'email_1',
      'n_1',
    ]);
  });

  it('warns about the stall and skips the indexes after the timeout', async () => {
    const report = await run(
      config({
        indexCommitQuorum: 'votingMembers',
        indexTimeoutSeconds: 3,
        progress: { stallAfterMs: 1_000 },
      }),
      silentLogger,
    );

    expect(report.warnings).toContainEqual(
      expect.stringMatching(
        /No progress for \ds: createIndexes on users .*commit quorum/,
      ),
    );
    expect(report.warnings).toContainEqual(
      expect.stringMatching(
        /Indexes on users did not finish building within 3s and were skipped: n_1, email_1/,
      ),
    );
    expect(await client.db('target').collection('users').countDocuments()).toBe(
      50,
    );
    // The server aborted the build instead of leaving it waiting.
    const pending = await client
      .db('admin')
      .aggregate([
        { $currentOp: { allUsers: true } },
        { $match: { 'command.createIndexes': 'users' } },
      ])
      .toArray();
    expect(pending).toEqual([]);
  });
});
