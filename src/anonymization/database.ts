import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MongoClient,
  type CreateIndexesOptions,
  type Db,
  type Document,
  type FindCursor,
  type IndexDescription,
} from 'mongodb';

export interface CollectionInfo {
  name: string;
  /** `collection`, `view` or `timeseries`. */
  type: string;
  options: Document;
  /** Collection UUID (hex); views have none. */
  uuid?: string;
}

/** Prefix of the short-lived collections `writesReachSource` creates. */
export const PROBE_PREFIX = 'anonymizer_probe_';

/**
 * The database named in a MongoDB URI, e.g. `app` in
 * `mongodb://user:pass@host:27017/app?authSource=admin`. Throws when the URI
 * names none (the driver would then silently use `test`) or an invalid one.
 */
export function databaseNameFromUri(uri: string, label: string): string {
  const rest = uri.replace(/^mongodb(\+srv)?:\/\//i, '');
  const slash = rest.indexOf('/');
  const raw = slash === -1 ? '' : (rest.slice(slash + 1).split('?')[0] ?? '');

  let name: string;
  try {
    name = decodeURIComponent(raw);
  } catch {
    throw new Error(`The ${label} URI has an invalid database name "${raw}"`);
  }
  if (!name) {
    throw new Error(
      `The ${label} URI must name a database, e.g. mongodb://host:27017/mydb`,
    );
  }
  if (/[/\\. "$*<>:|?]/.test(name)) {
    throw new Error(`The ${label} URI has an invalid database name "${name}"`);
  }
  return name;
}

const LOOPBACK_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '0.0.0.0',
]);

export class Database {
  readonly label: string;
  readonly #client: MongoClient;
  #db: Db | null = null;

  constructor(uri: string, label: string) {
    this.label = label;
    databaseNameFromUri(uri, label);
    this.#client = new MongoClient(uri);
  }

  get db(): Db {
    if (!this.#db) {
      throw new Error(`The ${this.label} database is not connected`);
    }
    return this.#db;
  }

  get name(): string {
    return this.db.databaseName;
  }

