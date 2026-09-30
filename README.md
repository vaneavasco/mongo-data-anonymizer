# MongoDB Data Anonymizer

Copies a MongoDB database to another database, replacing personal data with realistic fake values. Fake values are **deterministic**: the same original value always becomes the same fake value, in every collection and on every run with the same secret. So references between collections still line up, and the output can be reproduced.

Based on [mongodb-anonymizer](https://github.com/rap2hpoutre/mongodb-anonymizer) by [rap2hpoutre](https://github.com/rap2hpoutre).

## Installation

Requires Node.js 22.13 or newer.

```bash
npm install -g mongo-data-anonymizer
```

Or run it without installing:

```bash
npx mongo-data-anonymizer --help
```

## Usage

```bash
export ANONYMIZER_SECRET="$(openssl rand -hex 32)"   # keep it to reproduce the same output later

mongo-data-anonymizer \
  --sourceUri "mongodb://localhost:27017/production" \
  --targetUri "mongodb://localhost:27017/staging" \
  --fieldList "+users.password:null,+*guestEmail,-description" \
  --ignoreCollections "logs" \
  --copyNonAnonymized \
  --dropTarget
```

With these options:

- Every collection is anonymized except `logs`, which is copied as-is (`--copyNonAnonymized`).
- The [default fields](#default-fields) are anonymized, plus `password` in `users` (set to `null`) and every key ending in `guestEmail`, minus `description`. Email addresses in any other string are replaced too (`--scrubEmails`, on by default).
- Collections that already exist in the target are dropped and rewritten (`--dropTarget`).

To see what would happen without writing anything, run it first with `--dryRun`. For every collection, it shows:

- whether the collection would be anonymized, copied or skipped;
- roughly how many documents it has;
- which keys match no rule but look like personal data by name, such as `SSNNumber` or `guestPhoneList`. It checks the first 1000 documents of each collection (`--sampleSize`, 0 for all), so rare keys can be missed, and it ignores boolean and numeric values, except coordinates such as `lat` or `homeLongitude`. Those keys would be written unchanged, so add them to `--fieldList` if needed. With `--no-scrubEmails`, keys whose text contains an email address are listed too.

A dry run also runs the [safety checks](#safety-checks), except the probe collection, which would be a write. So it fails too if, for example, the target already has the collections and `--dropTarget` isn't set.

## Options

| Option                    | Default    | Description                                                                                                                                                                                                             |
| ------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--sourceUri`             | _required_ | URI of the source database, including the database name. It is only read from; see [Safety checks](#safety-checks).                                                                                                     |
| `--targetUri`             | _required_ | URI of the target database, including the database name. The run refuses to start if it is the same database as the source.                                                                                             |
| `--fieldList`             | see below  | Comma-separated [field rules](#field-rules).                                                                                                                                                                            |
| `--collectionList`        | all        | Comma-separated collections to anonymize.                                                                                                                                                                               |
| `--ignoreCollections`     | none       | Comma-separated collections never to anonymize.                                                                                                                                                                         |
| `--copyNonAnonymized`     | `false`    | Copy the collections that are not anonymized (not in `--collectionList`, or in `--ignoreCollections`) as-is. Without it they are skipped.                                                                               |
| `--dropTarget`            | `false`    | Drop target collections that already exist. Without it the run stops before writing anything if any of them exists.                                                                                                     |
| `--dryRun`                | `false`    | Print what would be done for every collection, without writing anything.                                                                                                                                                |
| `--strict`                | `false`    | Fail instead of warning when a matched value can't be anonymized (ObjectId, Binary, Decimal128, invalid dates, ...), so no personal data is left behind silently.                                                       |
| `--scrubEmails`           | `true`     | Replace email addresses found in any string, including fields no rule matches and free text, with the same fake email they get everywhere else. Turn off with `--no-scrubEmails`.                                       |
| `--sampleSize`            | `1000`     | Documents per collection a dry run checks for unmatched personal-looking keys. `0` checks every document.                                                                                                               |
| `--assumeDifferentTarget` | `false`    | Allow a target that shares collection UUIDs or servers with the source, such as a copy restored with `mongorestore --preserveUUID`. The probe collection still checks that writes to the target don't reach the source. |
| `--indexCommitQuorum`     | `1`        | Commit quorum for index builds when the target is a replica set: a number of members, `majority` or `votingMembers`. See [Replica sets and large databases](#replica-sets-and-large-databases).                         |
| `--indexTimeout`          | `900`      | Seconds to wait for a collection's indexes to build. When it runs out, those indexes are skipped with a warning. `0` means no limit.                                                                                    |
| `--batchSize`             | `1000`     | Documents read and inserted per batch. A batch is also cut at 16 MB, so large documents don't use much memory.                                                                                                          |
| `--secret`                | random     | Secret for [deterministic anonymization](#deterministic-anonymization). Prefer the `ANONYMIZER_SECRET` environment variable, which stays out of your shell history.                                                     |

Every option can also be set with an environment variable: `ANONYMIZER_` followed by the option name in upper snake case, e.g. `ANONYMIZER_SOURCE_URI`, `ANONYMIZER_TARGET_URI`, `ANONYMIZER_SECRET`. Boolean variables accept `true`/`false`, `1`/`0`, `yes`/`no` and `on`/`off`; any other value is an error. Command-line options take precedence over environment variables, and a repeated option isn't merged: the last value wins. Other `ANONYMIZER_*` variables are ignored.

The process exits with a non-zero code when the run fails.

## Safety checks

Before writing anything, the run stops if:

- **The source and target are the same database.** Two checks cover this:
  - **Similarity check.** The tool compares collection UUIDs, and the database name on the same servers. A match refuses the run.
    - This check can also match two different databases: a target restored from the source with `mongorestore --preserveUUID` or from a disk snapshot, or two identical docker stacks. If you are sure the target is a different database, pass `--assumeDifferentTarget` to skip it.
  - **Probe collection.** The tool creates an empty collection named `anonymizer_probe_<random>` in the target, checks whether it appears in the source, then drops it right away.
    - This catches the same server reached through another address, such as an SSH tunnel or a different port mapping.
    - It always runs, even with `--assumeDifferentTarget`, but only in a real run, not in a dry run.
    - The target user needs permission to create and drop collections, which the copy needs anyway.
    - If a run is killed at exactly that moment, the probe collection can stay behind. The next run warns about it, and you can drop it.
- **A URI doesn't name a database, or names an invalid one.** Without a database name, the driver would silently use `test`.
- **A collection named in the options doesn't exist in the source.** This covers `--collectionList`, `--ignoreCollections` and `collection.field` rules. It prevents, for example, a typo in `--collectionList` combined with `--copyNonAnonymized` from copying data unanonymized.
- **No collection would be anonymized** and everything selected would only be copied as-is. Views don't count as anonymized collections. If everything is skipped, the run writes nothing and warns.
- **The target already has one of the collections** and `--dropTarget` isn't set.
- **A replacement can't be applied.** Examples: invalid JSON, an unknown Faker method, or a Faker method that needs arguments.

## Field rules

Each item of `--fieldList` has the form `[collection.]field[:replacement]`.

- **`field`** is matched against keys **at any depth**, including inside subdocuments and arrays, ignoring case, `_` and `-`. `email` matches `email`, `Email`, `e_mail`, `profile.email` and `contacts[].email`; `firstname` matches `firstName` and `first_name`.
- **`*`** in `field` matches any characters: `*email` matches `email`, `orderEmail` and `guestEmail`, but not `emailTemplate`.
- **`collection.`** limits the rule to one collection (`users.email`). The collection must exist in the source.
- **Precedence:** a collection's own rules, exact names or patterns, come before global rules; within each, an exact field name comes before a pattern, and a rule you add wins over a default for the same field (`+first_name:REDACTED`). So `users.*name:REDACTED` also overrides the global `name` in `users`.
- **`:replacement`** sets what the value becomes:
  - `faker.<category>.<method>`, e.g. `faker.person.jobTitle`: any [Faker](https://fakerjs.dev/api/) method that can be called without arguments. It is still deterministic, and its result is used whatever the original type, so `phone:faker.string.uuid` turns numbers and dates into UUID strings too. As with any rule, `null`, booleans, empty strings, `NaN` and `Infinity` are still kept.
  - `null`, `[]`, `{}`, or JSON such as `{"a":1}`. Encode commas as `%2C` inside JSON, since `,` separates rules.
  - `keep` leaves the field as it is. Use it with a collection to override a broader rule: `images.name:keep` keeps file names in `images`, while `name` is still anonymized everywhere else. Everything inside a kept field is kept too, including subdocuments such as `address.city`; only email addresses are still replaced (`--scrubEmails`). The dry run still reports personal-looking keys inside a kept field.
  - `keep` and `null` are reserved words and must be written in lower case; `KEEP` or `Null` is rejected as a likely typo.
  - Any other text is used literally, e.g. `REDACTED`.

Without a replacement, the fake value is chosen from the field name: emails, first, last and full names, usernames, addresses, streets, cities, countries, zip codes, phone numbers, dates, birthdates, company names, IP addresses, IBANs, passwords and tokens (random strings), and free text (`description`, `comment`, `note`, `message`, `body`, ...). A value that is an email address always gets a fake email, whatever the field is called, so `recipient` and `users.email` stay consistent.

### Default fields

The defaults cover the fields that most applications use for personal data, but they can't know your schema: anything they don't match, such as free text in `message` or `body`, national ID numbers or coordinates, is copied unchanged. Choosing the fields is up to you, so follow [Before using on production data](#before-using-on-production-data) before trusting the output. The patterns end with the personal word, so `orderEmail` and `mainGuest.phoneNo` are covered, while `emailTemplate`, `emailVerified` and `productName` are not.

| Kind                        | Rules                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Emails                      | `*email`, `*emails`, `recipient`, `recipients`, `sender`                                                                                                      |
| Names                       | `name`, `firstname`, `lastname`, `middlename`, `fullname`, `surname`, `displayname`, `nickname`, `username`                                                   |
| Phones                      | `*phone`, `*phones`, `*phoneno`, `*phonenumber`, `*mobile`, `fax`                                                                                             |
| Addresses                   | `*address`, `street`, `city`, `country`, `*zip`, `*zipcode`, `*postcode`, `*postalcode`                                                                       |
| Dates of birth              | `birthdate`, `birthday`, `dateofbirth`, `dob`                                                                                                                 |
| Free text                   | `description`, `comment`, `comments`, `note`, `notes`                                                                                                         |
| Identifiers and credentials | `ip`, `ssn`, `iban`, `passport`, `*password`, `password*`, `*passwordhash`, `*token`, `*tokenhash`, `*secret`, `*secretkey`, `*apikey`, `*privatekey`, `salt` |

Items can adjust the defaults instead of replacing them:

| `--fieldList`               | Result                                       |
| --------------------------- | -------------------------------------------- |
| _(not set)_                 | the default fields                           |
| `email,ssn`                 | only `email` and `ssn`                       |
| `+taxId,+users.apiKey:null` | the defaults, plus `taxId` and `apiKey`      |
| `-description,-comment`     | the defaults, without those two              |
| `-*token`                   | the defaults, without the `*token` rule      |
| `+images.name:keep`         | the defaults, but `name` is kept in `images` |

A removal must name an existing rule exactly, including its `*`: `-*email` removes the default `*email` rule, while `-email` is an error.

### How values are replaced

- **Types are kept.** Strings stay strings, numbers stay numbers with the same number of digits, and a `Date` stays a `Date`. `null`, booleans, empty strings, `NaN` and `Infinity` are kept as they are.
- **Arrays**, including nested arrays, are anonymized element by element.
- **A matched subdocument** has every value inside it anonymized. For example, with `address` matched, `address.street`, `address.city` and `address.zip` are each replaced with a fitting fake value. A nested key with a rule of its own follows that rule: with `address` and `city:REDACTED`, `address.city` becomes `REDACTED`.
- **`_id`** is never matched as a whole. Personal data inside a compound `_id`, such as `{ _id: { email } }`, is anonymized like any other subdocument. With `--scrubEmails`, an `_id` that is an email address is replaced as well. Because values are deterministic, the same `_id` still becomes the same new `_id` everywhere, including in the fields that reference it.
- **Email addresses in any string value** are replaced by default, even in fields no rule matches and inside free text such as `"Write to jane@x.com"`.
  - The address becomes the same fake email it gets everywhere else, and the text around it is kept.
  - A value such as `Jane Doe <jane@x.com>` gets a fake name and that same fake email. This holds in any field, such as `to`, `cc` or `headers.From`. A list such as `Jane <jane@x.com>, bob@y.com` is handled item by item, and `mailto:` is kept.
  - Addresses that are part of a URL or a connection string are left alone: `git@github.com:org/repo.git`, `https://user@host/...`, `mongodb://user:pass@host`. An address followed by a colon and a space, a tag or punctuation, as in `jane@x.com: urgent` or `jane@x.com:<br>`, is still replaced; one followed by a colon and text, as in `jane@x.com:8080` or `jane@x.com:notes`, is taken for a host and left alone.
  - Domains are recognised in ASCII only, so an address such as `jane@münchen.de` is not replaced.
  - Email addresses used as object keys are not replaced.
  - Turn this off with `--no-scrubEmails`.
- **Emails** always get the reserved `example.com` domain, so they never reach a real inbox. They also get a suffix derived from the original value, which makes collisions on unique indexes practically impossible.
- **Unsupported values** are left unchanged, with a warning. This covers BSON types that have no sensible fake (ObjectId, Binary, Decimal128, ...) and invalid dates. Use `--strict` to fail instead, or a replacement such as `field:null` to overwrite them.

### Known over-matches

The default patterns can also match keys that aren't personal data:

- `*token` matches pagination tokens such as `nextToken`;
- `*address` matches `macAddress` or `serverAddress`;
- `*phone` matches `microphone`;
- `name` matches the names of roles, categories or products, which can break lookups by name.

- `password*` matches `passwordPolicy` (whose settings would be replaced) and `passwordUpdatedAt` (a date that becomes a random date);
- `salt` matches recipe or nutrition data.

Use `:keep` for a collection (`+roles.name:keep`), or remove a pattern (`-*token`).

Inside a matched subdocument, some structure is preserved:

- `type`, `kind` and `__typename` values are kept;
- GeoJSON objects keep their type. A `Point` gets a valid fake position; other geometries (a GPS track, a home area...) become a small valid shape of the same type around a fake position. The object's other keys, such as `formattedAddress`, are anonymized as usual. So `2dsphere` indexes still build;
- a legacy `[longitude, latitude]` pair under a geo key (`coordinates`, `loc`, `location`, `geo...`, `position`, `point`) gets a valid fake position, so `2d` and `2dsphere` indexes still build. Pairs of numbers under other keys are anonymized number by number;
- `lat`/`lng` values stay within valid ranges. A legacy `{lat, lng}` object stores latitude first, which a `2dsphere` index reads the wrong way round; a fake longitude there can make the index fail to build.

## Deterministic anonymization

Every fake value is derived from `HMAC-SHA256(secret, original value)`. As a result:

- **Consistent references:** the same email in `users.email` and in `orders.customer.email` becomes the same fake email, so joins and lookups still work.
- **Reproducible output:** running again with the same secret and the same version of this package produces identical data. Generated dates are relative to a fixed reference date, not to today. The Faker version is pinned for this reason; a new major version of this package may change the fake values.
- **Not reversible:** without the secret, an original value can't be recovered by hashing guesses. Keep the secret private, like a password.

Matching is exact. `John@x.com` and `john@x.com` are different values and get different fake values.

If no secret is given, a random one is generated for the run. The output is then consistent within that run, but differs from run to run.

## Before using on production data

The defaults and email scrubbing cover the usual cases, but every database has its own field names. Before handing an anonymized copy to anyone:

1. **Set a secret** and keep it private: `export ANONYMIZER_SECRET="$(openssl rand -hex 32)"`.
2. **Run `--dryRun --sampleSize 0`** and read every warning. Add the keys it lists to `--fieldList`, with `+` or with a pattern such as `+*guestPhone`.
   - The defaults also replace business content that happens to use the same field names, such as a product's `name` or `description` or a venue's `address`. Keep what your developers need with collection rules such as `+products.name:keep,+venues.address:keep`.
3. **Think about data the dry run can't recognise:**
   - free text that mentions names or phone numbers: add its field, for example `+contact.message`;
   - fields named in another language;
   - personal data stored in numbers or IDs.
4. **Run with `--strict`**, so a matched value that can't be anonymized stops the run instead of producing a warning.
   - When a rule matches a field that holds references, such as `sender: ObjectId(...)` in a messages collection, remove the rule (`-sender`) or keep the field for that collection (`+messages.sender:keep`). Replacing it with `null` would break the reference.
5. **Spot-check the result.** Open a few documents of the collections that hold customer data, and search the target for a real email address or phone number you know is in the source.

## Replica sets and large databases

**Progress.**

- Every 5 seconds, the run logs how far each collection has got, for example `users: 120,000/2,300,000 (5%), 9,800 docs/s, ETA 3m42s`.
- If nothing completes for 30 seconds, it warns and names the operation it is waiting for, for example `No progress for 30s: createIndexes on bookings (...)`.

**Index builds on a replica set.**

- On a replica set, MongoDB normally waits for every voting member to finish an index build.
- If a secondary is down, lagging or stuck, the build waits forever. With an arbiter, even `majority` can't be reached without the secondary.
- So the tool builds indexes with `--indexCommitQuorum 1` by default: the primary's vote is enough, and the secondaries still build the index as they catch up.
- If the build still doesn't finish within `--indexTimeout` seconds, the server aborts it. The collection's indexes are then skipped with a warning; build them by hand once the replica set is healthy.

**Write concern** comes from the target URI. For a throwaway target on a replica set whose default is `majority`, adding `w=1` to the target URI makes inserts faster.

**Open files.**

- MongoDB keeps one file per collection and per index open. Dropped collections keep theirs until the next checkpoint.
- So several `--dropTarget` reruns in a row can briefly need a few hundred extra file handles.
- The target's `mongod` should run with the open-files limit MongoDB recommends (`ulimit -n` 64000 or more). The default of 1024 in many containers can make WiredTiger fail with `Too many open files`.
- In Docker Compose:

  ```yaml
  services:
    mongodb:
      ulimits:
        nofile:
          soft: 64000
          hard: 64000
  ```

## What else is copied

For every collection it writes, the tool also copies:

- the collection options: validators, collation, capped and time series settings;
- all indexes, including unique ones. Indexes are built after the data is inserted; an index that can't be built produces a warning instead of failing the run;
- views, recreated after the collections.

System collections (`system.*`) are skipped.

Validators are copied as they are, so they may reject fake values. For example, a `$jsonSchema` pattern that requires your company's email domain rejects the `example.com` addresses. The run then stops with `Document failed validation`. To avoid this, give the field a replacement the validator accepts, or relax the validator in the target.

## Upgrading from 0.2

- **Node.js 22.13 or newer** is required, and the package is ESM-only.
- **Reruns need `--dropTarget`.** Rerunning into a target that already has the collections used to fail halfway through with duplicate key errors. Now the run refuses to start, unless `--dropTarget` is set.
- **`--copyNonAnonymized` no longer copies everything raw.** In 0.2, using it without `--collectionList` copied every collection without anonymizing anything. Now it only affects collections that are not selected for anonymization.
- **Fields are matched at any depth**, including inside subdocuments and arrays. Dates, numbers, `null` and arrays keep their types; in 0.2 they were turned into `{}`.
- **Fake values are deterministic.** Set `ANONYMIZER_SECRET` to get the same output on every run.
- **`+` and `-` apply to each item** of `--fieldList`, so `+age,-*email` works as expected. Removing a rule that doesn't exist is an error.
- **Wider defaults.** The default fields now use patterns (`*email`, `*phone`, `*address`, ...) and cover more kinds of data. Email addresses in any string are replaced too (`--scrubEmails`). To remove a default, use its exact rule, for example `-*email` instead of `-email`.
- **Stricter checks:** a URI must name a database, and collection names used in options must exist in the source. See [Safety checks](#safety-checks).
- **Logs are plain text on stderr**, no longer bunyan JSON. Failures now exit with a non-zero code.

## Programmatic use

```ts
import { run } from 'mongo-data-anonymizer';

const report = await run({
  sourceUri: 'mongodb://localhost:27017/production',
  targetUri: 'mongodb://localhost:27017/staging',
  fieldList: ['email', 'name', 'users.password:null'],
  collectionList: [],
  ignoreCollections: [],
  batchSize: 1000,
  copyNonAnonymized: false,
  dropTarget: true,
  dryRun: false,
  strict: true,
  secret: process.env.ANONYMIZER_SECRET,
});

for (const warning of report.warnings) console.warn(warning);
```

## Development

```bash
npm ci
npm test          # unit + integration tests; integration tests start an in-memory MongoDB
npm run lint
npm run typecheck
npm run build
npm run dev -- --help   # runs src/cli.ts directly, without building
```
