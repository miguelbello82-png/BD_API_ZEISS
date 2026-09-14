/**
 * Utility script for sanitizing Postman Collections.
 * Reads from: .local-input/API ZEISS.postman_collection.json
 * Writes to: docs/api/zeiss/reference/API-ZEISS.sanitized.json
 * 
 * DOES NOT execute any external requests.
 */

const fs = require('fs');
const path = require('path');

const inputPath = path.resolve(__dirname, '../../.local-input/API ZEISS.postman_collection.json');
const outputPathDir = path.resolve(__dirname, '../../docs/api/zeiss/reference');
const outputPath = path.join(outputPathDir, 'API-ZEISS.sanitized.json');

if (!fs.existsSync(inputPath)) {
    console.error('Input collection not found at: ' + inputPath);
    process.exit(1);
}

const rawData = fs.readFileSync(inputPath, 'utf8');
let sanitizedData = rawData;
let sanitizedCount = 0;

// Replaces any typical header or auth secret with {{ZEISS_API_KEY}}
const patternsToSanitize = [
    /"x-api-key"\s*:\s*"[^"]+"/gi,
    /"Authorization"\s*:\s*"(Bearer|Basic)\s+[^"]+"/gi,
    /"token"\s*:\s*"[^"]+"/gi,
    /"password"\s*:\s*"[^"]+"/gi,
    /"client_secret"\s*:\s*"[^"]+"/gi
];

patternsToSanitize.forEach(pattern => {
    sanitizedData = sanitizedData.replace(pattern, (match) => {
        sanitizedCount++;
        const parts = match.split(':');
        return `${parts[0]}: "{{ZEISS_API_KEY}}"`;
    });
});

// Example of replacing simple PII like CPF (just placeholder matching for documentation purposes)
sanitizedData = sanitizedData.replace(/"[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}"/g, () => {
    sanitizedCount++;
    return '"000.000.000-00"';
});

if (!fs.existsSync(outputPathDir)) {
    fs.mkdirSync(outputPathDir, { recursive: true });
}

fs.writeFileSync(outputPath, sanitizedData, 'utf8');

console.log(`Sanitization complete. Secret/PII substitutions made: ${sanitizedCount}`);
console.log(`Sanitized collection written to: docs/api/zeiss/reference/API-ZEISS.sanitized.json`);
