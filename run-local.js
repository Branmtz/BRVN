// Configura la base de datos local para el entorno de pruebas
process.env.DATABASE_URL = 'file:./paps_store.db';

console.log('--- Iniciando ambiente local con base de datos local (paps_store.db) ---');

// Carga el servidor principal
require('./server.js');
