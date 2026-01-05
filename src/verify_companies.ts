import { normalizeDomain } from './services/normalization';

const tests = [
    // Domain
    () => {
        const input = ' https://www.Google.com/ ';
        const expected = 'google.com';
        const result = normalizeDomain(input);
        console.log(`Domain: "${input}" -> "${result}" [${result === expected ? 'PASS' : 'FAIL'}]`);
    },
    () => {
        const input = 'example.co.uk';
        const expected = 'example.co.uk';
        const result = normalizeDomain(input);
        console.log(`Domain: "${input}" -> "${result}" [${result === expected ? 'PASS' : 'FAIL'}]`);
    },
    () => {
        const input = 'invalid-domain'; // No dot
        const expected = null;
        const result = normalizeDomain(input);
        console.log(`Domain: "${input}" -> "${result}" [${result === expected ? 'PASS' : 'FAIL'}]`);
    }
];

console.log('--- Running Company Normalization Tests ---');
tests.forEach(t => t());
console.log('--- Done ---');
