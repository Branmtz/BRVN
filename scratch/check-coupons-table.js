const { dbQuery } = require('../database');

async function check() {
  try {
    // Wait a bit to ensure initialization finished
    await new Promise(resolve => setTimeout(resolve, 3000));

    const tableInfo = await dbQuery.all("PRAGMA table_info(user_coupons)");
    console.log('USER_COUPONS COLUMNS:');
    console.log(tableInfo);
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

check();
