import { describe, expect, it } from 'vitest';
import { parseArgs } from '../src/config.ts';
import { DEFAULT_FIELDS } from '../src/anonymization/rules.ts';

const required = [
  '--sourceUri',
  'mongodb://src/a',
  '--targetUri',
  'mongodb://dst/b',
];

describe('parseArgs', () => {
  it('applies defaults', () => {
    expect(parseArgs(required, {})).toEqual({
      sourceUri: 'mongodb://src/a',
      targetUri: 'mongodb://dst/b',
      fieldList: DEFAULT_FIELDS,
      collectionList: [],
      ignoreCollections: [],
      batchSize: 1000,
      copyNonAnonymized: false,
      dropTarget: false,
      dryRun: false,
      strict: false,
      assumeDifferentTarget: false,
      scrubEmails: true,
      sampleSize: 1000,
      indexCommitQuorum: 1,
      indexTimeoutSeconds: 900,
    });
  });

  it('parses every option', () => {
    const config = parseArgs(
      [
        ...required,
        '--fieldList',
        '+age,-*email',
        '--collectionList',
        'users, admins',
        '--ignoreCollections',
        'logs',
        '--batchSize',
        '500',
        '--copyNonAnonymized',
        '--dropTarget',
        '--dryRun',
        '--strict',
        '--secret',
        's3cret',
      ],
      {},
    );

    expect(config).toMatchObject({
      collectionList: ['users', 'admins'],
      ignoreCollections: ['logs'],
      batchSize: 500,
      copyNonAnonymized: true,
      dropTarget: true,
      dryRun: true,
      strict: true,
      secret: 's3cret',
    });
    expect(config.fieldList).toContain('age');
    expect(config.fieldList).not.toContain('*email');
  });

  it('passes a named commit quorum through as a string', () => {
    expect(
      parseArgs([...required, '--indexCommitQuorum', 'majority'], {})
        .indexCommitQuorum,
    ).toBe('majority');
  });

  it.each(['majorty', '-1', '1.5', ''])(
    'rejects the commit quorum %j',
    (value) => {
      expect(() =>
        parseArgs([...required, '--indexCommitQuorum', value], {}),
      ).toThrow(/--indexCommitQuorum must be/);
    },
  );

  it('reads options from ANONYMIZER_* environment variables', () => {
    expect(
      parseArgs([], {
        ANONYMIZER_SOURCE_URI: 'mongodb://env-src/a',
        ANONYMIZER_TARGET_URI: 'mongodb://env-dst/b',
        ANONYMIZER_SECRET: 'from-env',
        ANONYMIZER_DRY_RUN: 'true',
        ANONYMIZER_BATCH_SIZE: '5',
      }),
    ).toMatchObject({
      sourceUri: 'mongodb://env-src/a',
      targetUri: 'mongodb://env-dst/b',
      secret: 'from-env',
      dryRun: true,
      batchSize: 5,
    });
  });

  it('lets the command line override the environment', () => {
    expect(
      parseArgs([...required, '--batchSize', '7', '--dryRun=false'], {
        ANONYMIZER_BATCH_SIZE: '5',
        ANONYMIZER_DRY_RUN: 'true',
      }),
    ).toMatchObject({ batchSize: 7, dryRun: false });
  });

  it('ignores unrelated ANONYMIZER_* variables', () => {
    expect(() =>
      parseArgs(required, { ANONYMIZER_SOMETHING_ELSE: '1' }),
    ).not.toThrow();
  });

  it.each([
    ['1', true],
    ['true', true],
    ['YES', true],
    ['on', true],
    ['0', false],
    ['false', false],
    ['no', false],
    ['', false],
  ])('reads the boolean environment value %j as %s', (value, expected) => {
    expect(parseArgs(required, { ANONYMIZER_STRICT: value }).strict).toBe(
      expected,
    );
  });

  it('rejects a boolean environment value it does not understand', () => {
    expect(() =>
      parseArgs(required, { ANONYMIZER_DROP_TARGET: 'maybe' }),
    ).toThrow(/ANONYMIZER_DROP_TARGET must be true or false/);
  });
});
