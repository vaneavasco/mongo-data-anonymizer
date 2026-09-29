import {
  BSON,
  MongoOperationTimeoutError,
  type CreateIndexesOptions,
  type Document,
} from 'mongodb';
import { Anonymizer } from './anonymization/anonymize.ts';
import {
  decideCollectionAction,
  type CollectionAction,
} from './anonymization/collections.ts';
import {
  Database,
  looksLikeSameDatabase,
  writesReachSource,
  type CollectionInfo,
} from './anonymization/database.ts';
import {
  CollectionRules,
  parseFieldRule,
  rulesForCollection,
  type FieldRule,
} from './anonymization/rules.ts';
import { consoleLogger, type Logger } from './logger.ts';
import {
  DEFAULT_PROGRESS,
  Progress,
  describeProgress,
  formatDuration,
  type ProgressOptions,
} from './progress.ts';

export interface RunConfig {
  sourceUri: string;
  targetUri: string;
  /** Field rules, `[collection.]field[:replacement]`. */
  fieldList: string[];
  collectionList: string[];
  ignoreCollections: string[];
  batchSize: number;
  copyNonAnonymized: boolean;
  /** Drop target collections that already exist instead of refusing to run. */
  dropTarget: boolean;
  /** Report what would happen without writing anything. */
  dryRun: boolean;
  /** Secret for deterministic anonymization; random per run when omitted. */
  secret?: string;
  /** Fail instead of warning when a matched value can't be anonymized. */
  strict?: boolean;
  /**
   * Skip the read-only "looks like the same database" check (shared
   * collection UUIDs or hosts), e.g. when the target is a restored copy of the
   * source. The write probe that proves the target is not the source still runs.
   */
  assumeDifferentTarget?: boolean;
  /** Replace email addresses found in any string (default true). */
  scrubEmails?: boolean;
  /**
   * Documents per collection a dry run checks for personal-looking keys that
   * no rule matches (default 1000; 0 checks every document).
   */
  sampleSize?: number;
  /**
   * Commit quorum for index builds when the target is a replica set
   * (default 1: the primary's vote is enough, so an unavailable or stuck
   * secondary can't hold the build up). Ignored on a standalone.
   */
  indexCommitQuorum?: number | string;
  /** Give up on a collection's index build after this many seconds (default 900; 0 = no limit). */
  indexTimeoutSeconds?: number;
  /** Progress log and stall warning timings; mainly for tests. */
  progress?: Partial<ProgressOptions>;
}

/**
 * Batches are also cut at this size, so collections of large documents
 * (e.g. rendered HTML) don't hold hundreds of MB per batch in memory.
 */
const MAX_BATCH_BYTES = 16 * 1024 * 1024;

const DEFAULT_SAMPLE_SIZE = 1000;

export interface CollectionReport {
  name: string;
  type: string;
  action: CollectionAction;
  documents: number;
  anonymizedFields: string[];
  /**
   * Dry run only: keys in a sample of the collection that look like
   * personal data but that no rule covers (and that will therefore be
   * written unchanged).
   */
  unmatchedPersonalKeys?: string[];
}

export interface RunReport {
  collections: CollectionReport[];
  warnings: string[];
}

interface PlannedCollection {
  info: CollectionInfo;
  action: CollectionAction;
}

