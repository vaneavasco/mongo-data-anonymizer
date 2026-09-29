import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FIELDS,
  getFieldList,
  parseFieldRule,
  rulesForCollection,
} from '../../src/anonymization/rules.ts';

describe('parseFieldRule', () => {
  it('parses a global field', () => {
    expect(parseFieldRule('Email')).toEqual({
      collection: null,
      field: 'email',
      replacement: null,
      pattern: null,
    });
  });

  it('parses a collection-scoped field with a replacement', () => {
    expect(parseFieldRule('users.email:faker.internet.email')).toMatchObject({
      collection: 'users',
      field: 'email',
      replacement: 'faker.internet.email',
    });
  });

  it('keeps colons inside the replacement', () => {
    expect(parseFieldRule('users.website:http://example.com').replacement).toBe(
      'http://example.com',
    );
  });

  it('accepts collection names with dashes, digits and dots', () => {
    expect(parseFieldRule('user-profiles2.email')).toMatchObject({
      collection: 'user-profiles2',
    });
    expect(parseFieldRule('app.users.email')).toMatchObject({
      collection: 'app.users',
      field: 'email',
    });
  });

  it('turns * into a wildcard', () => {
    const { pattern } = parseFieldRule('users.*Email*:null');

    expect(pattern?.test('orderemail')).toBe(true);
    expect(pattern?.test('emailtemplate')).toBe(true);
    expect(pattern?.test('mail')).toBe(false);
  });

  it('rejects a rule without a field name', () => {
    expect(() => parseFieldRule('users.')).toThrow(/missing field name/);
  });
});

describe('getFieldList', () => {
  const defaults = ['field1', 'field2', 'field3'];

  it('returns the defaults when nothing is given', () => {
    expect(getFieldList(undefined, defaults)).toEqual(defaults);
    expect(getFieldList('', defaults)).toEqual(defaults);
    expect(getFieldList(undefined)).toEqual(DEFAULT_FIELDS);
  });

  it('replaces the defaults with explicit fields', () => {
    expect(getFieldList('a,b', defaults)).toEqual(['a', 'b']);
  });

  it('adds and removes fields per item', () => {
    expect(getFieldList('+age,-field1', defaults)).toEqual([
      'field2',
      'field3',
      'age',
    ]);
  });

  it('removes a field regardless of its replacement', () => {
    expect(getFieldList('-field1', ['field1:null', 'field2'])).toEqual([
      'field2',
    ]);
  });

  it('refuses to remove a rule that does not exist', () => {
    expect(() => getFieldList('-email')).toThrow(
      /removes rules that don't exist: -email.*-\*email/,
    );
  });

  it('ignores whitespace, empty items and duplicates', () => {
    expect(getFieldList(' a , ,a,+b ', defaults)).toEqual(['a', 'b']);
  });
});

describe('rulesForCollection', () => {
  const rules = ['email', 'users.email:null', 'orders.total', '*phone'].map(
    parseFieldRule,
  );

  it('prefers collection-scoped rules over global ones', () => {
    expect(rulesForCollection(rules, 'users').match('Email')?.replacement).toBe(
      'null',
    );
    expect(
      rulesForCollection(rules, 'orders').match('email')?.replacement,
    ).toBeNull();
  });

  it('only includes global rules and rules for the collection', () => {
    expect(rulesForCollection(rules, 'customers').fields).toEqual([
      'email',
      '*phone',
    ]);
    expect(rulesForCollection(rules, 'orders').match('total')).toBeDefined();
    expect(
      rulesForCollection(rules, 'customers').match('total'),
    ).toBeUndefined();
  });

  it('prefers a collection pattern over a global exact rule', () => {
    const all = ['name', 'users.*name:REDACTED'].map(parseFieldRule);
    expect(rulesForCollection(all, 'users').match('name')?.replacement).toBe(
      'REDACTED',
    );
    expect(
      rulesForCollection(all, 'orders').match('name')?.replacement,
    ).toBeNull();
  });

  it('does not list a global field that a collection keeps', () => {
    expect(
      rulesForCollection(
        ['name', 'description', 'images.name:keep'].map(parseFieldRule),
        'images',
      ).fields,
    ).toEqual(['description']);
  });

  it('does not list kept fields as anonymized', () => {
    expect(
      rulesForCollection(
        ['name', 'users.images:keep'].map(parseFieldRule),
        'users',
      ).fields,
    ).toEqual(['name']);
  });

  it('ignores _ and - in key names', () => {
    const defaults = rulesForCollection(
      DEFAULT_FIELDS.map(parseFieldRule),
      'x',
    );
    for (const key of [
      'api_key',
      'secret_key',
      'private_key',
      'token_hash',
      'first_name',
      'last_name',
      'full_name',
      'user_name',
      'phone_number',
      'zip_code',
      'postal-code',
      'date_of_birth',
      'e_mail',
    ]) {
      expect(defaults.match(key), key).toBeDefined();
    }
    expect(
      rulesForCollection([parseFieldRule('users.first_name:X')], 'users').match(
        'firstName',
      )?.replacement,
    ).toBe('X');
  });

  it('matches patterns case-insensitively', () => {
    expect(rulesForCollection(rules, 'x').match('mainGuestPhone')?.field).toBe(
      '*phone',
    );
  });
});

describe('DEFAULT_FIELDS', () => {
  const defaults = rulesForCollection(DEFAULT_FIELDS.map(parseFieldRule), 'x');

  it.each([
    'email',
    'orderEmail',
    'guestEmail',
    'emails',
    'recipient',
    'displayName',
    'phoneNo',
    'phoneNumber',
    'mobile',
    'billingAddress',
    'IPAddress',
    'zipCode',
    'postalCode',
    'dateOfBirth',
    'password',
    'refreshToken',
    'notes',
    'passwordHash',
    'passwordSalt',
    'passwordResetToken',
    'hashedPassword',
    'tokenHash',
    'refreshTokenHash',
    'apiKey',
    'secretKey',
    'clientSecret',
    'salt',
  ])('covers %s', (key) => {
    expect(defaults.match(key)).toBeDefined();
  });

  it.each([
    'emailTemplate',
    'emailVerified',
    'emailType',
    'productName',
    'fileName',
    'createdAt',
    'status',
    'tokenType',
  ])('leaves %s alone', (key) => {
    expect(defaults.match(key)).toBeUndefined();
  });
});
