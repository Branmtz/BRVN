const { dbQuery } = require('../database');
const bcrypt = require('bcryptjs');

async function test() {
  const email = 'test_reg_' + Date.now() + '@gmail.com';
  const nombre = 'Test';
  const apellido_pat = 'Register';
  const apellido_mat = 'Test';
  const telefono = '5545598011';
  const password = 'Password123!';

  console.log('Testing with email:', email);

  try {
    const existing = await dbQuery.get("SELECT id, verified FROM users WHERE LOWER(email) = ?", [email.trim().toLowerCase()]);
    console.log('Existing:', existing);

    const passwordHash = await bcrypt.hash(password, 12);
    console.log('Password hash generated');

    const result = await dbQuery.run(`
      INSERT INTO users (nombre, apellido_pat, apellido_mat, email, telefono, password, verified)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `, [nombre.trim(), apellido_pat.trim(), apellido_mat.trim(), email.trim().toLowerCase(), telefono.trim(), passwordHash]);

    console.log('Insert user result:', result);

    const userId = result.lastID;
    console.log('userId:', userId);

    const code = '123456';
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

    const codeResult = await dbQuery.run(`
      INSERT INTO verification_codes (code, user_id, expires_at, used, attempts)
      VALUES (?, ?, ?, 0, 0)
    `, [code, userId, expiresAt]);

    console.log('Insert verification code result:', codeResult);
  } catch (err) {
    console.error('ERROR during registration steps:', err);
  } finally {
    process.exit(0);
  }
}

test();