export async function run(
  config: RunConfig,
  logger: Logger = consoleLogger,
): Promise<RunReport> {
  const sampleSize = config.sampleSize ?? DEFAULT_SAMPLE_SIZE;
  if (!Number.isInteger(sampleSize) || sampleSize < 0) {
    throw new Error(
      `--sampleSize must be 0 or a positive integer, got ${sampleSize}`,
    );
  }
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1) {
    throw new Error(
      `--batchSize must be a positive integer, got ${config.batchSize}`,
    );
  }

  const warnings: string[] = [];
  const warn = (message: string) => {
    warnings.push(message);
    logger.warn(message);
  };

  const rules = config.fieldList.map(parseFieldRule);
  const anonymizer = new Anonymizer({
    secret: config.secret,
    strict: config.strict ?? false,
    scrubEmails: config.scrubEmails ?? true,
  }).onWarning(warn);
  anonymizer.validateRules(rules);
  if (!config.secret) {
    warn(
      'No secret given: using a random one. Fake values are consistent within this run but will differ on the next one; set ANONYMIZER_SECRET (or --secret) for reproducible output.',
    );
  }

  const source = new Database(config.sourceUri, 'source');
  const target = new Database(config.targetUri, 'target');
  const progressOptions = { ...DEFAULT_PROGRESS, ...config.progress };
  const progress = new Progress(progressOptions, warn);

  try {
    progress.start();
    progress.operation('connecting');
    await source.connect();
    await target.connect();
    const indexOptions = await indexBuildOptions(target, config);

    await checkNotSameDatabase(source, target, config, warn);

    const sourceCollections = await source.listCollections();
    checkCollectionNames(sourceCollections, config, rules);

    const planned: PlannedCollection[] = sourceCollections.map((info) => ({
      info,
      action: decideCollectionAction(info.name, config),
    }));
    const written = planned.filter(({ action }) => action !== 'skip');
    const anonymized = planned.filter(
      ({ info, action }) => action === 'anonymize' && info.type !== 'view',
    );
    if (written.length === 0) {
      warn(
        'Nothing to write: every collection is skipped. Check --collectionList and --ignoreCollections.',
      );
    } else if (anonymized.length === 0) {
      throw new Error(
        'No collection would be anonymized; everything selected would be copied as-is. Check --collectionList and --ignoreCollections.',
      );
    }
    logger.info(
      `Fields anonymized in every collection: ${describeRules(rules)}`,
    );

    await prepareTarget(target, written, config, logger);

    const reports: CollectionReport[] = [];
    for (const { info, action } of planned) {
      const collectionRules = rulesForCollection(rules, info.name);
      const report: CollectionReport = {
        name: info.name,
        type: info.type,
        action,
        documents: 0,
        anonymizedFields: action === 'anonymize' ? collectionRules.fields : [],
      };
      reports.push(report);

      if (info.type === 'view') {
        continue; // Recreated once every collection is in place.
      }
      if (action === 'skip') {
        logger.info(`Skipping ${info.name}.`);
        continue;
      }
      if (config.dryRun) {
        report.documents = await source.estimatedCount(info.name);
        report.unmatchedPersonalKeys = await findUnmatchedPersonalKeys(
          source,
          info.name,
          anonymizer,
          action === 'anonymize' ? collectionRules : new CollectionRules([]),
          sampleSize,
          progress,
        );
        logger.info(
          `[dry run] Would ${action} ${info.name} (~${report.documents} documents)` +
            (action === 'anonymize'
              ? collectionSpecificNote(rules, info.name)
              : ''),
        );
        if (report.unmatchedPersonalKeys.length > 0) {
          warn(
            `${info.name}: these keys look like personal data but would be written unchanged: ${report.unmatchedPersonalKeys.join(', ')}`,
          );
        }
        continue;
      }

      logger.info(
        `${action === 'anonymize' ? 'Anonymizing' : 'Copying'} ${info.name}...`,
      );
      const started = Date.now();
      progress.operation(`createCollection ${info.name}`);
      await createLike(target, info, warn);
      report.documents = await copyDocuments({
        source,
        target,
        name: info.name,
        batchSize: config.batchSize,
        transform: (batch) =>
          action === 'anonymize'
            ? anonymizer.anonymizeBatch(batch, collectionRules)
            : batch,
        progress,
        logger,
        reportEveryMs: progressOptions.reportEveryMs,
      });
      await copyIndexes(
        source,
        target,
        info.name,
        indexOptions,
        progress,
        warn,
      );
      const elapsed = Date.now() - started;
      logger.info(
        `Done with ${info.name}: ${describeProgress(report.documents, 0, elapsed)} in ${formatDuration(elapsed)}.`,
      );
    }

    progress.operation('recreating views');

    for (const { info, action } of written.filter(
      ({ info }) => info.type === 'view',
    )) {
      if (config.dryRun) {
        logger.info(`[dry run] Would recreate view ${info.name} (${action}).`);
        continue;
      }
      try {
        await target.createCollection(info.name, info.options);
        logger.info(`Recreated view ${info.name}.`);
      } catch (error) {
        warn(
          `Could not recreate view ${info.name}: ${(error as Error).message}`,
        );
      }
    }

    logger.info(
      config.dryRun
        ? 'Dry run finished; nothing was written.'
        : `Anonymization finished${warnings.length ? ` with ${warnings.length} warning(s)` : ''}.`,
    );
    return { collections: reports, warnings };
  } finally {
    progress.stop();
    await Promise.allSettled([source.close(), target.close()]);
  }
}

async function checkNotSameDatabase(
  source: Database,
  target: Database,
  config: RunConfig,
  warn: (message: string) => void,
): Promise<void> {
  const names = `source "${source.name}", target "${target.name}"`;

  if (!config.assumeDifferentTarget) {
    const reason = await looksLikeSameDatabase(source, target);
    if (reason) {
      throw new Error(
        (reason === 'uuid'
          ? `The target shares collection UUIDs with the source (${names}). Either they are the same database, or the target is a physical copy of the source (e.g. restored with mongorestore --preserveUUID).`
          : `The target has the same database name on the same hosts as the source (${names}), so they look like the same database.`) +
          ' If you are sure the target is a different database, pass --assumeDifferentTarget; a real run still checks that writes to the target do not reach the source.',
      );
    }
  }

  const stale = await target.listProbes();
  if (stale.length > 0) {
    warn(
      `The target contains probe collections left by an interrupted run; you can drop them: ${stale.join(', ')}`,
    );
  }

  if (!config.dryRun && (await writesReachSource(source, target, warn))) {
    throw new Error(
      `Writes to the target reach the source (${names}): they are the same database. Refusing to write into the source.`,
    );
  }
}

