const sqlite3 = require('sqlite3').verbose();
const { createClient } = require('@libsql/client');
const path = require('path');
require('dotenv').config();

// Ensure we have remote credentials
const dbUrl = process.env.DATABASE_URL;
const authToken = process.env.DATABASE_AUTH_TOKEN || '';

if (!dbUrl || dbUrl.startsWith('file:')) {
  console.error('Error: DATABASE_URL debe estar configurada en tu archivo .env y apuntar a tu base de datos remota de Turso (libsql://...).');
  process.exit(1);
}

const localDbPath = path.resolve(__dirname, 'paps_store.db');
console.log(`Abriendo base de datos local en: ${localDbPath}`);
const localDb = new sqlite3.Database(localDbPath);

console.log(`Conectando a la base de datos remota de Turso: ${dbUrl}`);
const remoteClient = createClient({
  url: dbUrl,
  authToken: authToken
});

// Helpers to run local DB queries with promises
function localAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    localDb.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

async function migrate() {
  try {
    // 1. Ensure schema is initialized on remote by importing database.js (loads environment variables)
    console.log('Inicializando esquema en la base de datos remota...');
    const { dbQuery } = require('./database'); 
    
    // Give table creations 2 seconds to complete
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2. Fetch local tables (excluding sqlite internal tables)
    const tables = await localAll("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
    console.log(`Se encontraron ${tables.length} tablas locales para migrar:`, tables.map(t => t.name).join(', '));

    for (const { name: tableName } of tables) {
      console.log(`\nMigrando tabla: ${tableName}...`);
      
      const rows = await localAll(`SELECT * FROM ${tableName}`);
      console.log(`Leídas ${rows.length} filas de la tabla local ${tableName}.`);
      
      if (rows.length === 0) {
        console.log(`Tabla ${tableName} vacía. Saltando.`);
        continue;
      }

      // Prepare batch inserts
      const columns = Object.keys(rows[0]);
      const placeholders = columns.map(() => '?').join(', ');
      const insertSql = `INSERT OR REPLACE INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;

      let count = 0;
      const batchSize = 50;
      for (let i = 0; i < rows.length; i += batchSize) {
        const chunk = rows.slice(i, i + batchSize);
        const statements = chunk.map(row => {
          const args = columns.map(col => row[col]);
          return {
            sql: insertSql,
            args: args
          };
        });

        await remoteClient.batch(statements, "write");
        count += chunk.length;
        console.log(`Migradas ${count}/${rows.length} filas en ${tableName}...`);
      }
      console.log(`¡Tabla ${tableName} migrada exitosamente!`);
    }

    console.log('\n=========================================');
    console.log('¡MIGRACIÓN A TURSO COMPLETADA CON ÉXITO!');
    console.log('=========================================');
  } catch (err) {
    console.error('Error durante la migración:', err);
  } finally {
    localDb.close();
    process.exit(0);
  }
}

migrate();
