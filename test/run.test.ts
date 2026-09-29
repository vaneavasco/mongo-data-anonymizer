import { once } from 'node:events';
import { createServer, connect, type Server } from 'node:net';
import { MongoClient, Decimal128, type Db, type UUID } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Database } from '../src/anonymization/database.ts';
import { DEFAULT_FIELDS } from '../src/anonymization/rules.ts';
import { silentLogger } from '../src/logger.ts';
import { run, type RunConfig } from '../src/run.ts';

/** A TCP proxy to the test server: the same database behind another address. */
async function startProxy(port: number): Promise<Server> {
  const proxy = createServer((socket) => {
    const upstream = connect(port, '127.0.0.1');
    socket.pipe(upstream).pipe(socket);
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  return proxy;
}

let server: MongoMemoryServer;
let client: MongoClient;
let source: Db;
let target: Db;

function config(overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    sourceUri: server.getUri('source'),
    targetUri: server.getUri('target'),
    fieldList: DEFAULT_FIELDS,
    collectionList: [],
    ignoreCollections: [],
    batchSize: 2,
    copyNonAnonymized: false,
    dropTarget: false,
    dryRun: false,
    secret: 'test-secret',
    ...overrides,
  };
}

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
  source = client.db('source');
  target = client.db('target');
});

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

beforeEach(async () => {
  await source.dropDatabase();
  await target.dropDatabase();

  await source.collection('users').insertMany([
    {
      email: 'john@x.com',
      name: 'John',
      birthdate: new Date('1990-01-01'),
      age: 30,
    },
    {
      email: 'jane@x.com',
      name: 'Jane',
      birthdate: new Date('1991-01-01'),
      age: 31,
    },
    {
      email: 'bob@x.com',
      name: 'Bob',
      birthdate: new Date('1992-01-01'),
      age: 32,
    },
  ]);
  await source
    .collection('users')
    .createIndex({ email: 1 }, { unique: true, name: 'email_unique' });
  await source
    .collection('orders')
    .insertOne({ customer: { email: 'john@x.com' }, total: 10 });
  await source
    .collection('logs')
    .insertOne({ email: 'john@x.com', message: 'login' });
  await source.createCollection('userEmails', {
    viewOn: 'users',
    pipeline: [{ $project: { email: 1 } }],
  });
});