function formatRule({ field, replacement }: FieldRule): string {
  return replacement === null ? field : `${field}:${replacement}`;
}

function describeRules(rules: FieldRule[]): string {
  const global = rules.filter(({ collection }) => collection === null);
  return global.map(formatRule).join(', ') || '(none)';
}

/** The collection-scoped rules for one collection, for the dry-run log. */
function collectionSpecificNote(rules: FieldRule[], name: string): string {
  const own = rules.filter(({ collection }) => collection === name);
  return own.length > 0 ? `, plus: ${own.map(formatRule).join(', ')}` : '';
}

/**
 * Every collection named in the options must exist in the source: a typo in
 * --collectionList combined with --copyNonAnonymized would otherwise copy
 * the collection it was meant to anonymize as-is.
 */
function checkCollectionNames(
  sourceCollections: CollectionInfo[],
  config: RunConfig,
  rules: FieldRule[],
): void {
  const existing = new Set(sourceCollections.map(({ name }) => name));
  const unknown = (names: Iterable<string>) =>
    [...new Set(names)].filter((name) => !existing.has(name));

  const problems = [
    ['--collectionList', unknown(config.collectionList)],
    ['--ignoreCollections', unknown(config.ignoreCollections)],
    [
      '--fieldList',
      unknown(rules.flatMap(({ collection }) => collection ?? [])),
    ],
  ] as const;

  const messages = problems
    .filter(([, names]) => names.length > 0)
    .map(([option, names]) => `${option}: ${names.join(', ')}`);
  if (messages.length > 0) {
    throw new Error(
      `Unknown collections in the source (${messages.join('; ')}). Nothing was written.`,
    );
  }
}

async function findUnmatchedPersonalKeys(
  source: Database,
  name: string,
  anonymizer: Anonymizer,
  rules: CollectionRules,
  sampleSize: number,
  progress: Progress,
): Promise<string[]> {
  const found = new Set<string>();
  progress.operation(`sampling ${name}`);
  for await (const document of source.sample(name, sampleSize)) {
    progress.activity();
    for (const key of anonymizer.findUnmatchedPersonalKeys(document, rules)) {
      found.add(key);
    }
  }
  return [...found].sort();
}

/**
 * Checks every target collection up front, so a run never stops halfway
 * because of leftovers from a previous one.
 */
async function prepareTarget(
  target: Database,
  written: PlannedCollection[],
  config: RunConfig,
  logger: Logger,
): Promise<void> {
  const existing: string[] = [];
  for (const { info } of written) {
    if (await target.collectionExists(info.name)) {
      existing.push(info.name);
    }
  }
  if (existing.length === 0) {
    return;
  }

  if (!config.dropTarget) {
    throw new Error(
      `The target already contains: ${existing.join(', ')}. Use --dropTarget to replace them.`,
    );
  }

  for (const name of existing) {
    if (config.dryRun) {
      logger.info(`[dry run] Would drop target collection ${name}.`);
    } else {
      await target.dropCollection(name);
      logger.info(`Dropped target collection ${name}.`);
    }
  }
}

/** Creates the target collection with the source's options (validators, collation, time series, ...). */
async function createLike(
  target: Database,
  info: CollectionInfo,
  warn: (message: string) => void,
): Promise<void> {
  try {
    await target.createCollection(info.name, info.options);
  } catch (error) {
    warn(
      `Could not create ${info.name} with the source options (${(error as Error).message}); it is created with defaults.`,
    );
  }
}

interface CopyDocuments {
  source: Database;
  target: Database;
  name: string;
  batchSize: number;
  transform: (batch: Document[]) => Document[];
  progress: Progress;
  logger: Logger;
  reportEveryMs: number;
}

/**
 * Streams documents in batches (cut at `batchSize` documents or
 * MAX_BATCH_BYTES), reading the next batch while the previous one is being
 * inserted, and logs progress every `reportEveryMs`.
 */
