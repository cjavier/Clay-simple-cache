import { normalizeLinkedIn } from './services/normalization';

const tests = [
    // Profiles
    { input: 'https://www.linkedin.com/in/john-doe/', expected: 'john-doe' },
    { input: 'linkedin.com/in/jane.doe', expected: 'jane.doe' },

    // Companies
    { input: 'https://www.linkedin.com/company/google', expected: 'google' },
    { input: 'https://linkedin.com/company/stripe/', expected: 'stripe' },

    // Schools
    { input: 'https://www.linkedin.com/school/stanford-university/', expected: 'stanford-university' },

    // Simple string fallback
    { input: 'some-user-slug', expected: 'some-user-slug' }
];

console.log('--- LinkedIn Normalization Tests ---');
let passed = 0;
tests.forEach(t => {
    const result = normalizeLinkedIn(t.input);
    const isPass = result === t.expected;
    if (isPass) passed++;
    console.log('Input: "' + t.input + '" -> "' + result + '" [' + (isPass ? 'PASS' : 'FAIL') + ']');
});
console.log('--- Result: ' + passed + '/' + tests.length + ' passed ---');