  async connect(): Promise<void> {
    try {
      await this.#client.connect();
      this.#db = this.#client.db();
    } catch (error) {
      throw new Error(
        `Failed to connect to ${this.label} database: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }

  async close(): Promise<void> {
    await this.#client.close();
  }

  /** User collections, views and time series collections; `system.*` and probes are left out. */
  async listCollections(): Promise<CollectionInfo[]> {
    const collections = await this.db.listCollections().toArray();
    return collections
      .filter(
        (info) =>
          !info.name.startsWith('system.') &&
          !info.name.startsWith(PROBE_PREFIX),
      )
      .map((info) => {
        const { options, info: details } = info as {
          options?: Document;
          info?: { uuid?: { toHexString(): string } };
        };
        return {
          name: info.name,
          type: info.type ?? 'collection',
          options: options ?? {},
          uuid: details?.uuid?.toHexString(),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Probe collections left behind by an interrupted run. */
  async listProbes(): Promise<string[]> {
    const probes = await this.db
      .listCollections(
        { name: { $regex: `^${PROBE_PREFIX}` } },
        { nameOnly: true },
      )
      .toArray();
    return probes.map(({ name }) => name);
  }

  /** False when connected directly to a secondary, which may lag behind. */
  async isWritablePrimary(): Promise<boolean> {
    try {
      const hello = await this.db.admin().command({ hello: 1 });
      return hello.isWritablePrimary !== false;
    } catch {
      return true;
    }
  }

  /** Reads from the primary, so a collection created a moment ago is seen. */
  async collectionExists(name: string): Promise<boolean> {
    const found = await this.db
      .listCollections({ name }, { nameOnly: true, readPreference: 'primary' })
      .toArray();
    return found.length > 0;
  }

  async dropCollection(name: string): Promise<void> {
    await this.db.collection(name).drop();
  }

  async createCollection(name: string, options: Document): Promise<void> {
    await this.db.createCollection(name, options);
  }

  find(name: string, batchSize: number): FindCursor<Document> {
    return this.db.collection(name).find({}, { batchSize });
  }

  /** The first `size` documents in natural order (cheap, unlike `$sample`); 0 means all. */
  sample(name: string, size: number): FindCursor<Document> {
    return this.db.collection(name).find({}, { limit: size });
  }

  async estimatedCount(name: string): Promise<number> {
    return this.db.collection(name).estimatedDocumentCount();
  }

  async insertMany(name: string, documents: Document[]): Promise<void> {
    if (documents.length > 0) {
      await this.db.collection(name).insertMany(documents, { ordered: true });
    }
  }

  /**
   * Index specs, without the `_id` and clustered indexes (created with the
   * collection) and without the server-populated fields that `createIndexes`
   * rejects.
   */
  async listIndexes(name: string): Promise<IndexDescription[]> {
    const indexes = await this.db.collection(name).listIndexes().toArray();
    return indexes
      .filter(
        (index: Document) => index.name !== '_id_' && index.clustered !== true,
      )
      .map(({ v: _v, ns: _ns, ...spec }) => spec as IndexDescription);
  }

  async createIndexes(
    name: string,
    indexes: IndexDescription[],
    options: CreateIndexesOptions,
  ): Promise<void> {
    await this.db.collection(name).createIndexes(indexes, options);
  }

  /**
   * Whether index builds use a commit quorum: a replica set member, or a
   * mongos routing to replica set shards.
   */
  async isReplicaSet(): Promise<boolean> {
    try {
      const hello = await this.db.admin().command({ hello: 1 });
      return typeof hello.setName === 'string' || hello.msg === 'isdbgrid';
    } catch {
      return false;
    }
  }

  /**
   * Best-effort identity of the deployment: the normalized seed hosts from the
   * URI plus, for replica sets, the member addresses the server reports.
   */
  async serverHosts(): Promise<Set<string>> {
    const options = this.#client.options;
    const hosts = new Set(
      options.srvHost
        ? [`srv:${options.srvHost.toLowerCase()}`]
        : options.hosts.map((host) => normalizeHost(host.toString())),
    );

    try {
      const hello = await this.db.admin().command({ hello: 1 });
      for (const member of [hello.me, ...((hello.hosts as unknown[]) ?? [])]) {
        if (typeof member === 'string') hosts.add(normalizeHost(member));
      }
    } catch {
      // Not permitted / not supported: rely on the hosts from the URI.
    }
    return hosts;
  }
}

function normalizeHost(host: string): string {
  const match = /^(.*):(\d+)$/.exec(host.toLowerCase());
  const [name, port] = match
    ? [match[1] ?? '', match[2] ?? '']
    : [host.toLowerCase(), '27017'];
  return `${LOOPBACK_HOSTS.has(name) ? 'loopback' : name}:${port}`;
}

/**
 * Read-only check whether both handles look like the same database: a
 * collection UUID present on both sides (`uuid`), or the same database name
 * on overlapping hosts (`hosts`). Both can also happen for different
 * databases (a copy restored with --preserveUUID, identical docker stacks);
 * `writesReachSource` is the conclusive check.
 */
export async function looksLikeSameDatabase(
  a: Database,
  b: Database,
): Promise<'uuid' | 'hosts' | null> {
  const [collectionsA, collectionsB] = await Promise.all([
    a.listCollections(),
    b.listCollections(),
  ]);
  const uuidsB = new Set(collectionsB.map((info) => info.uuid).filter(Boolean));
  if (collectionsA.some((info) => info.uuid && uuidsB.has(info.uuid))) {
    return 'uuid';
  }

  if (a.name !== b.name) {
    return null;
  }
  const [hostsA, hostsB] = await Promise.all([
    a.serverHosts(),
    b.serverHosts(),
  ]);
  return [...hostsA].some((host) => hostsB.has(host)) ? 'hosts' : null;
}

/**
 * Creates an empty, uniquely named collection in `target` and checks whether
 * it shows up in `source`, which is conclusive whatever the address used.
 * When the source is a secondary reached directly, the lookup is retried for
 * a few seconds to let the probe replicate. The probe is dropped right away.
 */
export async function writesReachSource(
  source: Database,
  target: Database,
  warn: (message: string) => void,
): Promise<boolean> {
  const probe = `${PROBE_PREFIX}${randomBytes(8).toString('hex')}`;
  try {
    await target.createCollection(probe, {});
  } catch (error) {
    throw new Error(
      `Could not create the probe collection ${probe} in the target to check that it is not the source (the target user needs permission to create and drop collections): ${(error as Error).message}`,
      { cause: error },
    );
  }

  try {
    const attempts = (await source.isWritablePrimary()) ? 1 : 25;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (await source.collectionExists(probe)) return true;
      if (attempt < attempts) await delay(200);
    }
    return false;
  } catch (error) {
    throw new Error(
      `Could not look for the probe collection ${probe} in the source: ${(error as Error).message}`,
      { cause: error },
    );
  } finally {
    await target.dropCollection(probe).catch((error: unknown) => {
      warn(
        `Could not drop the probe collection ${probe} from the target; drop it by hand: ${(error as Error).message}`,
      );
    });
  }
}
