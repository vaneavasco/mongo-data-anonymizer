import { createHmac, randomBytes } from 'node:crypto';
import { Faker, base, en } from '@faker-js/faker';
import { CollectionRules, normalizeKey, type FieldRule } from './rules.ts';
import { sfc32Randomizer } from './randomizer.ts';

type Generator = (faker: Faker, seedHex: string) => unknown;

/**
 * Fixed reference date for faker's date generators, so generated dates don't
 * drift with the wall clock and output stays identical across runs.
 */
const REFERENCE_DATE = new Date('2025-01-01T00:00:00.000Z');

// The hash suffix keeps distinct originals distinct (unique indexes), and
// example.com is reserved, so a stray email can never reach a real person.
const emailGenerator = (faker: Faker, seedHex: string): string =>
  `${faker.person.firstName()}.${faker.person.lastName()}.${seedHex.slice(0, 8)}@example.com`
    .toLowerCase()
    .replace(/[^a-z0-9.@-]/g, '');

/** `Jane Doe <jane@x.com>`, `"Doe, Jane" <jane@x.com>` or `<jane@x.com>`. */
const NAMED_EMAIL = /^\s*"?([^"<>]*?)"?\s*<([^<>\s]+)>\s*$/;

/** `<jane@x.com>` and `jane@x.com.` are the address `jane@x.com`. */
function normalizeEmail(value: string): string {
  return value.trim().replace(/^<|>$/g, '').replace(/\.+$/, '');
}

/** A value that is a single email address, whatever its field is called. */
function isEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim());
}

/**
 * Generators picked from the (lower-cased) field name. Order matters: the
 * first match wins, so more specific names come first.
 */
const endsWith =
  (...suffixes: string[]) =>
  (key: string) =>
    suffixes.some((suffix) => key.endsWith(suffix));

const isLatitudeKey = (key: string) =>
  key === 'lat' || key.endsWith('latitude');
const isLongitudeKey = (key: string) =>
  ['lng', 'lon', 'long'].includes(key) || key.endsWith('longitude');

/** Values that describe the shape of a subdocument, not the person: kept as they are. */
const STRUCTURAL_KEYS = new Set(['type', 'kind', '__typename']);

const GEOJSON_TYPES = new Set([
  'Point',
  'MultiPoint',
  'LineString',
  'MultiLineString',
  'Polygon',
  'MultiPolygon',
]);

function isGeoJson(
  value: Record<string, unknown>,
): value is { type: string; coordinates: unknown[] } {
  return (
    typeof value.type === 'string' &&
    GEOJSON_TYPES.has(value.type) &&
    Array.isArray(value.coordinates)
  );
}

/** Keys under which a pair of numbers is a position (`loc`, `coordinates`, `geoPoint`...). */
const GEO_KEY = /(coord|loc|geo|position|point|latlng|lnglat)/;

/** A legacy `[longitude, latitude]` pair. */
function isCoordinatePair(value: unknown[]): value is [number, number] {
  const [lng, lat] = value;
  return (
    value.length === 2 &&
    typeof lng === 'number' &&
    typeof lat === 'number' &&
    Math.abs(lng) <= 180 &&
    Math.abs(lat) <= 90
  );
}