async function copyDocuments({
  source,
  target,
  name,
  batchSize,
  transform,
  progress,
  logger,
  reportEveryMs,
}: CopyDocuments): Promise<number> {
  const total = await source.estimatedCount(name);
  const started = Date.now();
  let lastReport = started;
  let count = 0;
  let pending: Promise<void> = Promise.resolve();
  let batch: Document[] = [];
  let batchBytes = 0;

  const flush = async () => {
    const documents = transform(batch);
    batch = [];
    batchBytes = 0;
    await pending;
    pending = target
      .insertMany(name, documents)
      .then(() => progress.activity());
    // Handled here so a failure while the next batch is being read isn't an
    // unhandled rejection; it is still rethrown by the next flush or `finally`.
    pending.catch(() => {});
    count += documents.length;

    const now = Date.now();
    if (now - lastReport >= reportEveryMs) {
      lastReport = now;
      logger.info(`${name}: ${describeProgress(count, total, now - started)}`);
    }
  };

  progress.operation(`copying ${name}`);
  try {
    for await (const document of source.find(name, batchSize)) {
      progress.activity();
      batch.push(document);
      batchBytes += BSON.calculateObjectSize(document);
      if (batch.length >= batchSize || batchBytes >= MAX_BATCH_BYTES) {
        await flush();
      }
    }
    await flush();
  } finally {
    await pending;
  }
  return count;
}

async function indexBuildOptions(
  target: Database,
  config: RunConfig,
): Promise<CreateIndexesOptions> {
  const quorum = config.indexCommitQuorum ?? 1;
  const validQuorum =
    (typeof quorum === 'number' && Number.isInteger(quorum) && quorum >= 0) ||
    quorum === 'majority' ||
    quorum === 'votingMembers';
  if (!validQuorum) {
    throw new Error(
      `--indexCommitQuorum must be a number of members, "majority" or "votingMembers", got ${JSON.stringify(quorum)}`,
    );
  }
  const timeoutSeconds = config.indexTimeoutSeconds ?? 900;
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    throw new Error(
      `--indexTimeout must be 0 or a positive number of seconds, got ${timeoutSeconds}`,
    );
  }
  return {
    // timeoutMS (not maxTimeMS, which driver 7 no longer sends here) also
    // makes the server abort the build when it expires.
    ...(timeoutSeconds > 0 ? { timeoutMS: timeoutSeconds * 1000 } : {}),
    // Standalones reject commitQuorum.
    ...((await target.isReplicaSet()) ? { commitQuorum: quorum } : {}),
  };
}

function isTimeout(error: unknown): boolean {
  const { code, codeName } = error as { code?: unknown; codeName?: unknown };
  return (
    error instanceof MongoOperationTimeoutError ||
    code === 50 ||
    codeName === 'MaxTimeMSExpired'
  );
}

/**
 * Builds a collection's indexes in one call, after the data is in, so a
 * unique index that the fake values happen to violate costs a warning
 * instead of a failed insert. One call builds all or none, so on an error
 * each index is retried on its own to keep the ones that work, except after
 * a timeout, which would only repeat the wait for every index.
 */
async function copyIndexes(
  source: Database,
  target: Database,
  name: string,
  options: CreateIndexesOptions,
  progress: Progress,
  warn: (message: string) => void,
): Promise<void> {
  const indexes = await source.listIndexes(name);
  if (indexes.length === 0) return;
  const names = indexes.map((index) => String(index.name)).join(', ');
  // --indexTimeout covers the whole collection, retries included.
  const deadline =
    options.timeoutMS === undefined
      ? undefined
      : Date.now() + options.timeoutMS;
  const skipRest = (index: string) =>
    warn(
      `Index ${index} on ${name} did not finish building within ${formatDuration(options.timeoutMS ?? 0)}; the remaining indexes of ${name} were skipped. Build them in the target by hand, or raise --indexTimeout.`,
    );

  progress.operation(`createIndexes on ${name} (${names})`);
  try {
    await target.createIndexes(name, indexes, options);
    progress.activity();
    return;
  } catch (error) {
    if (isTimeout(error)) {
      warn(
        `Indexes on ${name} did not finish building within ${formatDuration(options.timeoutMS ?? 0)} and were skipped: ${names}. Build them in the target by hand, or raise --indexTimeout.`,
      );
      return;
    }
  }

  for (const index of indexes) {
    const remaining =
      deadline === undefined ? undefined : deadline - Date.now();
    if (remaining !== undefined && remaining <= 0) {
      skipRest(String(index.name));
      return;
    }
    progress.operation(`createIndexes on ${name} (${String(index.name)})`);
    try {
      await target.createIndexes(name, [index], {
        ...options,
        ...(remaining === undefined ? {} : { timeoutMS: remaining }),
      });
      progress.activity();
    } catch (error) {
      if (isTimeout(error)) {
        skipRest(String(index.name));
        return;
      }
      warn(
        `Could not create index ${String(index.name)} on ${name}: ${(error as Error).message}`,
      );
    }
  }
}
