const { dbQuery } = require('../database');

async function check() {
  try {
    const user = await dbQuery.get("SELECT * FROM users WHERE LOWER(email) = ?", ['mrtinezbrandon@gmail.com']);
    console.log('User:');
    console.log(user);

    const codes = await dbQuery.all("SELECT * FROM verification_codes");
    console.log('Verification Codes:', codes);

    const allUsers = await dbQuery.all("SELECT id, nombre, email, verified FROM users");
    console.log('All Users:', allUsers);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

check();
