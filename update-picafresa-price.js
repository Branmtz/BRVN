const { createClient } = require('@libsql/client');
require('dotenv').config();

const client = createClient({
  url: process.env.DATABASE_URL,
  authToken: process.env.DATABASE_AUTH_TOKEN
});

async function main() {
  const upd = await client.execute({
    sql: `UPDATE products SET
      description    = 'Picafresa suelta.',
      sku            = 'PICAFRESA-002',
      color          = 'Fresa',
      origin         = 'BRVN',
      price          = 1,
      supplier_price = 1
    WHERE id = 'test-gratis'`,
    args: []
  });

  console.log(`Filas actualizadas: ${upd.rowsAffected}`);

  const check = await client.execute({
    sql: "SELECT id, title, description, sku, color, price, supplier_price FROM products WHERE id = 'test-gratis'",
    args: []
  });
  console.log('\nEstado final de test-gratis:');
  console.log(JSON.stringify(check.rows[0], null, 2));
  console.log('\n✅ test-gratis actualizado con los datos de Picafresa.');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
