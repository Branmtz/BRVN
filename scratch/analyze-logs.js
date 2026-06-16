const fs = require('fs');
const path = require('path');

const logPath = path.resolve('C:\\Users\\01\\.gemini\\antigravity\\brain\\300ca336-d6db-4108-857e-33d7169aad69\\.system_generated\\tasks\\task-1049.log');

if (fs.existsSync(logPath)) {
  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.split('\n');
  let matchCount = 0;
  lines.forEach((line, idx) => {
    const lower = line.toLowerCase();
    if (lower.includes('error') || lower.includes('exception') || lower.includes('busy') || lower.includes('locked') || lower.includes('fail')) {
      console.log(`Line ${idx + 1}: ${line}`);
      matchCount++;
    }
  });
  console.log(`Total matching lines: ${matchCount}`);
} else {
  console.log('Log file does not exist at:', logPath);
}
