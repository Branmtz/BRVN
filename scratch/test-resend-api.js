const http = require('https');
require('dotenv').config();

async function test() {
  const apiKey = process.env.SMTP_PASS;
  if (!apiKey || !apiKey.startsWith('re_')) {
    console.error('No valid Resend API key found in SMTP_PASS');
    process.exit(1);
  }

  const postData = JSON.stringify({
    from: 'B R V N <noreply@brvn.com.mx>',
    to: ['mrtinezbrandon@gmail.com'],
    subject: 'Test Resend API',
    html: '<p>This is a test using Resend HTTP API instead of SMTP.</p>'
  });

  const options = {
    hostname: 'api.resend.com',
    port: 443,
    path: '/emails',
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', (chunk) => body += chunk);
    res.on('end', () => {
      console.log('Status Code:', res.statusCode);
      console.log('Response Body:', body);
      process.exit(0);
    });
  });

  req.on('error', (e) => {
    console.error('Request error:', e);
    process.exit(1);
  });

  req.write(postData);
  req.end();
}

test();
