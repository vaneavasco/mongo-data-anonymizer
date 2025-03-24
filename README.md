# MongoDB Anonymizer

This package allows you to anonymize specified fields in MongoDB collections and copy them to a target database. It is based on the [mongodb-anonymizer](https://github.com/rap2hpoutre/mongodb-anonymizer) package by [rap2hpoutre](https://github.com/rap2hpoutre).

## Install dependencies


```bash
npm install 
```

## Usage

To use the package, you need to provide the source and target MongoDB URIs, the fields to anonymize, and optionally, the collections to anonymize or ignore, and the batch size. Here is an example:

```bash
npm run run:dev -- --database mongodb://localhost:27017/test --fieldList toCustomer.name,toCustomer.phone,toCustomer.email --collectionList test --batchSize 500

# or 
npm run anonymize
```

In this example, the `email` and `password` fields in the `users` and `admins` collections will be anonymized, the `logs` collection will be ignored, and the batch size for processing documents is set to `500`.

## Options

Here are the available options:

- `--database`: The MongoDB URI of the source database.
- `--fieldList`: A comma-separated list of fields to anonymize. You can also use the `+` or `-` modifiers to add or remove fields from the default list respectively. For example, `+age` will add `age` to the default fields, and `-email` will remove `email` from the default fields. The default fields are: `email`, `name`, `description`, `address`, `city`, `country`, `phone`, `comment`, `birthdate`, `firstname`, `lastname`, `fullname`.
- `--collectionList`: (Optional) A comma-separated list of collections to anonymize. If not provided, all collections will be anonymized.
- `--ignoreCollections`: (Optional) A comma-separated list of collections to ignore during the anonymization process.
- `--batchSize`: (Optional) The number of documents to process at a time. Defaults to `1000`.
- `--copyNonAnonymized`: (Optional) If set, non-anonymized collections will be copied as-is to the target database. By default, non-anonymized collections are not copied.

