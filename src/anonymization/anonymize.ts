import { faker } from '@faker-js/faker';

export class Anonymize {

    anonymizeBatch(batch: any[], collectionName: string, list: string[]): any[] {
        const keysToAnonymize = this.getKeysToAnonymize(list, collectionName);
        const fieldsToAnonymize = keysToAnonymize.map((item) => item.field);

        return batch.map((document) => this.anonymizeDocument(document, fieldsToAnonymize, keysToAnonymize));
    }

    private getKeysToAnonymize(list: string[], collectionName: string) {
        return list
            .filter((item) => !item.match(/^[a-z_]+\./gi) || item.startsWith(`${collectionName}.`))
            .map((item) => ({
                field: item.replace(`${collectionName}.`, "").replace(/:(?:.*)$/, "").toLowerCase(),
                replacement: item.includes(":") ? item.replace(/^(?:.*):/, "") : null,
            }));
    }

    private anonymizeDocument(document: any, fieldsToAnonymize: string[], keysToAnonymize: any[]) {
        const anonymizedDocument: Record<string, any> = {};

        for (const key in document) {
            if (!document.hasOwnProperty(key)) continue;

            if (fieldsToAnonymize.includes(key.toLowerCase())) {
                if (typeof document[key] === 'object')  {
                    if (Array.isArray(document[key]) && document[key].length > 0) {
                        anonymizedDocument[key] = document[key].map((item: any) => this.anonymizeDocument(item, fieldsToAnonymize, keysToAnonymize));
                        continue;
                    }

                    anonymizedDocument[key] = this.anonymizeDocument(document[key], fieldsToAnonymize, keysToAnonymize);
                    continue;
                }

                anonymizedDocument[key] = this.anonymizeValue(
                    key.toLowerCase(),
                    keysToAnonymize.find((item) => item.field === key.toLowerCase())?.replacement
                );
            } else {
                anonymizedDocument[key] = document[key];
            }
        }
        return anonymizedDocument;
    }

    private anonymizeValue(key: string, replacement: string | null) {
        if (replacement) {
            return this.applyReplacement(replacement);
        }
        return this.getFakerValueForField(key);
    }

    private applyReplacement(replacement: string) {
        if (replacement.startsWith("faker")) {
            return this.getFakerValue(replacement);
        }
        switch (replacement) {
            case "[]": return [];
            case "{}": return {};
            case "null": return null;
            default: {
                if (replacement.startsWith("[") || replacement.startsWith("{")) {
                    try {
                        return JSON.parse(decodeURIComponent(replacement));
                    } catch (error) {
                        throw new Error(`Failed to parse replacement JSON: ${(error as Error)?.message}`);
                    }
                }
                return replacement;
            }
        }
    }

    private getFakerValue(replacement: string): any {
        const parts = replacement.split(".");

        if (parts.length !== 3) {
            throw new Error(`Invalid format for replacement: ${replacement}. Expected format 'faker.category.method'`);
        }

        const [, category, method] = parts;
        const fakerCategory = (faker as any)[category];

        if (!fakerCategory) {
            throw new Error(`Invalid faker category: ${category}`);
        }

        const fakerMethod = fakerCategory[method];

        if (typeof fakerMethod !== 'function') {
            throw new Error(`Invalid faker method: ${method} in category ${category}`);
        }

        return fakerMethod();
    }


    private getFakerValueForField(key: string) {
        if (key.includes("email")) return faker.internet.email().toLowerCase();
        if (key.includes("firstname")) return faker.person.firstName();
        if (key.includes("lastname")) return faker.person.lastName();
        if (key === "description") return faker.lorem.sentence();
        if (key.endsWith("address")) return faker.location.streetAddress();
        if (key.endsWith("city")) return faker.location.city();
        if (key.endsWith("country")) return faker.location.country();
        if (key.endsWith("phone")) return faker.phone.number();
        if (key.endsWith("comment")) return faker.lorem.sentence();
        if (key.endsWith("date")) return faker.date.past();
        if (key.endsWith("name")) return faker.person.fullName();

        return faker.word.sample();
    }
}
