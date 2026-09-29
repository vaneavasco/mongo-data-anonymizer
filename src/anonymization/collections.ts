export type CollectionAction = 'anonymize' | 'copy' | 'skip';

export interface CollectionSelection {
  collectionList: string[];
  ignoreCollections: string[];
  copyNonAnonymized: boolean;
}

/**
 * A collection is anonymized when it is not ignored and either no
 * collection list was given or it is on that list. Anything else is copied
 * as-is with `--copyNonAnonymized`, or skipped otherwise.
 */
export function decideCollectionAction(
  name: string,
  { collectionList, ignoreCollections, copyNonAnonymized }: CollectionSelection,
): CollectionAction {
  const selected =
    !ignoreCollections.includes(name) &&
    (collectionList.length === 0 || collectionList.includes(name));

  if (selected) {
    return 'anonymize';
  }
  return copyNonAnonymized ? 'copy' : 'skip';
}
