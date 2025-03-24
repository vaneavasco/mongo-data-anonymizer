import { faker } from '@faker-js/faker';
import { set } from 'object-path';

type Field = {
  field: string;
  replacement: string | null | undefined;
};

export class Anonymize {
  anonymizeBatch(batch: any[], list: string[]): any[] {
    const keysToAnonymize = this.getKeysToAnonymize(list);

    return batch.map((document) =>
      this.anonymizeDocument(document, keysToAnonymize),
    );
  }

  private getKeysToAnonymize(list: string[]): Field[] {
    return list.map((item) => ({
      field: item.replace(/:(?:.*)$/, '').toLowerCase(),
      replacement: item.includes(':') ? item.replace(/^(?:.*):/, '') : null,
    }));
  }

  private anonymizeDocument(document: any, keysToAnonymize: Field[]) {
    let anonymizedDocument = { ...document };

    for (const field of keysToAnonymize) {
      set(
        anonymizedDocument,
        field.field,
        this.anonymizeValue(field.field, field.replacement),
      );
    }

    return anonymizedDocument;
  }

  private anonymizeValue(key: string, replacement: string | undefined | null) {
    if (replacement) {
      return this.applyReplacement(replacement);
    }
    return this.getFakerValueForField(key);
  }

  private applyReplacement(replacement: string) {
    if (replacement.startsWith('faker')) {
      return this.getFakerValue(replacement);
    }
    switch (replacement) {
      case '[]':
        return [];
      case '{}':
        return {};
      case 'null':
        return null;
      default: {
        if (replacement.startsWith('[') || replacement.startsWith('{')) {
          try {
            return JSON.parse(decodeURIComponent(replacement));
          } catch (error) {
            throw new Error(
              `Failed to parse replacement JSON: ${(error as Error)?.message}`,
            );
          }
        }
        return replacement;
      }
    }
  }

  private getFakerValue(replacement: string): any {
    const parts = replacement.split('.');

    if (parts.length !== 3) {
      throw new Error(
        `Invalid format for replacement: ${replacement}. Expected format 'faker.category.method'`,
      );
    }

    const [, category, method] = parts;
    const fakerCategory = (faker as any)[category];

    if (!fakerCategory) {
      throw new Error(`Invalid faker category: ${category}`);
    }

    const fakerMethod = fakerCategory[method];

    if (typeof fakerMethod !== 'function') {
      throw new Error(
        `Invalid faker method: ${method} in category ${category}`,
      );
    }

    return fakerMethod();
  }

  private getFakerValueForField(key: string) {
    if (key.includes('email')) return faker.internet.email().toLowerCase();
    if (key.includes('firstname')) return faker.person.firstName();
    if (key.includes('lastname')) return faker.person.lastName();
    if (key === 'description') return faker.lorem.sentence();
    if (key.endsWith('address')) return faker.location.streetAddress();
    if (key.endsWith('city')) return faker.location.city();
    if (key.endsWith('country')) return faker.location.country();
    if (key.endsWith('phone')) return faker.phone.number();
    if (key.endsWith('comment')) return faker.lorem.sentence();
    if (key.endsWith('date')) return faker.date.past();
    if (key.endsWith('name')) return faker.person.fullName();

    return faker.word.sample();
  }
}
