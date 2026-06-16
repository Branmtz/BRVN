const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');

const envPath = path.resolve(__dirname, '../.env');
const backupPath = path.resolve(__dirname, '../.env.bak');

async function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: JSON.parse(body)
          });
        } catch (e) {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: body
          });
        }
      });
    });

    req.on('error', (e) => reject(e));
    req.write(postData);
    req.end();
  });
}

async function test() {
  console.log('--- STARTING REGISTER STRICTOR VALIDATION TESTS ---');

  // Back up .env
  fs.copyFileSync(envPath, backupPath);
  console.log('Backed up .env to .env.bak');

  let serverProcess;
  try {
    console.log('Starting temp server on port 3001...');
    serverProcess = spawn('node', ['server.js'], {
      env: { ...process.env, PORT: '3001' }
    });

    await wait(7000);

    const testEmail = 'test_verify_strict_' + Date.now() + '@gmail.com';
    console.log(`\n--- 1. Registering user: ${testEmail} ---`);
    const regRes = await postJSON('http://localhost:3001/api/auth/register', {
      nombre: 'Test',
      apellido_pat: 'Strict',
      apellido_mat: 'Validation',
      email: testEmail,
      telefono: '5545598011',
      password: 'Password123!'
    });

    console.log('Register response:', regRes);
    if (regRes.statusCode !== 200 || !regRes.body.success) {
      throw new Error('Failed to register user in test setup');
    }

    // Now query the DB to get the verification code
    const { dbQuery } = require('../database');
    const user = await dbQuery.get("SELECT id FROM users WHERE email = ?", [testEmail]);
    const codeRecord = await dbQuery.get("SELECT code FROM verification_codes WHERE user_id = ? AND used = 0", [user.id]);
    const code = codeRecord.code;
    console.log(`Found generated verification code in DB: ${code}`);

    // Test A: Expiration check (we can simulate by updating expires_at to the past in DB)
    console.log('\n--- 2. Testing code expiration (Setting code to expired) ---');
    await dbQuery.run("UPDATE verification_codes SET expires_at = ? WHERE user_id = ?", [
      new Date(Date.now() - 1000).toISOString(),
      user.id
    ]);

    const expVerifyRes = await postJSON('http://localhost:3001/api/auth/verify-email', {
      email: testEmail,
      code: code
    });
    console.log('Expired code verification response:', expVerifyRes);
    if (expVerifyRes.statusCode === 400 && expVerifyRes.body.error.includes('expirado')) {
      console.log('✅ Success: Expired code rejected as expected.');
    } else {
      throw new Error('Failed: Expired code was not rejected correctly.');
    }

    // Reset expiration for further testing
    await dbQuery.run("UPDATE verification_codes SET expires_at = ? WHERE user_id = ?", [
      new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      user.id
    ]);

    // Test B: Verify code successfully
    console.log('\n--- 3. Testing successful verification ---');
    const verifyRes = await postJSON('http://localhost:3001/api/auth/verify-email', {
      email: testEmail,
      code: code
    });
    console.log('Verification response:', verifyRes);
    if (verifyRes.statusCode === 200 && verifyRes.body.success) {
      console.log('✅ Success: User verified successfully.');
    } else {
      throw new Error('Failed: Verification rejected valid code.');
    }

    // Test C: Valid only 1 occasion (Try to verify again)
    console.log('\n--- 4. Testing reuse of code (Valid only 1 occasion) ---');
    const reuseVerifyRes = await postJSON('http://localhost:3001/api/auth/verify-email', {
      email: testEmail,
      code: code
    });
    console.log('Reuse verification response:', reuseVerifyRes);
    if (reuseVerifyRes.statusCode === 400) {
      console.log('✅ Success: Code reuse blocked (valid only once).');
    } else {
      throw new Error('Failed: Verification allowed code reuse.');
    }

    // Test D: Register again check
    console.log('\n--- 5. Testing duplicate registration (Once verified, cannot register again) ---');
    const dupRegRes = await postJSON('http://localhost:3001/api/auth/register', {
      nombre: 'Test',
      apellido_pat: 'Strict',
      apellido_mat: 'Validation',
      email: testEmail,
      telefono: '5545598011',
      password: 'Password123!'
    });
    console.log('Duplicate register response:', dupRegRes);
    if (dupRegRes.statusCode === 400 && dupRegRes.body.error.includes('ya está registrado')) {
      console.log('✅ Success: Duplicate registration of verified account blocked.');
    } else {
      throw new Error('Failed: Allowed registering verified email again.');
    }

    // Test E: Resend code check on verified account
    console.log('\n--- 6. Testing code resend on verified account (Should be blocked) ---');
    const resendRes = await postJSON('http://localhost:3001/api/auth/resend-code', {
      email: testEmail
    });
    console.log('Resend response on verified account:', resendRes);
    if (resendRes.statusCode === 400 && resendRes.body.error.includes('ya está verificada')) {
      console.log('✅ Success: Code resend on verified account blocked.');
    } else {
      throw new Error('Failed: Allowed code resend on verified account.');
    }

    console.log('\n⭐⭐⭐ ALL STRICTNESS TESTS PASSED SUCCESSFULY! ⭐⭐⭐');

  } catch (err) {
    console.error('❌ Test execution failed:', err);
    process.exitCode = 1;
  } finally {
    if (serverProcess) {
      console.log('Stopping temp server...');
      serverProcess.kill();
    }
    // Restore backup
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, envPath);
      fs.unlinkSync(backupPath);
      console.log('Restored original .env from backup');
    }
    console.log('--- TEST COMPLETE ---');
    process.exit(0);
  }
}

test();
