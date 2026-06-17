const { createClient } = require('@libsql/client');
require('dotenv').config();

const client = createClient({
  url: process.env.DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN
});

async function main() {
  // Add shipping_cost column if it doesn't exist
  try {
    await client.execute({ sql: 'ALTER TABLE orders ADD COLUMN shipping_cost REAL DEFAULT 0', args: [] });
    console.log('✅ Columna shipping_cost agregada a la tabla orders.');
  } catch (err) {
    if (err.message && err.message.includes('duplicate column')) {
      console.log('ℹ️  La columna shipping_cost ya existe.');
    } else {
      throw err;
    }
  }

  // Verify schema
  const schema = await client.execute({ sql: "PRAGMA table_info(orders)", args: [] });
  const cols = schema.rows.map(r => r[1]);
  console.log('Columnas actuales:', cols.join(', '));
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
