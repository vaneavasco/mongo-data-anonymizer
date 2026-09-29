/**
 * A field rule, as written on the command line:
 *
 *   [collection.]field[:replacement]
 *
 * `collection` is everything before the last `.` (collection names may
 * contain dots), `replacement` is everything after the first `:` (so it may
 * itself contain `:`, e.g. a URL). `field` may contain `*` wildcards.
 */
export interface FieldRule {
  collection: string | null;
  /** Lower-cased field name or pattern; matched case-insensitively against keys at any depth. */
  field: string;
  replacement: string | null;
  /** Set when `field` contains `*`. */
  pattern: RegExp | null;
}

/**
 * Fields anonymized when --fieldList doesn't replace them. Patterns end in
 * the personal word, so `orderEmail` matches `*email` but `emailTemplate`
 * and `emailVerified` don't.
 */
export const DEFAULT_FIELDS = [
  // Emails (any string value that is an email address is also caught by --scrubEmails).
  '*email',
  '*emails',
  'recipient',
  'recipients',
  'sender',
  // Names.
  'name',
  'firstname',
  'lastname',
  'middlename',
  'fullname',
  'surname',
  'displayname',
  'nickname',
  'username',
  // Phones.
  '*phone',
  '*phones',
  '*phoneno',
  '*phonenumber',
  '*mobile',
  'fax',
  // Addresses and places.
  '*address',
  'street',
  'city',
  'country',
  '*zip',
  '*zipcode',
  '*postcode',
  '*postalcode',
  // Dates of birth.
  'birthdate',
  'birthday',
  'dateofbirth',
  'dob',
  // Free text that tends to contain personal details.
  'description',
  'comment',
  'comments',
  'note',
  'notes',
  // Identifiers and credentials.
  'ip',
  'ssn',
  'iban',
  'passport',
  '*password',
  'password*',
  '*passwordhash',
  '*token',
  '*tokenhash',
  '*secret',
  '*secretkey',
  '*apikey',
  '*privatekey',
  'salt',
];

/**
 * How keys and rule fields are compared: case-insensitively and ignoring
 * `_` and `-`, so `first_name`, `first-name` and `firstName` are the same key.
 */
export function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

function toPattern(field: string): RegExp | null {
  if (!field.includes('*')) return null;
  const source = field
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

export function parseFieldRule(rule: string): FieldRule {
  const colon = rule.indexOf(':');
  const spec = colon === -1 ? rule : rule.slice(0, colon);
  const replacement = colon === -1 ? null : rule.slice(colon + 1);
  const dot = spec.lastIndexOf('.');

  const field = normalizeKey((dot === -1 ? spec : spec.slice(dot + 1)).trim());
  if (!field) {
    throw new Error(`Invalid field rule "${rule}": missing field name`);
  }

  return {
    collection: dot === -1 ? null : spec.slice(0, dot),
    field,
    replacement,
    pattern: toPattern(field),
  };
}

/** The part of a rule that identifies it, i.e. without the replacement. */
function ruleSpec(rule: string): string {
  const colon = rule.indexOf(':');
  const spec = colon === -1 ? rule : rule.slice(0, colon);
  const dot = spec.lastIndexOf('.');
  return `${spec.slice(0, dot + 1)}${normalizeKey(spec.slice(dot + 1))}`;
}

/**
 * Resolves the `--fieldList` option against the default fields.
 *
 * Every item may carry its own modifier:
 *   - `field`  : explicit field; if any are given, they replace the defaults
 *   - `+field` : added to the list
 *   - `-field` : removed from the list
 *
 * So `+age,-*email` means "the defaults, plus age, minus *email". A removal
 * must name an existing rule exactly; anything else is an error rather than
 * a silent no-op.
 */
export function getFieldList(
  fieldListOption: string | undefined,
  defaultFields: string[] = DEFAULT_FIELDS,
): string[] {
  const items = (fieldListOption ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

  const explicit = items.filter((item) => !/^[+-]/.test(item));
  const added = items
    .filter((item) => item.startsWith('+'))
    .map((item) => item.slice(1));
  const removed = new Set(
    items
      .filter((item) => item.startsWith('-'))
      .map((item) => ruleSpec(item.slice(1))),
  );

  const base = explicit.length > 0 ? explicit : defaultFields;
  const all = [...base, ...added];
  const unknown = [...removed].filter(
    (spec) => !all.some((item) => ruleSpec(item) === spec),
  );
  if (unknown.length > 0) {
    throw new Error(
      `--fieldList removes rules that don't exist: ${unknown.map((spec) => `-${spec}`).join(', ')}. Removals must match a rule exactly, e.g. -*email for the default *email.`,
    );
  }

  return [...new Set(all.filter((item) => !removed.has(ruleSpec(item))))];
}

class RuleTier {
  readonly exact = new Map<string, FieldRule>();
  readonly patterns: FieldRule[] = [];

  /** A later rule wins over an earlier one, so rules added to the defaults take precedence. */
  add(rule: FieldRule): void {
    if (rule.pattern) {
      this.patterns.unshift(rule);
    } else {
      this.exact.set(rule.field, rule);
    }
  }

  match(lower: string): FieldRule | undefined {
    return (
      this.exact.get(lower) ??
      this.patterns.find(({ pattern }) => pattern?.test(lower))
    );
  }
}

/**
 * The rules that apply to one collection. Lookup order: the collection's own
 * rules before global ones, and within each, an exact field name before a
 * pattern. So `users.*name:REDACTED` overrides a global `name`.
 */
export class CollectionRules {
  readonly #scoped = new RuleTier();
  readonly #global = new RuleTier();

  constructor(rules: FieldRule[]) {
    for (const rule of rules) {
      (rule.collection === null ? this.#global : this.#scoped).add(rule);
    }
  }

  /** The rule for a document key, if any. */
  match(key: string): FieldRule | undefined {
    const normalized = normalizeKey(key);
    return this.#scoped.match(normalized) ?? this.#global.match(normalized);
  }

  /** Field names and patterns, for reports. */
  get fields(): string[] {
    return [
      ...new Set(
        [this.#scoped, this.#global].flatMap((tier) =>
          [...tier.exact.values(), ...tier.patterns]
            // Only rules that are in effect: not kept, and not shadowed by a
            // collection rule (e.g. a global `name` under `images.name:keep`).
            .filter(
              (rule) =>
                rule.replacement !== 'keep' && this.match(rule.field) === rule,
            )
            .map(({ field }) => field),
        ),
      ),
    ];
  }
}

/**
 * Rules that apply to a collection: its own rules, then the global ones, so
 * a collection-scoped rule takes precedence over a global rule.
 */
export function rulesForCollection(
  rules: FieldRule[],
  collectionName: string,
): CollectionRules {
  return new CollectionRules([
    ...rules.filter(({ collection }) => collection === collectionName),
    ...rules.filter(({ collection }) => collection === null),
  ]);
}
