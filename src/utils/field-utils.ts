export function getFieldList(fieldListOption: string, defaultFields: string[] = []) {
    if (fieldListOption.length) {
        if (fieldListOption.startsWith('+')) {
            return defaultFields.concat(fieldListOption.slice(1).split(','));
        }

        if (fieldListOption.startsWith('-')) {
            const fieldsToRemove = fieldListOption.slice(1).split(',');
            return defaultFields.filter(field => !fieldsToRemove.includes(field));
        }

        return fieldListOption.split(',');
    }

    return [...defaultFields];
}