const GENERATORS: [(key: string) => boolean, Generator][] = [
  [isLatitudeKey, (faker) => faker.location.latitude()],
  [isLongitudeKey, (faker) => faker.location.longitude()],
  [(key) => key.includes('email'), emailGenerator],
  [(key) => key.includes('firstname'), (faker) => faker.person.firstName()],
  [
    (key) => key.includes('lastname') || key.endsWith('surname'),
    (faker) => faker.person.lastName(),
  ],
  [
    (key) => key.endsWith('username') || key === 'login',
    // The hash suffix keeps usernames unique, like emails.
    (faker, seedHex) => `${faker.internet.username()}_${seedHex.slice(0, 6)}`,
  ],
  [
    endsWith(
      'description',
      'comment',
      'comments',
      'note',
      'notes',
      'message',
      'bio',
      'body',
    ),
    (faker) => faker.lorem.sentence(),
  ],
  [
    (key) =>
      key.includes('password') ||
      endsWith(
        'token',
        'secret',
        'hash',
        'digest',
        'salt',
        'apikey',
        'secretkey',
        'privatekey',
      )(key),
    (faker) => faker.string.alphanumeric(32),
  ],
  [
    (key) => key === 'ip' || key.endsWith('ipaddress'),
    (faker) => faker.internet.ipv4(),
  ],
  [endsWith('street'), (faker) => faker.location.street()],
  [endsWith('address'), (faker) => faker.location.streetAddress()],
  [endsWith('city'), (faker) => faker.location.city()],
  [endsWith('country'), (faker) => faker.location.country()],
  [
    endsWith('zip', 'zipcode', 'postcode', 'postalcode'),
    (faker) => faker.location.zipCode(),
  ],
  [
    (key) => ['phone', 'mobile', 'fax'].some((word) => key.includes(word)),
    (faker) => faker.phone.number(),
  ],
  [
    (key) => key.includes('birth') || key === 'dob',
    (faker) => faker.date.birthdate({ refDate: REFERENCE_DATE }),
  ],
  [endsWith('date'), (faker) => faker.date.past({ refDate: REFERENCE_DATE })],
  [endsWith('company'), (faker) => faker.company.name()],
  [endsWith('iban'), (faker) => faker.finance.iban()],
  [
    endsWith('ssn', 'passport'),
    (faker) => faker.string.alphanumeric({ length: 9, casing: 'upper' }),
  ],
  [
    endsWith('name', 'recipient', 'recipients', 'sender'),
    (faker) => faker.person.fullName(),
  ],
];

function generatorFor(key: string): Generator | undefined {
  return GENERATORS.find(([matches]) => matches(key))?.[1];
}

const fallbackGenerator: Generator = (faker) => faker.word.sample();

/** Documents coming from the driver are plain objects; BSON values, Dates and buffers are not. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function canonical(value: unknown): string {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? 'date:invalid'
      : `date:${value.toISOString()}`;
  }
  return `${typeof value}:${String(value)}`;
}

function sameMagnitudeNumber(faker: Faker, original: number): number {
  const digits = Math.max(
    1,
    Math.floor(Math.log10(Math.abs(original) || 1)) + 1,
  );
  const max = 10 ** digits - 1;
  const min = digits === 1 ? 0 : 10 ** (digits - 1);
  const sign = original < 0 ? -1 : 1;

  if (Math.abs(original) < 1 && !Number.isInteger(original)) {
    return sign * faker.number.float({ min: 0, max: 0.99, fractionDigits: 2 });
  }
  if (Number.isInteger(original)) {
    return sign * faker.number.int({ min, max });
  }
  return sign * faker.number.float({ min, max, fractionDigits: 2 });
}

/**
 * Key names that usually hold personal data. Used to point out fields that
 * no rule matches (see `findUnmatchedPersonalKeys`); never to anonymize.
 */
const PERSONAL_WORDS = new Set([
  'email',
  'emails',
  'mail',
  'phone',
  'phones',
  'telephone',
  'tel',
  'mobile',
  'fax',
  'phonenumber',
  'firstname',
  'lastname',
  'fullname',
  'surname',
  'username',
  'nickname',
  'address',
  'addresses',
  'street',
  'city',
  'zip',
  'zipcode',
  'postcode',
  'postal',
  'birth',
  'birthdate',
  'birthday',
  'dob',
  'ssn',
  'passport',
  'iban',
  'password',
  'token',
  'secret',
  'ip',
  'gender',
  'nationality',
  'recipient',
  'recipients',
  'sender',
  'latitude',
  'longitude',
  'lat',
  'lng',
]);

/** Words that turn a following `name` into a person's name (`firstName`, `display_name`). */
const NAME_QUALIFIERS = new Set([
  'first',
  'last',
  'full',
  'middle',
  'maiden',
  'user',
  'nick',
  'display',
  'given',
  'family',
  'sur',
  'contact',
  'customer',
]);

