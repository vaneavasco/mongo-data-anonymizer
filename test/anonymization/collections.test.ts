import { describe, expect, it } from 'vitest';
import { decideCollectionAction } from '../../src/anonymization/collections.ts';

describe('decideCollectionAction', () => {
  const none = {
    collectionList: [],
    ignoreCollections: [],
    copyNonAnonymized: false,
  };

  it.each([
    // name, collectionList, ignoreCollections, copyNonAnonymized, expected
    ['users', [], [], false, 'anonymize'],
    ['users', [], [], true, 'anonymize'],
    ['users', ['users'], [], true, 'anonymize'],
    ['logs', ['users'], [], false, 'skip'],
    ['logs', ['users'], [], true, 'copy'],
    ['logs', [], ['logs'], false, 'skip'],
    ['logs', [], ['logs'], true, 'copy'],
    ['users', ['users'], ['users'], false, 'skip'],
  ] as const)(
    '%s with list=%j ignore=%j copy=%s -> %s',
    (name, collectionList, ignoreCollections, copyNonAnonymized, expected) => {
      expect(
        decideCollectionAction(name, {
          collectionList: [...collectionList],
          ignoreCollections: [...ignoreCollections],
          copyNonAnonymized,
        }),
      ).toBe(expected);
    },
  );

  it('never copies raw data just because --copyNonAnonymized is set', () => {
    expect(
      decideCollectionAction('users', { ...none, copyNonAnonymized: true }),
    ).toBe('anonymize');
  });
});
