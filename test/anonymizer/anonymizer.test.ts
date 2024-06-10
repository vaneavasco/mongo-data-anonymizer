import { Anonymize } from '../../src/anonymization/anonymize';

describe('Anonymize', () => {
    let anonymize: Anonymize;

    beforeEach(() => {
        anonymize = new Anonymize();
    });

    describe('anonymizeBatch', () => {
        it('should anonymize fields in a batch of documents', () => {
            const batch = [
                { firstName: 'John', lastName: 'Doe', email: 'john.doe@example.com' },
                { firstName: 'Jane', lastName: 'Smith', email: 'jane.smith@example.com' }
            ];
            const collectionName = 'users';
            const list = ['users.firstName', 'users.lastName', 'users.email'];

            const result = anonymize.anonymizeBatch(batch, collectionName, list);

            expect(result).toHaveLength(2);
            expect(result[0].firstName).not.toBe('John');
            expect(result[0].lastName).not.toBe('Doe');
            expect(result[0].email).not.toBe('john.doe@example.com');
            expect(result[1].firstName).not.toBe('Jane');
            expect(result[1].lastName).not.toBe('Smith');
            expect(result[1].email).not.toBe('jane.smith@example.com');
        });
    });

    describe('getKeysToAnonymize', () => {
        it('should filter and map the list of fields to anonymize', () => {
            const list = ['users.firstName', 'users.lastName', 'users.email:faker.internet.email'];
            const collectionName = 'users';

            // @ts-ignore: private method
            const result = anonymize.getKeysToAnonymize(list, collectionName);

            expect(result).toEqual([
                { field: 'firstname', replacement: null },
                { field: 'lastname', replacement: null },
                { field: 'email', replacement: 'faker.internet.email' }
            ]);
        });
    });

    describe('anonymizeDocument', () => {
        it('should anonymize specified fields in a document', () => {
            const document = { firstName: 'John', lastName: 'Doe', email: 'john.doe@example.com' };
            const fieldsToAnonymize = ['firstname', 'lastname', 'email'];
            const keysToAnonymize = [
                { field: 'firstname', replacement: null },
                { field: 'lastname', replacement: null },
                { field: 'email', replacement: 'faker.internet.email' }
            ];

            // @ts-ignore: private method
            const result = anonymize.anonymizeDocument(document, fieldsToAnonymize, keysToAnonymize);

            expect(result.firstName).not.toBe('John');
            expect(result.lastName).not.toBe('Doe');
            expect(result.email).not.toBe('john.doe@example.com');
        });
    });

    describe('anonymizeValue', () => {
        it('should apply replacement if provided', () => {
            // @ts-ignore: private method
            const result = anonymize.anonymizeValue('email', 'faker.internet.email');
            expect(result).not.toBe(null);
        });

        it('should use faker value if no replacement is provided', () => {
            // @ts-ignore: private method
            const result = anonymize.anonymizeValue('email', null);
            expect(result).not.toBe(null);
        });
    });

    describe('applyReplacement', () => {
        it('should handle faker replacements', () => {
            // @ts-ignore: private method
            const result = anonymize.applyReplacement('faker.internet.email');
            expect(result).not.toBe(null);
        });

        it('should return empty array for [] replacement', () => {
            // @ts-ignore: private method
            const result = anonymize.applyReplacement('[]');
            expect(result).toEqual([]);
        });

        it('should return empty object for {} replacement', () => {
            // @ts-ignore: private method
            const result = anonymize.applyReplacement('{}');
            expect(result).toEqual({});
        });

        it('should return null for null replacement', () => {
            // @ts-ignore: private method
            const result = anonymize.applyReplacement('null');
            expect(result).toBeNull();
        });

        it('should parse and return JSON for valid JSON replacements', () => {
            // @ts-ignore: private method
            const result = anonymize.applyReplacement('{"key":"value"}'); // {"key":"value"}
            expect(result).toEqual({ key: 'value' });
        });

        it('should throw an error for invalid JSON replacements', () => {
            expect(() => {
                // @ts-ignore: private method
                anonymize.applyReplacement('[invalid-json');
            }).toThrowError( 'Failed to parse replacement JSON: Unexpected token i in JSON at position 1');
        });
    });

    describe('getFakerValue', () => {
        it('should return a faker value for valid replacement', () => {
            // @ts-ignore: private method
            const result = anonymize.getFakerValue('faker.internet.email');
            expect(result).not.toBe(null);
        });

        it('should throw an error for invalid faker category', () => {
            expect(() => {
                // @ts-ignore: private method
                anonymize.getFakerValue('faker.invalidCategory.method');
            }).toThrowError('Invalid faker category: invalidCategory');
        });

        it('should throw an error for invalid faker method', () => {
            expect(() => {
                // @ts-ignore: private method
                anonymize.getFakerValue('faker.internet.invalidMethod');
            }).toThrowError('Invalid faker method: invalidMethod in category internet');
        });

        it('should throw an error for incorrect format', () => {
            expect(() => {
                // @ts-ignore: private method
                anonymize.getFakerValue('faker.internet');
            }).toThrowError('Invalid format for replacement: faker.internet. Expected format \'faker.category.method\'');
        });
    });

    describe('getFakerValueForField', () => {
        it('should return correct faker value for recognized keys', () => {
            // @ts-ignore: private method
            expect(anonymize.getFakerValueForField('email')).not.toBe(null);
            // @ts-ignore: private method
            expect(anonymize.getFakerValueForField('firstname')).not.toBe(null);
            // @ts-ignore: private method
            expect(anonymize.getFakerValueForField('lastname')).not.toBe(null);
        });

        it('should return a sample word for unrecognized keys', () => {
            // @ts-ignore: private method
            const result = anonymize.getFakerValueForField('unrecognizedKey');
            expect(result).not.toBe(null);
        });
    });
});