describe('run', () => {
  it('anonymizes every collection, keeping _id, types, indexes and views', async () => {
    const report = await run(config(), silentLogger);

    const sourceUsers = await source
      .collection('users')
      .find()
      .sort({ _id: 1 })
      .toArray();
    const targetUsers = await target
      .collection('users')
      .find()
      .sort({ _id: 1 })
      .toArray();

    expect(targetUsers).toHaveLength(3);
    targetUsers.forEach((user, i) => {
      expect(user._id).toEqual(sourceUsers[i]?._id);
      expect(user.email).not.toBe(sourceUsers[i]?.email);
      expect(user.birthdate).toBeInstanceOf(Date);
      expect(user.age).toBe(sourceUsers[i]?.age);
    });

    const indexes = await target.collection('users').indexes();
    expect(indexes.find((index) => index.name === 'email_unique')?.unique).toBe(
      true,
    );

    expect(await target.collection('userEmails').countDocuments()).toBe(3);
    expect(report.collections.map((c) => [c.name, c.action])).toEqual([
      ['logs', 'anonymize'],
      ['orders', 'anonymize'],
      ['userEmails', 'anonymize'],
      ['users', 'anonymize'],
    ]);
    expect(report.warnings).toEqual([]);
  });

  it('keeps references consistent across collections', async () => {
    await run(config(), silentLogger);

    const john = await target.collection('users').findOne({ age: 30 });
    const order = await target
      .collection<{ customer: { email: string } }>('orders')
      .findOne();
    expect(order?.customer.email).toBe(john?.email);
  });

  it('produces identical output on a rerun with the same secret', async () => {
    await run(config(), silentLogger);
    const first = await target
      .collection('users')
      .find()
      .sort({ _id: 1 })
      .toArray();

    await run(config({ dropTarget: true }), silentLogger);
    const second = await target
      .collection('users')
      .find()
      .sort({ _id: 1 })
      .toArray();

    expect(second).toEqual(first);
  });

  it('does not copy anything raw when --copyNonAnonymized is set without a collection list', async () => {
    await run(config({ copyNonAnonymized: true }), silentLogger);

    const log = await target.collection('logs').findOne();
    expect(log?.email).not.toBe('john@x.com');
  });

  it('copies unselected collections as-is only with --copyNonAnonymized', async () => {
    await run(config({ collectionList: ['users'] }), silentLogger);
    expect(await target.listCollections({ name: 'logs' }).toArray()).toEqual(
      [],
    );

    await run(
      config({
        collectionList: ['users'],
        copyNonAnonymized: true,
        dropTarget: true,
      }),
      silentLogger,
    );
    expect((await target.collection('logs').findOne())?.email).toBe(
      'john@x.com',
    );
  });

  it('refuses to overwrite an existing target collection without --dropTarget', async () => {
    await target.collection('users').insertOne({ stale: true });

    await expect(run(config(), silentLogger)).rejects.toThrow(/--dropTarget/);
    expect(await target.collection('users').countDocuments()).toBe(1);

    await run(config({ dropTarget: true }), silentLogger);
    expect(
      await target.collection('users').countDocuments({ stale: true }),
    ).toBe(0);
  });

  it('refuses to use the source as the target', async () => {
    const sameDb = server.getUri('source').replace('127.0.0.1', 'localhost');

    await expect(
      run(config({ targetUri: sameDb, dropTarget: true }), silentLogger),
    ).rejects.toThrow(/same database/);
    expect(await source.collection('users').countDocuments()).toBe(3);
  });

  it('writes nothing in a dry run', async () => {
    const report = await run(config({ dryRun: true }), silentLogger);

    expect(await target.listCollections().toArray()).toEqual([]);
    expect(report.collections.find((c) => c.name === 'users')?.documents).toBe(
      3,
    );
  });

  it('stops cleanly when the target rejects a batch (copied validator)', async () => {
    await source.createCollection('strict', {
      validator: {
        $jsonSchema: {
          properties: { email: { bsonType: 'string', pattern: '@x\\.com$' } },
        },
      },
    });
    await source
      .collection('strict')
      .insertMany(
        Array.from({ length: 200 }, (_, i) => ({ email: `user${i}@x.com` })),
      );

    await expect(
      run(config({ collectionList: ['strict'], batchSize: 1 }), silentLogger),
    ).rejects.toThrow(/Document failed validation/);
  });

  it('recreates capped and time series collections with their options', async () => {
    await source.createCollection('capped', { capped: true, size: 100_000 });
    await source.collection('capped').insertOne({ email: 'a@x.com' });
    await source.createCollection('metrics', {
      timeseries: { timeField: 'at', metaField: 'meta' },
    });
    await source
      .collection('metrics')
      .insertOne({ at: new Date(), meta: { email: 'a@x.com' }, value: 1 });

    await run(config({ collectionList: ['capped', 'metrics'] }), silentLogger);

    expect(await target.collection('capped').isCapped()).toBe(true);
    const [metrics] = await target
      .listCollections({ name: 'metrics' })
      .toArray();
    expect(metrics?.type).toBe('timeseries');
    const metric = await target
      .collection<{ meta: { email: string } }>('metrics')
      .findOne();
    expect(metric?.meta.email).toMatch(/@example\.com$/);
  });

  it('warns instead of failing when a unique index no longer holds', async () => {
    await source.collection('people').insertMany([
      { name: 'Same', city: 'Paris' },
      { name: 'Same', city: 'Rome' },
    ]);
    await source
      .collection('people')
      .createIndex({ name: 1, city: 1 }, { unique: true, name: 'name_city' });

    const report = await run(
      config({ collectionList: ['people'], fieldList: ['city:Nowhere'] }),
      silentLogger,
    );

    expect(await target.collection('people').countDocuments()).toBe(2);
    expect(report.warnings).toEqual([
      expect.stringMatching(/Could not create index name_city on people/),
    ]);
  });

  it('fails before writing when a replacement is invalid', async () => {
    await expect(
      run(config({ fieldList: ['email:faker.nope.nope'] }), silentLogger),
    ).rejects.toThrow(/Invalid faker category/);
    expect(await target.listCollections().toArray()).toEqual([]);
  });

  it('refuses a target that reaches the source through another address, even with --dropTarget', async () => {
    const proxy = await startProxy(server.instanceInfo!.port);
    const { port } = proxy.address() as { port: number };
    try {
      await expect(
        run(
          config({
            targetUri: `mongodb://127.0.0.1:${port}/source?directConnection=true`,
            dropTarget: true,
          }),
          silentLogger,
        ),
      ).rejects.toThrow(/same database/);
    } finally {
      proxy.close();
    }

    expect(await source.collection('users').countDocuments()).toBe(3);
  });

  it('detects the same database behind another address even when it has no collections', async () => {
    const proxy = await startProxy(server.instanceInfo!.port);
    const { port } = proxy.address() as { port: number };
    try {
      await expect(
        run(
          config({
            sourceUri: server.getUri('empty'),
            targetUri: `mongodb://127.0.0.1:${port}/empty?directConnection=true`,
          }),
          silentLogger,
        ),
      ).rejects.toThrow(/same database/);
    } finally {
      proxy.close();
    }
    expect(await client.db('empty').listCollections().toArray()).toEqual([]);
  });

  it('allows another database on the same server behind another address', async () => {
    const proxy = await startProxy(server.instanceInfo!.port);
    const { port } = proxy.address() as { port: number };
    try {
      await run(
        config({
          targetUri: `mongodb://127.0.0.1:${port}/target?directConnection=true`,
        }),
        silentLogger,
      );
    } finally {
      proxy.close();
    }

    expect(await target.collection('users').countDocuments()).toBe(3);
    expect(await source.collection('users').countDocuments()).toBe(3);
  });

  it('leaves no probe collection behind and warns about stale ones', async () => {
    await run(config(), silentLogger);
    expect(
      (await target.listCollections().toArray()).map(({ name }) => name),
    ).not.toContainEqual(expect.stringMatching(/^anonymizer_probe_/));

    await target.createCollection('anonymizer_probe_0123456789abcdef');
    const report = await run(config({ dropTarget: true }), silentLogger);
    expect(report.warnings).toContainEqual(
      expect.stringMatching(/probe collections left by an interrupted run/),
    );
  });

  it('refuses a restored copy of the source unless --assumeDifferentTarget is given', async () => {
    const other = await MongoMemoryServer.create();
    const otherClient = await MongoClient.connect(other.getUri());
    try {
      const [users] = (await source
        .listCollections({ name: 'users' })
        .toArray()) as unknown as { info: { uuid: UUID } }[];
      // What mongorestore --preserveUUID or a snapshot restore produces.
      await otherClient.db('admin').command({
        applyOps: [
          {
            op: 'c',
            ns: 'staging.$cmd',
            ui: users?.info.uuid,
            o: { create: 'users' },
          },
        ],
      });
      const restored = config({
        targetUri: other.getUri('staging'),
        dropTarget: true,
      });

      for (const dryRun of [false, true]) {
        await expect(
          run({ ...restored, dryRun }, silentLogger),
        ).rejects.toThrow(
          /shares collection UUIDs with the source \(source "source", target "staging"\)/,
        );
      }

      await run({ ...restored, assumeDifferentTarget: true }, silentLogger);
      expect(
        await otherClient.db('staging').collection('users').countDocuments(),
      ).toBe(3);
    } finally {
      await otherClient.close();
      await other.stop();
    }
  });

  it('still refuses the source itself with --assumeDifferentTarget', async () => {
    await expect(
      run(
        config({
          targetUri: server.getUri('source'),
          assumeDifferentTarget: true,
          dropTarget: true,
        }),
        silentLogger,
      ),
    ).rejects.toThrow(/Writes to the target reach the source/);
    expect(await source.collection('users').countDocuments()).toBe(3);
  });

  it('refuses URIs with an invalid database name', async () => {
    await expect(
      run(config({ targetUri: `${server.getUri()}db%` }), silentLogger),
    ).rejects.toThrow(/target URI has an invalid database name/);
  });

  it('refuses URIs without a database name', async () => {
    await expect(
      run(
        config({ targetUri: server.getUri().replace(/\/$/, '') }),
        silentLogger,
      ),
    ).rejects.toThrow(/target URI must name a database/);
  });

  it.each([
    [{ collectionList: ['user'] }, /--collectionList: user/],
    [{ ignoreCollections: ['log'] }, /--ignoreCollections: log/],
    [{ fieldList: ['user.email'] }, /--fieldList: user/],
  ])(
    'refuses unknown collection names (%j) before writing',
    async (overrides, error) => {
      await expect(
        run(config({ ...overrides, copyNonAnonymized: true }), silentLogger),
      ).rejects.toThrow(error);
      expect(await target.listCollections().toArray()).toEqual([]);
    },
  );

  it('does not count a view as an anonymized collection', async () => {
    await expect(
      run(
        config({ collectionList: ['userEmails'], copyNonAnonymized: true }),
        silentLogger,
      ),
    ).rejects.toThrow(/No collection would be anonymized/);
  });

  it('warns when every collection is skipped', async () => {
    const report = await run(
      config({ ignoreCollections: ['users', 'orders', 'logs', 'userEmails'] }),
      silentLogger,
    );
    expect(report.warnings).toContainEqual(
      expect.stringMatching(/Nothing to write/),
    );
  });

  it('refuses a run that would only copy data as-is', async () => {
    await expect(
      run(
        config({
          ignoreCollections: ['users', 'orders', 'logs', 'userEmails'],
          copyNonAnonymized: true,
        }),
        silentLogger,
      ),
    ).rejects.toThrow(/No collection would be anonymized/);
  });

  it('reports the number of documents written and leaves other target collections alone', async () => {
    await target.collection('unrelated').insertOne({ keep: true });
    await source
      .collection('big')
      .insertMany(
        Array.from({ length: 101 }, (_, i) => ({ i, email: `u${i}@x.com` })),
      );

    const report = await run(
      config({ batchSize: 7, dropTarget: true }),
      silentLogger,
    );

    expect(report.collections.find((c) => c.name === 'big')?.documents).toBe(
      101,
    );
    const copied = await target
      .collection<{ i: number }>('big')
      .find()
      .sort({ _id: 1 })
      .toArray();
    expect(copied.map((doc) => doc.i)).toEqual(
      Array.from({ length: 101 }, (_, i) => i),
    );
    expect(await target.collection('unrelated').countDocuments()).toBe(1);
  });

  it('recreates a custom clustered collection without spurious warnings', async () => {
    await source.createCollection('clustered', {
      clusteredIndex: { key: { _id: 1 }, unique: true, name: 'my_clustered' },
    });
    await source
      .collection('clustered')
      .insertOne({ _id: 1, email: 'a@x.com' } as never);

    const report = await run(
      config({ collectionList: ['clustered'] }),
      silentLogger,
    );

    expect(report.warnings).toEqual([]);
    const [info] = await target
      .listCollections({ name: 'clustered' })
      .toArray();
    expect(info).toMatchObject({
      options: { clusteredIndex: { name: 'my_clustered' } },
    });
  });

  it('points out unmatched personal-looking keys in a dry run', async () => {
    await source
      .collection('customers')
      .insertOne({ email: 'a@x.com', SSNNumber: '1', velocity: 3 });

    const report = await run(
      config({
        dryRun: true,
        ignoreCollections: ['logs'],
        copyNonAnonymized: true,
      }),
      silentLogger,
    );

    const byName = Object.fromEntries(
      report.collections.map((c) => [c.name, c.unmatchedPersonalKeys]),
    );
    expect(byName.customers).toEqual(['SSNNumber']);
    expect(byName.logs).toEqual(['email']);
    expect(report.warnings).toContainEqual(
      expect.stringMatching(/customers: .* SSNNumber/),
    );
  });

  it('fails in strict mode when a matched value cannot be anonymized', async () => {
    await source
      .collection('money')
      .insertOne({ name: Decimal128.fromString('1.5') });

    await expect(
      run(config({ collectionList: ['money'], strict: true }), silentLogger),
    ).rejects.toThrow(/--strict/);

    const report = await run(
      config({ collectionList: ['money'], dropTarget: true }),
      silentLogger,
    );
    expect(report.warnings).toContainEqual(
      expect.stringMatching(/unsupported type Decimal128/),
    );
  });

  it('cuts batches at 16 MB even below --batchSize', async () => {
    const big = 'x'.repeat(1024 * 1024);
    await source
      .collection('pages')
      .insertMany(Array.from({ length: 40 }, (_, i) => ({ i, html: big })));
    const insertMany = vi.spyOn(Database.prototype, 'insertMany');

    try {
      await run(
        config({ collectionList: ['pages'], batchSize: 1000 }),
        silentLogger,
      );
      const sizes = insertMany.mock.calls
        .filter(([name]) => name === 'pages')
        .map(([, documents]) => documents.length);

      expect(sizes.length).toBeGreaterThan(1);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(16);
      expect(sizes.reduce((a, b) => a + b, 0)).toBe(40);
    } finally {
      insertMany.mockRestore();
    }
  });

  it('names the collection being sampled when a dry run stalls', async () => {
    const sample = vi
      .spyOn(Database.prototype, 'sample')
      .mockImplementation(async function* () {
        await new Promise((resolve) => setTimeout(resolve, 400));
        yield { i: 1 };
      } as unknown as Database['sample']);

    try {
      const report = await run(
        config({
          dryRun: true,
          collectionList: ['users'],
          progress: { stallAfterMs: 150 },
        }),
        silentLogger,
      );

      expect(report.warnings).toContainEqual(
        expect.stringMatching(/No progress for \ds: sampling users/),
      );
    } finally {
      sample.mockRestore();
    }
  });

  it('gives per-index retries only what is left of the collection timeout', async () => {
    await source.collection('people').insertOne({ a: 1, b: 1, c: 1 });
    await source
      .collection('people')
      .createIndexes([{ key: { a: 1 } }, { key: { b: 1 } }, { key: { c: 1 } }]);

    const timeouts: (number | undefined)[] = [];
    const createIndexes = vi
      .spyOn(Database.prototype, 'createIndexes')
      .mockImplementation(async (_name, indexes, options) => {
        if (indexes.length > 1) throw new Error('some index failed');
        timeouts.push(options.timeoutMS);
        await new Promise((resolve) => setTimeout(resolve, 300));
      });

    try {
      const report = await run(
        config({ collectionList: ['people'], indexTimeoutSeconds: 0.5 }),
        silentLogger,
      );

      expect(timeouts).toHaveLength(2);
      expect(timeouts[0]).toBeLessThanOrEqual(500);
      expect(timeouts[1]).toBeLessThan(300);
      expect(report.warnings).toContainEqual(
        expect.stringMatching(/remaining indexes of people were skipped/),
      );
    } finally {
      createIndexes.mockRestore();
    }
  });

  it('keeps geo indexes buildable under a matched address', async () => {
    await source.collection('venues').insertMany(
      Array.from({ length: 50 }, (_, i) => ({
        address: {
          street: `${i} Main St`,
          location: { type: 'Point', coordinates: [26.1 + i / 100, 44.4] },
          coordinates: [123.7, 41.1 + i / 100],
          area: {
            type: 'Polygon',
            coordinates: [
              [
                [26, 44],
                [26.01, 44],
                [26.01, 44.01],
                [26, 44],
              ],
            ],
          },
        },
      })),
    );
    await source
      .collection('venues')
      .createIndexes([
        { key: { 'address.location': '2dsphere' } },
        { key: { 'address.coordinates': '2dsphere' } },
        { key: { 'address.area': '2dsphere' } },
      ]);

    const report = await run(
      config({ collectionList: ['venues'] }),
      silentLogger,
    );

    expect(report.warnings).toEqual([]);
    const names = (await target.collection('venues').indexes()).map(
      ({ name }) => name,
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'address.location_2dsphere',
        'address.coordinates_2dsphere',
        'address.area_2dsphere',
      ]),
    );
  });
});
