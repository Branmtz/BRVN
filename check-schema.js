const { dbQuery, db } = require('./database');

async function run() {
  try {
    const productsCols = await dbQuery.all("PRAGMA table_info(products)");
    console.log("PRODUCTS COLUMNS:");
    productsCols.forEach(col => console.log(`- ${col.name} (${col.type})`));

    const sourcesCols = await dbQuery.all("PRAGMA table_info(catalog_sources)");
    console.log("\nCATALOG_SOURCES COLUMNS:");
    sourcesCols.forEach(col => console.log(`- ${col.name} (${col.type})`));
  } catch (err) {
    console.error("Error checking database schema:", err);
  } finally {
    if (db && typeof db.close === 'function') {
      db.close();
    }
    process.exit(0);
  }
}

run();
