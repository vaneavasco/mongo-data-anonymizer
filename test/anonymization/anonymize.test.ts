import { Decimal128, ObjectId } from 'mongodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Anonymizer } from '../../src/anonymization/anonymize.ts';
import {
  parseFieldRule,
  rulesForCollection,
} from '../../src/anonymization/rules.ts';

function rules(...specs: string[]) {
  return rulesForCollection(specs.map(parseFieldRule), 'users');
}

function anonymize(document: Record<string, unknown>, ...specs: string[]) {
  return new Anonymizer({ secret: 'test-secret' }).anonymizeDocument(
    document,
    rules(...specs),
  );
}

describe('Anonymizer', () => {
  describe('matching', () => {
    it('matches field names case-insensitively and leaves other fields alone', () => {
      const result = anonymize({ Email: 'john@x.com', age: 42 }, 'email');

      expect(result.Email).not.toBe('john@x.com');
      expect(result.age).toBe(42);
    });

    it('finds fields nested under keys that are not in the list', () => {
      const result = anonymize(
        { profile: { email: 'nested@x.com', name: 'John Doe', role: 'admin' } },
        'email',
        'name',
      ) as { profile: Record<string, unknown> };

      expect(result.profile.email).not.toBe('nested@x.com');
      expect(result.profile.name).not.toBe('John Doe');
      expect(result.profile.role).toBe('admin');
    });

    it('finds fields inside arrays of subdocuments', () => {
      const result = anonymize(
        { contacts: [{ email: 'a@x.com' }, { email: 'b@x.com' }] },
        'email',
      ) as {
        contacts: { email: string }[];
      };

      expect(result.contacts.map((contact) => contact.email)).not.toContain(
        'a@x.com',
      );
      expect(result.contacts.map((contact) => contact.email)).not.toContain(
        'b@x.com',
      );
    });

    it('anonymizes every leaf under a matched subdocument', () => {
      const result = anonymize(
        {
          address: {
            street: '5 Real St',
            city: 'Paris',
            zip: '75001',
            line2: 'Apt 4',
          },
        },
        'address',
      ) as { address: Record<string, string> };

      expect(result.address.street).not.toBe('5 Real St');
      expect(result.address.city).not.toBe('Paris');
      expect(result.address.zip).not.toBe('75001');
      expect(result.address.line2).not.toBe('Apt 4');
    });

    it('never matches _id as a whole', () => {
      const _id = new ObjectId();
      expect(anonymize({ _id }, '_id')._id).toBe(_id);
    });

    it('anonymizes personal data inside a compound _id, deterministically', () => {
      const result = anonymize(
        { _id: { email: 'john@x.com', tenant: 1 }, email: 'john@x.com' },
        'email',
      ) as { _id: { email: string; tenant: number }; email: string };

      expect(result._id.email).toBe(result.email);
      expect(result._id.email).not.toBe('john@x.com');
      expect(result._id.tenant).toBe(1);
    });

    it('keeps subdocument _ids under a matched field, even in strict mode', () => {
      const warnings: string[] = [];
      const strict = new Anonymizer({ secret: 's', strict: true }).onWarning(
        (message) => warnings.push(message),
      );
      const _id = new ObjectId();
      const otherId = new ObjectId();

      const result = strict.anonymizeDocument(
        {
          address: { _id, street: '5 Real St' },
          addresses: [{ _id: otherId, street: '6 Real St' }],
        },
        rules('address', 'addresses'),
      );

      expect(result.address._id).toBe(_id);
      expect(result.address.street).not.toBe('5 Real St');
      expect(result.addresses[0]?._id).toBe(otherId);
      expect(warnings).toEqual([]);
    });

    it('applies rules of keys nested under a matched subdocument', () => {
      const result = anonymize(
        { address: { street: '5 Real St', city: 'Paris' } },
        'address',
        'city:REDACTED',
      ) as { address: Record<string, string> };

      expect(result.address.city).toBe('REDACTED');
      expect(result.address.street).not.toBe('5 Real St');
    });

    it('handles arrays of arrays', () => {
      const result = anonymize(
        { email: [['a@x.com'], ['b@x.com']] },
        'email',
      ) as { email: string[][] };

      expect(result.email.flat()).toHaveLength(2);
      expect(result.email.flat()).not.toContain('a@x.com');
    });
  });

  describe('value types', () => {
    it('keeps a Date a Date', () => {
      const original = new Date('1990-01-01');
      const result = anonymize({ birthdate: original }, 'birthdate');

      expect(result.birthdate).toBeInstanceOf(Date);
      expect((result.birthdate as Date).getTime()).not.toBe(original.getTime());
    });

    it('keeps null, undefined and booleans', () => {
      expect(
        anonymize(
          { phone: null, name: undefined, email: true },
          'phone',
          'name',
          'email',
        ),
      ).toEqual({
        phone: null,
        name: undefined,
        email: true,
      });
    });

    it('keeps empty arrays and objects', () => {
      expect(anonymize({ name: [], address: {} }, 'name', 'address')).toEqual({
        name: [],
        address: {},
      });
    });

    it('anonymizes each string in an array of strings', () => {
      const result = anonymize(
        { email: ['john@x.com', 'jane@x.com'] },
        'email',
      );

      expect(result.email).toHaveLength(2);
      for (const email of result.email as unknown[]) {
        expect(typeof email).toBe('string');
        expect(email).toMatch(/@example\.com$/);
      }
    });

    it('replaces numbers with numbers of the same magnitude', () => {
      const result = anonymize(
        { phone: 40712345678, zip: -12.5 },
        'phone',
        'zip',
      );

      expect(typeof result.phone).toBe('number');
      expect(String(result.phone)).toHaveLength(11);
      expect(result.zip).toBeLessThan(0);
    });

    it('keeps fractions below one below one, and NaN/Infinity as they are', () => {
      const result = anonymize(
        { phone: 0.5, zip: NaN, city: Infinity },
        'phone',
        'zip',
        'city',
      );

      expect(result.phone).toBeGreaterThanOrEqual(0);
      expect(result.phone).toBeLessThan(1);
      expect(result.zip).toBeNaN();
      expect(result.city).toBe(Infinity);
    });

    it('leaves unsupported BSON values unchanged and warns once per field', () => {
      const warnings: string[] = [];
      const anonymizer = new Anonymizer({ secret: 's' }).onWarning((message) =>
        warnings.push(message),
      );
      const id = new ObjectId();

      const result = anonymizer.anonymizeBatch(
        [{ name: id }, { name: id }],
        rules('name'),
      );

      expect(result[0]?.name).toBe(id);
      expect(warnings).toHaveLength(1);
    });

    it('keeps empty strings empty', () => {
      expect(anonymize({ email: '', name: '' }, 'email', 'name')).toEqual({
        email: '',
        name: '',
      });
    });

    it('leaves invalid dates unchanged with a warning instead of crashing', () => {
      const warnings: string[] = [];
      const invalid = new Date(NaN);
      const result = new Anonymizer({ secret: 's' })
        .onWarning((message) => warnings.push(message))
        .anonymizeDocument({ birthdate: invalid }, rules('birthdate'));

      expect(result.birthdate).toBe(invalid);
      expect(warnings[0]).toMatch(/invalid Date/);
    });

    it('throws on unsupported values in strict mode', () => {
      const strict = new Anonymizer({ secret: 's', strict: true });

      expect(() =>
        strict.anonymizeDocument(
          { name: Decimal128.fromString('1.5') },
          rules('name'),
        ),
      ).toThrow(
        /unsupported type Decimal128 \(--strict\).*If the field holds references rather than personal data, remove its rule/,
      );
    });

    it('turns a Date into an ISO string when the field holds a date as text', () => {
      expect(
        anonymize({ birthdate: '1990-01-01' }, 'birthdate').birthdate,
      ).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe('determinism', () => {
    it('maps the same value to the same fake value with the same secret', () => {
      const first = new Anonymizer({ secret: 'k' });
      const second = new Anonymizer({ secret: 'k' });
      const document = {
        email: 'john@x.com',
        name: 'John',
        birthdate: new Date('1990-01-01'),
        phone: 123,
      };

      expect(
        first.anonymizeDocument(
          document,
          rules('email', 'name', 'birthdate', 'phone'),
        ),
      ).toEqual(
        second.anonymizeDocument(
          document,
          rules('email', 'name', 'birthdate', 'phone'),
        ),
      );
    });

    it('gives email values the same fake email whatever the field is called', () => {
      const result = anonymize(
        {
          email: 'john@x.com',
          recipient: ' John@x.com ',
          sender: 'john@x.com',
        },
        'email',
        'recipient',
        'sender',
      );

      expect(result.recipient).toMatch(/@example\.com$/);
      expect(result.sender).toBe(result.email);
    });

    it('is consistent across fields, collections and documents', () => {
      const anonymizer = new Anonymizer({ secret: 'k' });
      const [a, b] = anonymizer.anonymizeBatch(
        [{ email: 'john@x.com' }, { contact: { customerEmail: 'john@x.com' } }],
        rules('email', 'customerEmail'),
      );

      expect((b?.contact as { customerEmail: string }).customerEmail).toBe(
        a?.email,
      );
    });

    it('treats an empty secret as no secret, not as a known key', () => {
      const document = { email: 'john@x.com' };
      expect(
        new Anonymizer({ secret: '' }).anonymizeDocument(
          document,
          rules('email'),
        ),
      ).not.toEqual(
        new Anonymizer({ secret: '' }).anonymizeDocument(
          document,
          rules('email'),
        ),
      );
    });

    it('produces exactly these values for a known secret (release guard)', () => {
      // If this fails, every fake value changed: users rerunning with the same
      // secret would get different data. Only update it in a breaking release.
      const result = new Anonymizer({
        secret: 'pinned-secret',
      }).anonymizeDocument(
        {
          email: 'john@x.com',
          name: 'John Doe',
          phone: '+40 712 345 678',
          birthdate: new Date('1990-01-01T00:00:00Z'),
          city: 'Paris',
        },
        rules('email', 'name', 'phone', 'birthdate', 'city'),
      );

      expect(result).toEqual({
        email: 'terry.parisian.9b6adad4@example.com',
        name: 'Janelle Yundt DDS',
        phone: '1-505-742-1668',
        birthdate: new Date('2003-07-24T14:49:30.204Z'),
        city: 'Kelsiemouth',
      });
    });

    it('anonymizes a typical user document in well under a millisecond', () => {
      const anonymizer = new Anonymizer({ secret: 's' });
      const fields = rules(
        'email',
        'name',
        'firstname',
        'lastname',
        'phone',
        'city',
        'birthdate',
        '*address',
      );
      const documents = Array.from({ length: 5_000 }, (_, i) => ({
        email: `user${i}@x.com`,
        name: `User ${i}`,
        firstName: 'User',
        lastName: `${i}`,
        phone: `+40 7${i}`,
        city: 'Paris',
        birthdate: new Date(1990, 0, 1 + (i % 365)),
        billingAddress: { street: `${i} Main St`, city: 'Paris', zip: '75001' },
        plan: 'pro',
      }));

      const started = performance.now();
      anonymizer.anonymizeBatch(documents, fields);
      const microsPerDocument =
        ((performance.now() - started) * 1000) / documents.length;

      // Around 60 µs on a laptop; generous so slower CI machines pass. The
      // machine-independent speed check is in randomizer.test.ts.
      expect(microsPerDocument).toBeLessThan(1_000);
    });

    it('gives different results with a different secret', () => {
      const document = { email: 'john@x.com' };
      expect(
        new Anonymizer({ secret: 'a' }).anonymizeDocument(
          document,
          rules('email'),
        ),
      ).not.toEqual(
        new Anonymizer({ secret: 'b' }).anonymizeDocument(
          document,
          rules('email'),
        ),
      );
    });

    it('gives distinct usernames to distinct originals', () => {
      const anonymizer = new Anonymizer({ secret: 'k' });
      const batch = Array.from({ length: 20_000 }, (_, i) => ({
        username: `user${i}`,
      }));
      const usernames = anonymizer
        .anonymizeBatch(batch, rules('username'))
        .map((doc) => doc.username);

      expect(new Set(usernames).size).toBe(batch.length);
    });

    it('gives distinct emails to distinct originals', () => {
      const anonymizer = new Anonymizer({ secret: 'k' });
      const batch = Array.from({ length: 2000 }, (_, i) => ({
        email: `user${i}@x.com`,
      }));
      const emails = anonymizer
        .anonymizeBatch(batch, rules('email'))
        .map((doc) => doc.email);

      expect(new Set(emails).size).toBe(batch.length);
    });
  });

  describe('replacements', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('applies an explicit faker method to numbers, dates and BSON values too', () => {
      const result = anonymize(
        {
          phone: 123,
          birthdate: new Date('1990-01-01'),
          name: new ObjectId(),
        },
        'phone:faker.string.uuid',
        'birthdate:faker.string.uuid',
        'name:faker.string.uuid',
      );

      for (const value of Object.values(result)) {
        expect(value).toMatch(/^[0-9a-f-]{36}$/);
      }
    });

    it('applies an explicit faker method to an invalid date', () => {
      const result = new Anonymizer({
        secret: 's',
        strict: true,
      }).anonymizeDocument(
        { birthdate: new Date(NaN) },
        rules('birthdate:faker.string.uuid'),
      );

      expect(result.birthdate).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('does not depend on the current date for faker.date.* replacements', () => {
      const document = { createdAt: new Date('2020-01-01') };

      vi.useFakeTimers({ now: new Date('2026-01-01') });
      const first = anonymize(document, 'createdAt:faker.date.past');
      vi.setSystemTime(new Date('2030-06-01'));
      const second = anonymize(document, 'createdAt:faker.date.past');

      expect(second).toEqual(first);
    });

    it('rejects faker methods that need arguments up front', () => {
      expect(() =>
        new Anonymizer().validateRules([
          parseFieldRule('x:faker.helpers.arrayElement'),
        ]),
      ).toThrow(/fails when called without arguments/);
    });

    it.each([
      ['null', null],
      ['[]', []],
      ['{}', {}],
      ['{"key":"value"}', { key: 'value' }],
      ['[1%2C2]', [1, 2]],
      ['REDACTED', 'REDACTED'],
      ['http://example.com', 'http://example.com'],
    ])('replaces the whole value with %s', (replacement, expected) => {
      expect(
        anonymize({ notes: { a: 1 } }, `notes:${replacement}`).notes,
      ).toEqual(expected);
    });

    it('uses the given faker method, deterministically', () => {
      const first = anonymize(
        { email: ['a@x.com', 'b@x.com'] },
        'email:faker.person.jobTitle',
      );
      const second = anonymize(
        { email: ['a@x.com', 'b@x.com'] },
        'email:faker.person.jobTitle',
      );

      expect(first).toEqual(second);
      expect((first.email as string[])[0]).not.toContain('@');
    });

    it.each([
      ['[invalid-json', /Failed to parse replacement JSON/],
      ['faker.internet', /Expected format 'faker.category.method'/],
      [
        'faker.invalidCategory.method',
        /Invalid faker category: invalidCategory/,
      ],
      [
        'faker.internet.invalidMethod',
        /Invalid faker method: invalidMethod in category internet/,
      ],
    ])('rejects the invalid replacement %s up front', (replacement, error) => {
      expect(() =>
        new Anonymizer().validateRules([
          parseFieldRule(`email:${replacement}`),
        ]),
      ).toThrow(error);
    });
  });

  describe('structure inside a matched subdocument', () => {
    it('keeps GeoJSON valid and moves Point coordinates to valid positions', () => {
      const result = anonymize(
        {
          billingAddress: {
            street: '5 Real St',
            location: { type: 'Point', coordinates: [26.1025, 44.4268] },
            area: {
              type: 'Polygon',
              coordinates: [
                [
                  [0, 0],
                  [1, 0],
                  [1, 1],
                  [0, 0],
                ],
              ],
            },
          },
        },
        '*address',
      ) as {
        billingAddress: {
          location: { type: string; coordinates: number[] };
          area: { type: string };
        };
      };

      const { location, area } = result.billingAddress;
      expect(location.type).toBe('Point');
      const [lng = NaN, lat = NaN] = location.coordinates;
      expect(Math.abs(lng)).toBeLessThanOrEqual(180);
      expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      expect(location.coordinates).not.toEqual([26.1025, 44.4268]);
      expect(area.type).toBe('Polygon');
    });

    it('keeps type and kind values and fakes lat/lng within range', () => {
      const result = anonymize(
        {
          phones: [{ number: '+40 712 345 678', type: 'mobile' }],
          address: { kind: 'home', lat: 44.43, lng: 26.1, latitude: '44.43' },
        },
        '*phones',
        '*address',
      ) as {
        phones: { number: string; type: string }[];
        address: { kind: string; lat: number; lng: number; latitude: string };
      };

      expect(result.phones[0]?.type).toBe('mobile');
      expect(result.phones[0]?.number).not.toBe('+40 712 345 678');
      expect(result.address.kind).toBe('home');
      expect(Math.abs(result.address.lat)).toBeLessThanOrEqual(90);
      expect(Math.abs(result.address.lng)).toBeLessThanOrEqual(180);
      expect(result.address.lat).not.toBe(44.43);
      expect(Math.abs(Number(result.address.latitude))).toBeLessThanOrEqual(90);
    });
  });

  describe('geo data inside a matched subdocument', () => {
    it('anonymizes the other keys of a GeoJSON-shaped subdocument', () => {
      const result = anonymize(
        {
          address: {
            type: 'Point',
            coordinates: [23.6, 47.1],
            formattedAddress: '12 Main St, Iasi',
            city: 'Iasi',
            email: 'jane@x.com',
          },
        },
        '*address',
        'city',
        '*email',
      ) as { address: Record<string, unknown> };

      expect(result.address.type).toBe('Point');
      expect(result.address.formattedAddress).not.toBe('12 Main St, Iasi');
      expect(result.address.city).not.toBe('Iasi');
      expect(result.address.email).toMatch(/@example\.com$/);
    });

    it('replaces other geometries with a small valid shape at a fake position', () => {
      const ring = [
        [13.4, 52.5],
        [13.5, 52.5],
        [13.5, 52.6],
        [13.4, 52.5],
      ];
      const result = anonymize(
        {
          track: {
            type: 'LineString',
            coordinates: [
              [13.4, 52.5],
              [13.5, 52.6],
            ],
          },
          home: { type: 'Polygon', coordinates: [ring] },
        },
        'track',
        'home',
      ) as {
        track: { type: string; coordinates: number[][] };
        home: { type: string; coordinates: number[][][] };
      };

      expect(result.track.type).toBe('LineString');
      expect(result.track.coordinates).toHaveLength(2);
      expect(JSON.stringify(result.track.coordinates)).not.toContain('13.4');
      const [fakeRing = []] = result.home.coordinates;
      expect(fakeRing.length).toBeGreaterThanOrEqual(4);
      expect(fakeRing[0]).toEqual(fakeRing[fakeRing.length - 1]);
      expect(JSON.stringify(fakeRing)).not.toContain('52.5');
    });

    it('does not treat any object with type and coordinates as GeoJSON', () => {
      const result = anonymize(
        { address: { type: 'home', coordinates: [1, 2], street: '5 Real St' } },
        '*address',
      ) as { address: Record<string, unknown> };
      expect(result.address.street).not.toBe('5 Real St');
    });

    it('fakes legacy [lng, lat] pairs within valid ranges', () => {
      const result = anonymize(
        {
          address: {
            loc: [23.7, 41.1],
            coordinates: [-170.5, -85.2],
            floors: [1, 2],
          },
        },
        '*address',
      ) as {
        address: { loc: number[]; coordinates: number[]; floors: number[] };
      };

      for (const [lng = NaN, lat = NaN] of [
        result.address.loc,
        result.address.coordinates,
      ]) {
        expect(Math.abs(lng)).toBeLessThanOrEqual(180);
        expect(Math.abs(lat)).toBeLessThanOrEqual(90);
      }
      expect(result.address.loc).not.toEqual([23.7, 41.1]);
      // Not a geo key: each number is anonymized on its own, as integers.
      expect(result.address.floors.every(Number.isInteger)).toBe(true);
    });

    it('still scrubs emails in kept type/kind values', () => {
      const result = anonymize(
        { contact: { type: 'jane@x.com', kind: 'home' } },
        'contact',
      ) as { contact: Record<string, string> };
      expect(result.contact.type).toMatch(/@example\.com$/);
      expect(result.contact.kind).toBe('home');
    });
  });

  describe('names with email addresses', () => {
    it('keeps lists of addresses consistent and drops the names', () => {
      const result = anonymize(
        {
          email: 'jane@x.com',
          recipients:
            'Jane Doe <jane@x.com>, bob@y.com; "Roe, Rick" <rick@z.com>',
          contactEmail: 'mailto:jane@x.com',
        },
        'email',
        'recipients',
        '*email',
      ) as { email: string; recipients: string; contactEmail: string };

      expect(result.recipients).toContain(`<${result.email}>`);
      expect(result.recipients).not.toMatch(/Jane Doe|Roe|bob@y|rick@z/);
      expect(result.recipients.split(/[,;] /)).toHaveLength(3);
      expect(result.contactEmail).toBe(`mailto:${result.email}`);
    });

    it('gives "Name <email>" the same fake email as everywhere else', () => {
      const result = anonymize(
        {
          email: 'jane@x.com',
          recipient: 'Jane Doe <jane@x.com>',
          sender: '<jane@x.com>',
          cc: 'jane@x.com.',
        },
        'email',
        'recipient',
        'sender',
        'cc',
      ) as Record<string, string>;

      expect(result.recipient).toMatch(/^[^<@]+ <\S+@example\.com>$/);
      expect(result.recipient).toContain(`<${result.email}>`);
      expect(result.recipient).not.toContain('Jane Doe');
      expect(result.sender).toBe(`<${result.email}>`);
      expect(result.cc).toBe(result.email);
    });
  });

  describe(':keep', () => {
    it('keeps a field that a broader rule would anonymize, for one collection only', () => {
      const all = ['name', 'description', 'images.name:keep'].map(
        parseFieldRule,
      );
      const anonymizer = new Anonymizer({ secret: 's' });
      const document = { name: 'sunset.jpg', description: 'A photo' };

      const image = anonymizer.anonymizeDocument(
        document,
        rulesForCollection(all, 'images'),
      );
      expect(image.name).toBe('sunset.jpg');
      expect(image.description).not.toBe('A photo');
      expect(
        anonymizer.anonymizeDocument(document, rulesForCollection(all, 'users'))
          .name,
      ).not.toBe('sunset.jpg');
    });

    it('reports personal-looking keys inside a kept field in the dry run', () => {
      const found = new Anonymizer().findUnmatchedPersonalKeys(
        { images: { name: 'x.jpg', owner: { phone: '123' } } },
        rules('images:keep'),
      );
      expect([...found].sort()).toEqual(['images.name', 'images.owner.phone']);
    });

    it('lets a rule added by the user win over a default for the same field', () => {
      const result = new Anonymizer({ secret: 's' }).anonymizeDocument(
        { first_name: 'Jane' },
        rulesForCollection(
          ['firstname', 'first_name:REDACTED'].map(parseFieldRule),
          'users',
        ),
      );
      expect(result.first_name).toBe('REDACTED');
    });

    it.each(['KEEP', 'Keep', 'NULL', 'Null', ' keep', 'keep '])(
      'rejects the reserved word %s written in another case',
      (word) => {
        expect(() =>
          new Anonymizer().validateRules([parseFieldRule(`name:${word}`)]),
        ).toThrow(/did you mean/i);
      },
    );

    it('keeps everything inside a kept field, except that emails are still scrubbed', () => {
      const result = anonymize(
        {
          address: {
            city: 'Paris',
            street: '5 Real St',
            contact: 'owner@gmail.com',
            country: 'France',
          },
        },
        'address:keep',
        'street',
        'city',
      ) as { address: Record<string, string> };

      expect(result.address).toEqual({
        city: 'Paris',
        street: '5 Real St',
        contact: expect.stringMatching(/@example\.com$/) as string,
        country: 'France',
      });
    });
  });

  describe('scrubEmails', () => {
    it('replaces emails in fields no rule matches, keeping the text around them', () => {
      const result = anonymize(
        {
          email: 'jane.doe@yahoo.com',
          internalNote:
            'Call back or write to Jane.Doe@yahoo.com, then jane.doe@yahoo.com.',
          cc: ['jane.doe@yahoo.com'],
          meta: { messageId: '<abc123@mg.example.org>' },
          price: 10,
        },
        'email',
      ) as {
        email: string;
        internalNote: string;
        cc: string[];
        meta: { messageId: string };
        price: number;
      };

      expect(result.internalNote).toMatch(
        /^Call back or write to \S+@example\.com, then \S+@example\.com\.$/,
      );
      expect(result.internalNote).toContain(`then ${result.email}.`);
      expect(result.cc).toEqual([result.email]);
      expect(result.meta.messageId).toMatch(/^<\S+@example\.com>$/);
      expect(result.price).toBe(10);
    });

    it('fakes names next to addresses in fields no rule matches', () => {
      const result = anonymize(
        {
          email: 'jane@x.com',
          to: 'Jane Doe <jane@x.com>, Bob Smith <bob@y.com>',
          headers: { From: '"Doe, Jane" <jane@x.com>' },
          cc: ['Jane Doe <jane@x.com>'],
        },
        'email',
      ) as {
        email: string;
        to: string;
        headers: { From: string };
        cc: string[];
      };

      const all = JSON.stringify(result);
      expect(all).not.toMatch(/Jane|Doe|Bob|Smith|jane@x|bob@y/);
      expect(result.headers.From).toContain(`<${result.email}>`);
      expect(result.cc[0]).toContain(`<${result.email}>`);
    });

    it('leaves URLs, scp paths and connection strings intact', () => {
      const document = {
        repo: 'git@github.com:org/repo.git',
        deploy: 'deploy@host.example.org:/var/www',
        site: 'https://user@example.org/path',
        db: 'mongodb://u:p@db.example.org:27017/app',
        pkg: '@babel/core and lodash@4.17.21',
      };
      expect(anonymize(document)).toEqual(document);
    });

    it.each([
      'email jane@x.com: urgent',
      'from jane@x.com:',
      'see jane@x.com/profile',
      'jane@x.com/ joe@y.com',
      '<a href="mailto:jane@x.com">jane@x.com</a>',
      '[mail me](mailto:jane@x.com)',
      'Reply to jane@x.com:<br>thanks',
      'jane@x.com:&nbsp;more',
      'email me jane@x.com:)',
      'jane@x.com:"x"',
    ])('scrubs every address in %j', (text) => {
      const result = anonymize({ text }) as { text: string };
      expect(result.text).not.toMatch(/jane@x\.com|joe@y\.com/);
    });

    it('still scrubs mailto links and non-ASCII addresses', () => {
      const result = anonymize({
        link: 'mailto:jane@x.com',
        other: 'write to jösé@example.org',
      }) as Record<string, string>;

      expect(result.link).toMatch(/^mailto:\S+@example\.com$/);
      expect(result.other).toMatch(/^write to \S+@example\.com$/);
    });

    it('leaves text alone with scrubEmails turned off', () => {
      const document = { internalNote: 'write to jane@yahoo.com' };
      expect(
        new Anonymizer({ secret: 's', scrubEmails: false }).anonymizeDocument(
          document,
          rules(),
        ),
      ).toEqual(document);
    });

    it('stays linear on huge strings', () => {
      const huge = `${'a'.repeat(2_000_000)}@${'b'.repeat(2_000_000)}`;
      const started = performance.now();
      anonymize({ html: huge });
      expect(performance.now() - started).toBeLessThan(2_000);
    });
  });

  describe('findUnmatchedPersonalKeys', () => {
    it('does not flag keys that merely contain a personal word', () => {
      const found = new Anonymizer().findUnmatchedPersonalKeys(
        { velocity: 1, private: true, className: 'x', productName: 'y' },
        rules(),
      );

      expect([...found]).toEqual([]);
    });

    it('recognises camelCase, snake_case and acronyms', () => {
      const found = new Anonymizer().findUnmatchedPersonalKeys(
        {
          homeCity: 'x',
          date_of_birth: 'y',
          displayName: 'z',
          IPAddress: '1.2.3.4',
          SSNNumber: '1',
          mainGuest: { phoneNo: '1' },
          orderEmail: 'a@x.com',
          emailList: ['a@x.com'],
        },
        rules(),
      );

      expect([...found].sort()).toEqual([
        'IPAddress',
        'SSNNumber',
        'date_of_birth',
        'displayName',
        'emailList',
        'homeCity',
        'mainGuest.phoneNo',
        'orderEmail',
      ]);
    });

    it('flags keys whose text contains an email address when emails are not scrubbed', () => {
      const found = new Anonymizer({
        scrubEmails: false,
      }).findUnmatchedPersonalKeys(
        {
          recipient: 'someone@gmail.com',
          note: 'Please call me, or write to jane.doe@yahoo.com',
          tags: ['vip', 'x@y.org'],
          body: `${'a'.repeat(200_000)}@ not an email`,
          handle: '@jane',
        },
        rules(),
      );

      expect([...found].sort()).toEqual(['note', 'recipient', 'tags']);
    });

    it('flags credentials that no rule covers', () => {
      const found = new Anonymizer().findUnmatchedPersonalKeys(
        {
          userPasswordHash: '$2b$10$abc',
          stripeApiKey: 'sk_live_x',
          privateKey: '-----BEGIN',
          sessionTokenDigest: 'x',
        },
        rules(),
      );

      expect([...found].sort()).toEqual([
        'privateKey',
        'sessionTokenDigest',
        'stripeApiKey',
        'userPasswordHash',
      ]);
    });

    it('ignores keys that only describe personal data, and boolean flags', () => {
      const found = new Anonymizer().findUnmatchedPersonalKeys(
        {
          emailTemplate: 'welcome',
          emailType: 'x',
          orderEmailVerified: true,
          sendGuaranteedEmail: false,
          emailVerified: 'yes',
        },
        rules(),
      );

      expect([...found]).toEqual([]);
    });

    it('flags numeric coordinates, but not other numbers', () => {
      const found = new Anonymizer().findUnmatchedPersonalKeys(
        {
          lat: 46.77,
          lng: 23.59,
          home: { latitude: 46.77, longitude: 23.59 },
          lastSeenLat: 46.77,
          phoneCount: 2,
          age: 34,
        },
        rules(),
      );

      expect([...found].sort()).toEqual([
        'home.latitude',
        'home.longitude',
        'lastSeenLat',
        'lat',
        'lng',
      ]);
    });

    it('lists personal-looking keys that no rule covers, with their paths', () => {
      const found = new Anonymizer().findUnmatchedPersonalKeys(
        {
          _id: 1,
          email: 'a@x.com',
          phoneNumber: '1',
          profile: { ssn: '123', nickname: 'x', role: 'admin' },
          contacts: [{ emails: ['b@x.com'] }],
          address: { zip: '1' },
        },
        rules('email', 'address'),
      );

      expect([...found].sort()).toEqual([
        'contacts.emails',
        'phoneNumber',
        'profile.nickname',
        'profile.ssn',
      ]);
    });
  });
});
