import {getFieldList} from '../../src/utils/field-utils';

describe('getFieldList', () => {
    it('should return the default field list if no field list option is provided', () => {
        const result = getFieldList('', ['field1', 'field2', 'field3']);
        expect(result).toEqual(['field1', 'field2', 'field3']);
    });

    it('should return an empty array if no filed list is provided and no default list is provided', () => {
        const result = getFieldList('');
        expect(result).toEqual([]);
    });

    it('should return the correct field list if a field list is provided without modifiers', () => {
       const result = getFieldList('field1,field2,field3', ['field4', 'field5', 'field3']);

       expect(result).toEqual(['field1', 'field2', 'field3']);
    });

    it('should return the correct field list if a field list is provided with a + modifier', () => {
        const result = getFieldList('+field1,field2', ['field3', 'field4']);

        expect(result).toEqual(['field3', 'field4', 'field1', 'field2']);
    });

    it('should return the correct field list if a field list is provided with a - modifier', () => {
        const result = getFieldList('-field1,field2', ['field1', 'field2', 'field3']);

        expect(result).toEqual(['field3']);
    });
});
