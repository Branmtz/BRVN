/**
 * fix-prices.js
 * Script de una sola vez: actualiza supplier_price de todos los productos
 * al precio Socio (price_member) obtenido de la API de PriceShoes.
 * 
 * Uso: node fix-prices.js
 */

const sqlite3 = require('sqlite3').verbose();
const { chromium } = require('playwright');
const path = require('path');

const dbPath = path.join(__dirname, 'paps_store.db');
const db = new sqlite3.Database(dbPath);

const CONCURRENCY = 8;  // Número de peticiones simultáneas
const DELAY_MS = 100;    // Pausa mínima entre lotes de peticiones

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err); else resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err); else resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err); else resolve(this.changes);
    });
  });
}

async function getCognitoToken() {
  console.log('Iniciando navegador Playwright para interceptar token de Cognito...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();

  let apiHeaders = null;
  const apiPromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Timeout esperando token de búsqueda')), 40000);
    page.on('request', (request) => {
      const url = request.url();
      if (url.includes('v1/search/products')) {
        clearTimeout(timeout);
        resolve({
          headers: request.headers()
        });
      }
    });
  });

  await page.goto('https://www.priceshoes.com/buscar?page=1&catalogs=URBANO+%7C+PRI-VER+%7C+2026+%7C+1E', { waitUntil: 'load', timeout: 50000 });
  const result = await apiPromise;
  await browser.close();
  console.log('Token de Cognito obtenido exitosamente.');
  return result.headers;
}

async function main() {
  console.log('Iniciando actualización de precios a Precio Socio (price_member)...\n');

  // 1. Obtener headers de autorización
  let headers;
  try {
    headers = await getCognitoToken();
  } catch (err) {
    console.error('No se pudo obtener el token de autorización:', err.message);
    process.exit(1);
  }

  const requestHeaders = {
    'Content-Type': 'application/json',
    'authorization': headers['authorization'],
    'referer': 'https://www.priceshoes.com/',
    'suggestions-session-id': headers['suggestions-session-id'] || '',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };

  // 2. Obtener productos de la base de datos
  const products = await dbAll("SELECT id, sku, title, supplier_price FROM products WHERE origin = 'priceshoes'");
  console.log(`Total productos en base de datos: ${products.length}`);

  let updated = 0;
  let unchanged = 0;
  let notFound = 0;
  let errors = 0;
  let processed = 0;

  // Función para procesar un solo producto
  async function processProduct(product) {
    const sku = product.sku;
    // Ignorar SKUs de prueba
    if (sku.startsWith('TEST') || sku === '1' || isNaN(parseInt(sku))) {
      unchanged++;
      processed++;
      return;
    }

    const targetUrl = `https://api.priceshoes.digital/v1/search/products/${sku}`;

    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: requestHeaders
      });

      if (res.status === 404) {
        notFound++;
        processed++;
        return;
      }

      if (!res.ok) {
        throw new Error(`Status ${res.status}`);
      }

      const data = await res.json();
      const memberPrice = data.price_member || data.price_customer || 0;

      if (memberPrice > 0 && memberPrice !== product.supplier_price) {
        await dbRun("UPDATE products SET supplier_price = ? WHERE id = ?", [memberPrice, product.id]);
        console.log(`[UPDATED] SKU ${sku}: $${product.supplier_price} -> $${memberPrice} (${product.title.slice(0, 30)})`);
        updated++;
      } else {
        unchanged++;
      }
    } catch (err) {
      console.error(`[ERROR] SKU ${sku}: ${err.message}`);
      errors++;
    }
    processed++;
  }

  // Ejecución concurrente controlada por lotes
  for (let i = 0; i < products.length; i += CONCURRENCY) {
    const batch = products.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(p => processProduct(p)));
    
    if (processed % 100 === 0 || processed === products.length) {
      console.log(`Progreso: ${processed}/${products.length} | Actualizados: ${updated} | Sin cambio: ${unchanged} | No encontrados (404): ${notFound} | Errores: ${errors}`);
    }
    await sleep(DELAY_MS);
  }

  console.log('\nResumen Final:');
  console.log(`  Procesados:     ${processed}`);
  console.log(`  Actualizados:   ${updated}`);
  console.log(`  Sin cambio:     ${unchanged}`);
  console.log(`  No encontrados: ${notFound}`);
  console.log(`  Errores:        ${errors}`);
  console.log('\n¡Listo! Todos los precios actualizados a Precio Socio.');
  db.close();
}

main().catch(err => {
  console.error('Error fatal:', err);
  db.close();
  process.exit(1);
});
