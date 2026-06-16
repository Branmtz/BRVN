const { dbQuery } = require('../database');

async function run() {
  const email = 'mrtinezbrandon@gmail.com';
  try {
    console.log('Querying Turso database for user:', email);
    const user = await dbQuery.get("SELECT * FROM users WHERE LOWER(email) = ?", [email.toLowerCase()]);
    if (!user) {
      console.log('User not found in database!');
      return;
    }
    console.log('User details:', {
      id: user.id,
      nombre: user.nombre,
      email: user.email,
      verified: user.verified
    });

    const codes = await dbQuery.all("SELECT * FROM verification_codes WHERE user_id = ? ORDER BY id DESC LIMIT 5", [user.id]);
    console.log('Latest verification codes:');
    codes.forEach(c => {
      console.log(`Code: ${c.code} | Created: ${c.created_at} | Expires: ${c.expires_at} | Used: ${c.used}`);
    });
  } catch (err) {
    console.error('Database query error:', err.message);
  }
}

run();
