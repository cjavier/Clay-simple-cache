import { normalizeEmail, normalizeLinkedIn, normalizePhone } from './services/normalization';

const tests = [
    // Email
    () => {
        const input = ' Ana@Empresa.com ';
        const expected = 'ana@empresa.com';
        const result = normalizeEmail(input);
        console.log(`Email: "${input}" -> "${result}" [${result === expected ? 'PASS' : 'FAIL'}]`);
    },

    // LinkedIn
    () => {
        const input = 'https://www.linkedin.com/in/juan-perez/';
        const expected = 'juan-perez';
        const result = normalizeLinkedIn(input);
        console.log(`LinkedIn: "${input}" -> "${result}" [${result === expected ? 'PASS' : 'FAIL'}]`);
    },
    () => {
        const input = 'linkedin.com/in/juan-perez';
        const expected = 'juan-perez';
        const result = normalizeLinkedIn(input);
        console.log(`LinkedIn: "${input}" -> "${result}" [${result === expected ? 'PASS' : 'FAIL'}]`);
    },

    // Phone
    () => {
        const input = '(55) 1234-5678';
        const expected = '+525512345678';
        const result = normalizePhone(input);
        console.log(`Phone: "${input}" -> "${result?.e164}" [${result?.e164 === expected ? 'PASS' : 'FAIL'}]`);
    },
    () => {
        const input = '+52 55 1234 5678';
        const expected = '+525512345678';
        const result = normalizePhone(input);
        console.log(`Phone: "${input}" -> "${result?.e164}" [${result?.e164 === expected ? 'PASS' : 'FAIL'}]`);
    }
];

console.log('--- Running Normalization Tests ---');
tests.forEach(t => t());
console.log('--- Done ---');
