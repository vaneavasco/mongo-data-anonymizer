# MongoDB Anonymizer

This package allows you to anonymize specified fields in MongoDB collections and copy them to a target database. It is based on the [mongodb-anonymizer](https://github.com/rap2hpoutre/mongodb-anonymizer) package by [rap2hpoutre](https://github.com/rap2hpoutre).

## Installation

You can install the package globally using npm:

```bash
npm install -g mongodb-anonymizer
```

## Usage

To use the package, you need to provide the source and target MongoDB URIs, the fields to anonymize, and optionally, the collections to anonymize or ignore, and the batch size. Here is an example:

```bash
mongodb-anonymizer --sourceUri "mongodb://localhost:27017/source" --targetUri "mongodb://localhost:27017/target" --fieldList "email,password" --collectionList "users,admins" --ignoreCollections "logs" --batchSize 500
```

In this example, the `email` and `password` fields in the `users` and `admins` collections will be anonymized, the `logs` collection will be ignored, and the batch size for processing documents is set to `500`.

## Options

Here are the available options:

- `--sourceUri`: The MongoDB URI of the source database.
- `--targetUri`: The MongoDB URI of the target database.
- `--fieldList`: A comma-separated list of fields to anonymize. You can use the `+` or `-` modifiers to add or remove fields from the default list respectively. For example, `+age` will add `age` to the default fields, and `-email` will remove `email` from the default fields.
- `--collectionList`: (Optional) A comma-separated list of collections to anonymize. If not provided, all collections will be anonymized.
- `--ignoreCollections`: (Optional) A comma-separated list of collections to ignore during the anonymization process.
- `--batchSize`: (Optional) The number of documents to process at a time. Defaults to `1000`.
- `--copyNonAnonymized`: (Optional) If set, non-anonymized collections will be copied as-is to the target database. By default, non-anonymized collections are not copied.

## Note

This package does not delete any data from the source database. It creates a copy of the data in the target database with the specified fields anonymized. Please ensure that you have the necessary permissions and storage capacity before using this package.