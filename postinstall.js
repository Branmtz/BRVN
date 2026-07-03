const { execSync } = require('child_process');
const path = require('path');

// Set browsers path to local project folder for Render deployment package persistence
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, 'ms-playwright');

console.log("Installing Playwright Chromium in local project folder:", process.env.PLAYWRIGHT_BROWSERS_PATH);
try {
  execSync('npx playwright install chromium', { stdio: 'inherit' });
  console.log("Playwright Chromium installed successfully!");
} catch (err) {
  console.error("Playwright installation failed:", err.message);
  process.exit(1);
}
