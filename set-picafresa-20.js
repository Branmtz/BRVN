const { createClient } = require('@libsql/client');
require('dotenv').config();

const client = createClient({
  url: process.env.DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN
});

async function main() {
  const upd = await client.execute({
    sql: `UPDATE products SET supplier_price = 20, price = 20 WHERE id = 'test-gratis'`,
    args: []
  });
  console.log(`Filas actualizadas: ${upd.rowsAffected}`);

  const check = await client.execute({
    sql: "SELECT id, title, supplier_price, price FROM products WHERE id = 'test-gratis'",
    args: []
  });
  console.log('Estado final:', JSON.stringify(check.rows[0], null, 2));
  console.log('✅ Picafresa actualizada a $20 MXN.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