const EMAIL_LOCAL_CHAR = /[\p{L}\p{N}._%+'-]/u;
const EMAIL_AFTER_AT = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/**
 * Start and end offsets of the email addresses in a string. Scans from each
 * `@`, so it stays linear on large text (a plain regex can take seconds on a
 * big HTML string).
 */
function emailSpans(text: string, limit = Infinity): [number, number][] {
  const spans: [number, number][] = [];
  for (
    let at = text.indexOf('@');
    at !== -1 && spans.length < limit;
    at = text.indexOf('@', at + 1)
  ) {
    let start = at;
    while (
      start > 0 &&
      at - start < 64 &&
      EMAIL_LOCAL_CHAR.test(text[start - 1] ?? '')
    ) {
      start--;
    }
    while (start < at && (text[start] === '.' || text[start] === "'")) start++;
    const domain = EMAIL_AFTER_AT.exec(text.slice(at + 1, at + 256));
    if (start >= at || !domain) continue;

    const end = at + 1 + domain[0].length;
    // Not an email: `git@host:repo`, or the user info of a URL
    // (`https://user@host/path`, `mongodb://u:p@host`).
    const next = text[end];
    // `git@github.com:org/repo`, but not `jane@x.com: urgent`.
    const isHost = next === ':' && /[\w~/.]/.test(text[end + 1] ?? '');
    const isUserInfo = /\/\/[^\s/]*$/.test(
      text.slice(Math.max(0, start - 256), start),
    );
    if (!isHost && !isUserInfo) {
      spans.push([start, end]);
    }
  }
  return spans;
}

function containsEmail(text: string): boolean {
  return emailSpans(text, 1).length > 0;
}

function holdsEmail(value: unknown): boolean {
  if (typeof value === 'string') return containsEmail(value);
  return (
    Array.isArray(value) &&
    value.some((item) => typeof item === 'string' && containsEmail(item))
  );
}

/** Words that may follow a personal word without changing its meaning (`phoneNo`, `emailList`). */
const TRAILING_WORDS = new Set([
  'no',
  'nr',
  'num',
  'number',
  'list',
  'addr',
  // A hashed password or token is still a credential.
  'hash',
  'digest',
  'salt',
]);

/** Words that turn a following `key` into a credential (`apiKey`, `private_key`). */
const KEY_QUALIFIERS = new Set([
  'api',
  'secret',
  'private',
  'access',
  'signing',
  'encryption',
]);

/** `homeCity` → home, city; `IPAddress` → ip, address; `date_of_birth` → date, of, birth. */
function words(key: string): string[] {
  return key
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * The key names a personal value: a personal word that is the last word, or
 * is only followed by words like `no` or `list`. So `orderEmail` and
 * `phoneNo` count, `emailTemplate` and `emailVerified` don't.
 */
function looksPersonal(key: string): boolean {
  const parts = words(key);
  let end = parts.length;
  while (end > 1 && TRAILING_WORDS.has(parts[end - 1] ?? '')) end--;

  const last = parts[end - 1] ?? '';
  const previous = parts[end - 2] ?? '';
  return (
    PERSONAL_WORDS.has(last) ||
    (last === 'name' && (end === 1 || NAME_QUALIFIERS.has(previous))) ||
    (last === 'key' && KEY_QUALIFIERS.has(previous)) ||
    (last === 'salt' && end === 1)
  );
}

const COORDINATE_WORDS = new Set(['lat', 'lng', 'latitude', 'longitude']);

/** The key holds a coordinate (`lat`, `homeLatitude`), whose value is a number. */
function isCoordinateKey(key: string): boolean {
  return COORDINATE_WORDS.has(words(key).at(-1) ?? '');
}

/** Replacement that keeps a field unchanged, e.g. `images.name:keep` to override a global `name` rule. */
export const KEEP = 'keep';

const NO_RULES = new CollectionRules([]);

const RESERVED_REPLACEMENTS = new Set([KEEP, 'null']);

/** Keys whose values may be lists of addresses (`to: 'Jane <j@x.com>, bob@y.com'`). */
const ADDRESS_KEY = /(recipients?|sender|^to|^cc|^bcc|^from|^replyto)$/;

export interface AnonymizerOptions {
  /**
   * Secret used to derive fake values. The same secret always maps the same
   * original value to the same fake value (across collections and runs), and
   * without it the mapping cannot be reversed by hashing guesses.
   * A random secret is used when none is given.
   */
  secret?: string;
  /**
   * Throw instead of warning when a matched value can't be anonymized
   * (ObjectId, Binary, Decimal128, invalid dates, ...), so no personal data
   * is left behind silently.
   */
  strict?: boolean;
  /**
   * Replace email addresses found in any string, including fields no rule
   * matches and free text, with the same fake email they get everywhere else.
   * On by default.
   */
  scrubEmails?: boolean;
}

interface LeafGenerator {
  generator: Generator;
  /** Chosen by the user (`field:faker.x.y`): applied whatever the value's type. */
  explicit: boolean;
}

export class Anonymizer {
  readonly #secret: string;
  readonly #strict: boolean;
  readonly #scrubEmails: boolean;
  readonly #faker = new Faker({
    locale: [en, base],
    randomizer: sfc32Randomizer(),
  });
  readonly #warnedUnsupported = new Set<string>();
  #onWarning: (message: string) => void = () => {};

  constructor(options: AnonymizerOptions = {}) {
    // An empty secret would be a known key: treat it like no secret at all.
    this.#secret = options.secret || randomBytes(32).toString('hex');
    this.#strict = options.strict ?? false;
    this.#scrubEmails = options.scrubEmails ?? true;
    // Also covers faker.date.* replacements, which get no explicit refDate.
    this.#faker.setDefaultRefDate(REFERENCE_DATE);
  }

  onWarning(handler: (message: string) => void): this {
    this.#onWarning = handler;
    return this;
  }

  /**
   * Throws for rules whose replacement can never be applied, before any data
   * is written. Faker replacements are called once, since some methods only
   * fail when called without arguments.
   */
  validateRules(rules: Iterable<FieldRule>): void {
    for (const rule of rules) {
      if (rule.replacement === null || rule.replacement === KEEP) continue;

      const lower = rule.replacement.trim().toLowerCase();
      if (RESERVED_REPLACEMENTS.has(lower) && rule.replacement !== lower) {
        throw new Error(
          `Replacement "${rule.replacement}" for ${rule.field}: did you mean "${lower}"? Reserved words are lower-case; anything else is used as literal text.`,
        );
      }

      const replacement = this.#literalOrGenerator(rule.replacement);
      if (replacement.kind === 'generator') {
        try {
          replacement.generator(this.#faker, this.#seed('validation'));
        } catch (error) {
          throw new Error(
            `Replacement "${rule.replacement}" fails when called without arguments: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }
    }
  }

  /**
   * Anonymizes every document in the batch. `rules` are the rules that apply
   * to the batch's collection, keyed by lower-cased field name.
   */
  anonymizeBatch<T>(batch: T[], rules: CollectionRules): T[] {
    return batch.map((document) => this.anonymizeDocument(document, rules));
  }

  /**
   * Anonymizes one document. `_id` is never matched as a whole, but values
   * inside a compound `_id` are anonymized like any other subdocument.
   */
  anonymizeDocument<T>(document: T, rules: CollectionRules): T {
    return this.#walk(document, rules) as T;
  }

  /**
   * Dotted paths of keys that no rule covers but that look like personal
   * data, either by name (`profile.phoneNumber`) or because their text
   * contains an email address (`notes`, `message`). Array indexes are left out.
   */
  findUnmatchedPersonalKeys(
    document: unknown,
    rules: CollectionRules,
  ): Set<string> {
    const found = new Set<string>();
    const visit = (value: unknown, path: string, rules: CollectionRules) => {
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, path, rules));
        return;
      }
      if (!isPlainObject(value)) return;

      for (const [key, child] of Object.entries(value)) {
        const childPath = path ? `${path}.${key}` : key;
        const rule = rules.match(key);
        if (rule) {
          // A kept field is written as it is, so what's inside still counts.
          if (rule.replacement === KEEP) visit(child, childPath, NO_RULES);
          continue;
        }
        // Booleans and numbers (`sendEmail: true`) are flags or counts, not
        // personal data; coordinates (`lat: 46.77`) are the exception.
        const isFlag =
          typeof child === 'boolean' ||
          (typeof child === 'number' && !isCoordinateKey(key));
        if (
          key !== '_id' &&
          !isFlag &&
          (looksPersonal(key) || (!this.#scrubEmails && holdsEmail(child)))
        ) {
          found.add(childPath);
        }
        visit(child, childPath, rules);
      }
    };
    visit(document, '', rules);
    return found;
  }

  /** Looks for matching keys at any depth; everything else is kept as-is. */
  #walk(value: unknown, rules: CollectionRules): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.#walk(item, rules));
    }
    if (typeof value === 'string' && this.#scrubEmails) {
      // `Jane Doe <jane@x.com>` (e.g. in `to` or `headers.From`): fake the name too.
      if (value.includes('<') && containsEmail(value)) {
        const list = this.#fakeAddressList(value);
        if (list !== null) return list;
      }
      return this.#replaceEmails(value);
    }
    if (!isPlainObject(value)) {
      return value;
    }

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const rule = key === '_id' ? undefined : rules.match(key);
      result[key] = rule
        ? this.#anonymizeMatched(child, key, rule, rules)
        : this.#walk(child, rules);
    }
    return result;
  }

  #anonymizeMatched(
    value: unknown,
    key: string,
    rule: FieldRule,
    rules: CollectionRules,
  ): unknown {
    if (rule.replacement === KEEP) {
      // The whole value is kept, subdocuments included; only emails inside
      // are still scrubbed.
      return this.#walk(value, NO_RULES);
    }
    if (rule.replacement !== null) {
      const replacement = this.#literalOrGenerator(rule.replacement);
      if (replacement.kind === 'literal') {
        return replacement.value;
      }
      const leaf = { generator: replacement.generator, explicit: true };
      return this.#mapLeaves(value, key, rules, () => leaf);
    }

    const parentGenerator =
      generatorFor(normalizeKey(key)) ?? fallbackGenerator;
    return this.#mapLeaves(value, key, rules, (leafKey) => ({
      generator: generatorFor(normalizeKey(leafKey)) ?? parentGenerator,
      explicit: false,
    }));
  }

  /**
   * Replaces every leaf under a matched field. A nested key with a rule of
   * its own follows that rule (e.g. `city:REDACTED` inside a matched
   * `address`). Other leaves use the generator for their own key when it is
   * recognised, and the matched field's generator otherwise.
   */
  #mapLeaves(
    value: unknown,
    key: string,
    rules: CollectionRules,
    pickGenerator: (leafKey: string) => LeafGenerator,
  ): unknown {
    if (Array.isArray(value)) {
      if (
        isCoordinatePair(value) &&
        GEO_KEY.test(normalizeKey(key)) &&
        !pickGenerator(key).explicit
      ) {
        return this.#fakePosition(value);
      }
      return value.map((item) =>
        this.#mapLeaves(item, key, rules, pickGenerator),
      );
    }
    if (isPlainObject(value)) {
      if (isGeoJson(value)) {
        return this.#fakeGeoJson(value, key, rules, pickGenerator);
      }
      const result: Record<string, unknown> = {};
      for (const [childKey, child] of Object.entries(value)) {
        if (childKey === '_id') {
          // Subdocument ids (e.g. Mongoose's) are kept like the document's own.
          result[childKey] = this.#walk(child, rules);
          continue;
        }
        const rule = rules.match(childKey);
        if (rule) {
          result[childKey] = this.#anonymizeMatched(
            child,
            childKey,
            rule,
            rules,
          );
        } else if (
          STRUCTURAL_KEYS.has(childKey.toLowerCase()) &&
          typeof child === 'string'
        ) {
          // Kept, like an unmatched value: only emails in it are replaced.
          result[childKey] = this.#walk(child, NO_RULES);
        } else {
          result[childKey] = this.#mapLeaves(
            child,
            childKey,
            rules,
            pickGenerator,
          );
        }
      }
      return result;
    }
    return this.#fakeLeaf(value, key, pickGenerator(key));
  }

  #fakeLeaf(
    value: unknown,
    key: string,
    { generator, explicit }: LeafGenerator,
  ): unknown {
    if (
      value === null ||
      value === undefined ||
      value === '' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      return value;
    }
    const seedHex = this.#seed(value);

    if (explicit) {
      return generator(this.#faker, seedHex);
    }

    if (value instanceof Date && Number.isNaN(value.getTime())) {
      return this.#unsupported(value, key);
    }

    if (typeof value === 'number') {
      const normalized = normalizeKey(key);
      return isLatitudeKey(normalized) || isLongitudeKey(normalized)
        ? generator(this.#faker, seedHex)
        : sameMagnitudeNumber(this.#faker, value);
    }

    if (value instanceof Date) {
      const generated = generator(this.#faker, seedHex);
      return generated instanceof Date
        ? generated
        : this.#faker.date.past({ refDate: REFERENCE_DATE });
    }

    if (typeof value === 'string') {
      // An email stays an email (and the same one) under any field name, e.g. `recipient`.
      const address = this.#fakeAddress(value.trim());
      if (address !== null) return address;
      if (
        (generator === emailGenerator || ADDRESS_KEY.test(normalizeKey(key))) &&
        containsEmail(value)
      ) {
        const list = this.#fakeAddressList(value);
        if (list !== null) return list;
      }
      const generated = generator(this.#faker, seedHex);
      if (generated instanceof Date) return generated.toISOString();
      return typeof generated === 'string'
        ? generated
        : JSON.stringify(generated);
    }

    return this.#unsupported(value, key);
  }

  /** ObjectId, Binary, Decimal128, invalid dates, ...: there is no sensible fake of the same type. */
  #unsupported(value: unknown, key: string): unknown {
    const type =
      value instanceof Date
        ? 'invalid Date'
        : ((value as object | undefined)?.constructor?.name ?? typeof value);
    const hint = `If the field holds references rather than personal data, remove its rule (e.g. --fieldList -${key}); otherwise overwrite it with a replacement such as "${key}:null".`;

    if (this.#strict) {
      throw new Error(
        `Field "${key}" holds a value of unsupported type ${type} (--strict). ${hint}`,
      );
    }
    if (!this.#warnedUnsupported.has(key)) {
      this.#warnedUnsupported.add(key);
      this.#onWarning(
        `Field "${key}" holds a value of unsupported type ${type}; it was left unchanged. ${hint}`,
      );
    }
    return value;
  }

  /**
   * A GeoJSON object under a matched field keeps its type, a Point gets a
   * fake but valid position (so geo indexes still build), other geometries
   * keep their coordinates, and every other key goes through the usual rules.
   */
  #fakeGeoJson(
    value: { type: string; coordinates: unknown[] },
    key: string,
    rules: CollectionRules,
    pickGenerator: (leafKey: string) => LeafGenerator,
  ): Record<string, unknown> {
    const { type, coordinates, ...others } = value;
    const rest = this.#mapLeaves(others, key, rules, pickGenerator) as Record<
      string,
      unknown
    >;

    const result: Record<string, unknown> = {};
    for (const field of Object.keys(value)) {
      if (field === 'type') {
        result.type = type;
      } else if (field === 'coordinates') {
        result.coordinates = this.#fakeGeometry(type, coordinates);
      } else {
        result[field] = rest[field];
      }
    }
    return result;
  }

  /**
   * Point: a fake position. Other geometries (a GPS track, a home area...):
   * a small valid shape of the same type around a fake position, so the real
   * coordinates don't reach the target and geo indexes still build.
   */
  #fakeGeometry(type: string, coordinates: unknown[]): unknown {
    if (type === 'Point') {
      const [lng, lat, ...extra] = coordinates;
      return typeof lng === 'number' && typeof lat === 'number'
        ? [...this.#fakePosition([lng, lat]), ...extra]
        : coordinates;
    }

    this.#seed(JSON.stringify(coordinates));
    const [lng, lat] = this.#randomPosition();
    const d = 0.001;
    const line = [
      [lng, lat],
      [lng + d, lat + d],
    ];
    const ring = [
      [lng, lat],
      [lng + d, lat],
      [lng + d, lat + d],
      [lng, lat],
    ];
    switch (type) {
      case 'MultiPoint':
        return [[lng, lat]];
      case 'LineString':
        return line;
      case 'MultiLineString':
        return [line];
      case 'Polygon':
        return [ring];
      case 'MultiPolygon':
        return [[ring]];
      default:
        return coordinates;
    }
  }

  /** A fake `[longitude, latitude]` for a position, the same for the same position. */
  #fakePosition([lng, lat]: [number, number]): [number, number] {
    this.#seed(`${lng},${lat}`);
    return this.#randomPosition();
  }

  /** Kept a little away from the poles and the antimeridian, so small shapes stay valid. */
  #randomPosition(): [number, number] {
    return [
      this.#faker.location.longitude({ min: -179, max: 179 }),
      this.#faker.location.latitude({ min: -89, max: 89 }),
    ];
  }

  /**
   * `Jane <jane@x.com>, bob@y.com; mailto:rick@z.com`: every address gets the
   * same fake email as anywhere else and every name a fake name; separators
   * are kept. Null when some item isn't an address, so the caller replaces
   * the whole value instead.
   */
  #fakeAddressList(value: string): string | null {
    const items: string[] = [];
    const separators: string[] = [];
    let current = '';
    let quoted = false;
    for (let i = 0; i < value.length; i++) {
      const char = value[i] ?? '';
      if (char === '"') quoted = !quoted;
      if (!quoted && (char === ',' || char === ';')) {
        let separator = char;
        while (value[i + 1] === ' ') separator += value[++i];
        items.push(current);
        separators.push(separator);
        current = '';
      } else {
        current += char;
      }
    }
    items.push(current);

    const faked: string[] = [];
    for (const item of items) {
      const address = this.#fakeAddress(item.trim());
      if (address === null) return null;
      faked.push(address);
    }
    return faked.map((item, i) => item + (separators[i] ?? '')).join('');
  }

  /** One address: `jane@x.com`, `<jane@x.com>`, `Jane <jane@x.com>`, `mailto:jane@x.com`. */
  #fakeAddress(item: string): string | null {
    const mailto = /^mailto:/i.exec(item);
    if (mailto) {
      const rest = this.#fakeAddress(item.slice(mailto[0].length));
      return rest === null ? null : `${mailto[0]}${rest}`;
    }
    const named = NAMED_EMAIL.exec(item);
    if (named?.[2] && isEmailAddress(named[2])) {
      const email = this.#fakeEmail(normalizeEmail(named[2]));
      const name = named[1]?.trim();
      if (!name) return `<${email}>`;
      this.#seed(name);
      return `${this.#faker.person.fullName()} <${email}>`;
    }
    return isEmailAddress(item) ? this.#fakeEmail(normalizeEmail(item)) : null;
  }

  /** The fake email for an email address: the same wherever the address appears. */
  #fakeEmail(email: string): string {
    return emailGenerator(this.#faker, this.#seed(email));
  }

  /** Replaces every email address inside a string, keeping the text around it. */
  #replaceEmails(text: string): string {
    const spans = emailSpans(text);
    if (spans.length === 0) return text;

    let result = '';
    let last = 0;
    for (const [start, end] of spans) {
      result +=
        text.slice(last, start) + this.#fakeEmail(text.slice(start, end));
      last = end;
    }
    return result + text.slice(last);
  }

  /** Seeds faker from HMAC(secret, value) and returns the digest as hex. */
  #seed(value: unknown): string {
    const digest = createHmac('sha256', this.#secret)
      .update(canonical(value))
      .digest();
    this.#faker.seed([
      digest.readUInt32BE(0),
      digest.readUInt32BE(4),
      digest.readUInt32BE(8),
      digest.readUInt32BE(12),
    ]);
    return digest.toString('hex');
  }

  #literalOrGenerator(
    replacement: string,
  ):
    | { kind: 'literal'; value: unknown }
    | { kind: 'generator'; generator: Generator } {
    if (replacement.startsWith('faker.')) {
      return {
        kind: 'generator',
        generator: fakerMethod(this.#faker, replacement),
      };
    }

    switch (replacement) {
      case '[]':
        return { kind: 'literal', value: [] };
      case '{}':
        return { kind: 'literal', value: {} };
      case 'null':
        return { kind: 'literal', value: null };
    }

    if (replacement.startsWith('[') || replacement.startsWith('{')) {
      try {
        return {
          kind: 'literal',
          value: JSON.parse(decodeURIComponent(replacement)),
        };
      } catch (error) {
        throw new Error(
          `Failed to parse replacement JSON: ${(error as Error).message}`,
          { cause: error },
        );
      }
    }

    return { kind: 'literal', value: replacement };
  }
}

function fakerMethod(faker: Faker, replacement: string): Generator {
  const parts = replacement.split('.');
  if (parts.length !== 3) {
    throw new Error(
      `Invalid format for replacement: ${replacement}. Expected format 'faker.category.method'`,
    );
  }

  const [, category = '', method = ''] = parts;
  const fakerCategory = (
    faker as unknown as Record<string, Record<string, unknown> | undefined>
  )[category];
  if (!fakerCategory || typeof fakerCategory !== 'object') {
    throw new Error(`Invalid faker category: ${category}`);
  }

  const fn = fakerCategory[method];
  if (typeof fn !== 'function') {
    throw new Error(`Invalid faker method: ${method} in category ${category}`);
  }

  return (instance) => {
    const target = (
      instance as unknown as Record<string, Record<string, unknown>>
    )[category];
    return (target?.[method] as () => unknown).call(target);
  };
}
