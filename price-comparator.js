/**
 * price-comparator.js
 * Motor de comparación de precios BRVN × Mercado Libre
 *
 * Lógica de precios:
 *   BRVN_200 = (supplier_price + 200 + 100) / (1 - 0.034)  → ganancia preferida $200
 *   BRVN_150 = (supplier_price + 150 + 100) / (1 - 0.034)  → ganancia mínima $150
 *
 * Reglas de publicación (en orden de prioridad):
 *   1. BRVN_200 < ML          → subir precio a ML exacto (máxima ganancia)
 *   2. ML ≤ BRVN_200 ≤ ML+100 → publicar con $200 ganancia
 *   3. BRVN_200 > ML+100      → intentar con BRVN_150
 *        BRVN_150 ≤ ML+100    → publicar con $150 ganancia
 *        BRVN_150 > ML+100    → rechazar
 *   Sin precio en ML          → cola de revisión manual
 */

const { dbQuery } = require('./database');

// ─────────────────────────────────────────────
// Estado del proceso en memoria
// ─────────────────────────────────────────────
let comparisonState = {
  running: false,
  total: 0,
  processed: 0,
  published: 0,
  rejected: 0,
  pendingReview: 0,
  lastRun: null,
  currentProduct: null,
  errors: []
};

function getComparisonState() {
  return { ...comparisonState };
}

// ─────────────────────────────────────────────
// Fórmula de precio BRVN
// ─────────────────────────────────────────────

/**
 * Calcula el precio de venta BRVN:
 *   precio = (supplier_price + ganancia + $100 envío) / (1 - 0.034 comisión MP)
 * Redondeo psicológico: sube al siguiente múltiplo de 50 y resta 1.
 *   Ej: 1,243 → 1,250 - 1 = $1,249
 * @param {number} supplierPrice - Precio socio de Price Shoes
 * @param {number} profit - Ganancia deseada ($200 o $150)
 * @returns {number} Precio BRVN con redondeo psicológico
 */
function calculateBRVNPrice(supplierPrice, profit = 200) {
  if (!supplierPrice || supplierPrice <= 0) return 0;
  const shipping = 100;
  const mpCommission = 0.034;
  const raw = (supplierPrice + profit + shipping) / (1 - mpCommission);
  // Redondeo psicológico: siguiente múltiplo de 50, menos 1
  return Math.ceil(raw / 50) * 50 - 1;
}

// ─────────────────────────────────────────────
// Búsqueda en Mercado Libre (API oficial gratuita)
// ─────────────────────────────────────────────

/**
 * Busca el precio de un producto en Mercado Libre México.
 * Toma el precio más bajo entre los primeros resultados con
 * precio > 0 y disponibilidad > 0.
 * @param {string} query - Término de búsqueda
 * @returns {{ price: number|null, url: string|null, title: string|null }}
 */
async function searchMLPrice(query) {
  try {
    const encoded = encodeURIComponent(query);
    const url = `https://api.mercadolibre.com/sites/MLM/search?q=${encoded}&limit=10&condition=new`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'BRVN-PriceComparator/1.0'
      },
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      console.warn(`[ML Search] HTTP ${response.status} for query: ${query}`);
      return { price: null, url: null, title: null };
    }

    const data = await response.json();
    const results = data.results || [];

    if (results.length === 0) {
      return { price: null, url: null, title: null };
    }

    // Filtrar resultados con precio > 0 y ordenar por precio ascendente
    const validResults = results
      .filter(r => r.price > 0 && r.available_quantity > 0)
      .sort((a, b) => a.price - b.price);

    if (validResults.length === 0) {
      return { price: null, url: null, title: null };
    }

    // Tomar el precio más bajo (primer resultado válido)
    const best = validResults[0];
    return {
      price: best.price,
      url: best.permalink,
      title: best.title
    };
  } catch (err) {
    console.error(`[ML Search] Error searching "${query}":`, err.message);
    return { price: null, url: null, title: null };
  }
}

/**
 * Busca en ML con estrategia de múltiples intentos:
 *   1. Query principal (Marca + Modelo + SKU)
 *   2. Fallback: solo SKU si el primer intento no encontró precio
 * @param {string} primaryQuery - Query principal de búsqueda
 * @param {string|null} sku - SKU del producto (para fallback)
 * @returns {{ price: number|null, url: string|null, title: string|null, queryUsed: string }}
 */
async function searchMLPriceWithFallback(primaryQuery, sku = null) {
  // Intento 1: query principal
  const result = await searchMLPrice(primaryQuery);
  if (result.price) {
    return { ...result, queryUsed: primaryQuery };
  }

  // Intento 2: solo el SKU (si está disponible y es distinto al query principal)
  if (sku && sku.trim() && sku.trim() !== primaryQuery.trim()) {
    console.log(`[ML Search] Sin resultados con "${primaryQuery}". Reintentando con SKU: "${sku}"`);
    await new Promise(r => setTimeout(r, 400));
    const skuResult = await searchMLPrice(sku.trim());
    if (skuResult.price) {
      return { ...skuResult, queryUsed: sku.trim() };
    }
  }

  return { price: null, url: null, title: null, queryUsed: primaryQuery };
}

// ─────────────────────────────────────────────
// Lógica de decisión
// ─────────────────────────────────────────────

/**
 * Aplica las reglas de publicación para un producto.
 * @param {number} supplierPrice - Precio socio PS
 * @param {number} mlPrice - Precio en ML (null si no encontrado)
 * @returns {{ action, finalPrice, profit, reason }}
 */
function applyPricingRules(supplierPrice, mlPrice) {
  const brvn200 = calculateBRVNPrice(supplierPrice, 200);
  const brvn150 = calculateBRVNPrice(supplierPrice, 150);

  // Sin precio en ML → revisión manual
  if (!mlPrice || mlPrice <= 0) {
    return {
      action: 'manual_review',
      finalPrice: brvn200,
      profit: 200,
      reason: 'Producto no encontrado en Mercado Libre'
    };
  }

  // Regla 1: BRVN con $200 es más barato que ML → subir a precio ML
  if (brvn200 < mlPrice) {
    return {
      action: 'publish',
      finalPrice: mlPrice,
      profit: Math.round((mlPrice * (1 - 0.034)) - supplierPrice - 100),
      reason: `BRVN $${brvn200} < ML $${mlPrice} → precio subido a ML`
    };
  }

  // Regla 2: BRVN con $200 está entre ML y ML+$100
  if (brvn200 <= mlPrice + 100) {
    return {
      action: 'publish',
      finalPrice: brvn200,
      profit: 200,
      reason: `BRVN $${brvn200} dentro del rango [$${mlPrice} — $${mlPrice + 100}]`
    };
  }

  // Regla 3: BRVN con $200 es más caro que ML+$100 → intentar con $150
  if (brvn150 <= mlPrice + 100) {
    return {
      action: 'publish',
      finalPrice: brvn150,
      profit: 150,
      reason: `BRVN_200 $${brvn200} > ML+100, pero BRVN_150 $${brvn150} sí entra`
    };
  }

  // Ninguna opción funciona → rechazar
  return {
    action: 'reject',
    finalPrice: null,
    profit: null,
    reason: `BRVN_150 $${brvn150} > ML+100 ($${mlPrice + 100}). No competitivo.`
  };
}

// ─────────────────────────────────────────────
// Determinar categoría de publicación por género
// ─────────────────────────────────────────────
function resolveCategory(gender) {
  const g = (gender || '').toLowerCase();
  if (g.includes('mujer') || g.includes('dama')) return 'Mujer';
  if (g.includes('hombre') || g.includes('caballero')) return 'Hombre';
  return 'Niños';
}

// ─────────────────────────────────────────────
// Construcción del query de búsqueda en ML
// ─────────────────────────────────────────────
/**
 * Construye el query de búsqueda en el formato exacto:
 *   "Marca - Título del producto SKU: {sku}"
 * Ejemplo: "SHOSH - KIT TENIS SLIP ON SKU: 1204452"
 */
function buildSearchQuery(product) {
  const brand = product.brand || '';
  const title = product.title || '';
  const sku   = product.sku   || '';

  // Formato canónico: Marca - Título SKU: {sku}
  const parts = [];
  if (brand) parts.push(brand);
  if (title) parts.push(`- ${title}`);
  if (sku)   parts.push(`SKU: ${sku}`);

  return parts.join(' ').trim();
}

// ─────────────────────────────────────────────
// Procesar un producto individual
// ─────────────────────────────────────────────

/**
 * Evalúa un producto contra ML y aplica las reglas de publicación.
 * Guarda el resultado en price_comparisons y actualiza el producto.
 */
async function compareAndDecide(product) {
  const supplierPrice = product.supplier_price || 0;
  if (supplierPrice <= 0) {
    return { action: 'skip', reason: 'Sin precio de proveedor' };
  }

  const query = buildSearchQuery(product);
  console.log(`[Comparador] Buscando en ML: "${query}"`);

  // Pequeña pausa para no saturar la API de ML
  await new Promise(r => setTimeout(r, 600));

  const mlResult = await searchMLPriceWithFallback(query, product.sku);
  if (mlResult.queryUsed && mlResult.queryUsed !== query) {
    console.log(`[Comparador] Precio encontrado con query de respaldo: "${mlResult.queryUsed}"`);
  }
  const decision = applyPricingRules(supplierPrice, mlResult.price);

  console.log(`[Comparador] SKU ${product.sku} → ${decision.action.toUpperCase()} | Precio: $${decision.finalPrice} | ML: $${mlResult.price} | ${decision.reason}`);

  // Guardar resultado en price_comparisons
  await dbQuery.run(`
    INSERT INTO price_comparisons (
      product_id, sku, brvn_price, ml_price, ml_url, ml_title,
      status, rejection_reason, compared_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `, [
    product.id,
    product.sku,
    decision.finalPrice,
    mlResult.price,
    mlResult.url,
    mlResult.title,
    decision.action,
    decision.action === 'reject' || decision.action === 'manual_review' ? decision.reason : null
  ]);

  // Actualizar estado del producto
  const comparisonStatus = decision.action === 'publish' ? 'auto_published'
    : decision.action === 'manual_review' ? 'pending_review'
    : 'rejected';

  if (decision.action === 'publish') {
    const category = resolveCategory(product.gender);
    await dbQuery.run(`
      UPDATE products SET
        price = ?,
        status = 'active',
        category = ?,
        comparison_status = 'auto_published'
      WHERE id = ?
    `, [decision.finalPrice, category, product.id]);
  } else {
    await dbQuery.run(`
      UPDATE products SET comparison_status = ? WHERE id = ?
    `, [comparisonStatus, product.id]);
  }

  return {
    ...decision,
    mlPrice: mlResult.price,
    mlUrl: mlResult.url,
    query
  };
}

// ─────────────────────────────────────────────
// Comparación masiva en background
// ─────────────────────────────────────────────

/**
 * Procesa todos los tenis bestsellers que aún no han sido comparados.
 * Se ejecuta en background y actualiza comparisonState en tiempo real.
 */
async function runBulkComparison() {
  if (comparisonState.running) {
    console.log('[Comparador] Ya hay una comparación en curso. Ignorando.');
    return;
  }

  // Obtener productos elegibles: tenis + bestseller + sin comparación previa
  const products = await dbQuery.all(`
    SELECT * FROM products
    WHERE is_bestseller = 1
      AND status = 'active'
      AND (comparison_status IS NULL OR comparison_status = 'pending_review')
      AND (
        UPPER(title) LIKE '%TENIS%'
        OR UPPER(specifications) LIKE '%"Subcategoría":"CHOCLO"%'
        OR UPPER(specifications) LIKE '%"Subcategoría":"CORRER"%'
        OR UPPER(specifications) LIKE '%"Subcategoría":"SKATE"%'
        OR UPPER(specifications) LIKE '%"Subcategoría":"ENTRENAMIENTO"%'
        OR UPPER(specifications) LIKE '%"Subcategoría":"BASKETBALL"%'
        OR UPPER(specifications) LIKE '%"Subcategoría":"CAMINAR"%'
      )
    ORDER BY brand ASC
  `);

  comparisonState = {
    running: true,
    total: products.length,
    processed: 0,
    published: 0,
    rejected: 0,
    pendingReview: 0,
    lastRun: new Date().toISOString(),
    currentProduct: null,
    errors: []
  };

  console.log(`[Comparador] Iniciando comparación masiva. ${products.length} tenis bestsellers encontrados.`);

  for (const product of products) {
    comparisonState.currentProduct = `${product.brand} — ${product.title}`;
    try {
      const result = await compareAndDecide(product);
      comparisonState.processed++;

      if (result.action === 'publish') comparisonState.published++;
      else if (result.action === 'manual_review') comparisonState.pendingReview++;
      else if (result.action === 'reject') comparisonState.rejected++;
    } catch (err) {
      console.error(`[Comparador] Error procesando SKU ${product.sku}:`, err.message);
      comparisonState.errors.push({ sku: product.sku, error: err.message });
      comparisonState.processed++;
    }
  }

  comparisonState.running = false;
  comparisonState.currentProduct = null;
  console.log(`[Comparador] Completado. Publicados: ${comparisonState.published} | Rechazados: ${comparisonState.rejected} | Revisión manual: ${comparisonState.pendingReview}`);
}

// ─────────────────────────────────────────────
// Aprobar manualmente un producto de la cola
// ─────────────────────────────────────────────

/**
 * Aprueba un producto de la cola de revisión manual y lo publica.
 * @param {string} productId - ID del producto a aprobar
 * @param {number} manualPrice - Precio de publicación definido por el admin
 */
async function approveManualProduct(productId, manualPrice) {
  const product = await dbQuery.get('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw new Error('Producto no encontrado');

  const category = resolveCategory(product.gender);
  const price = manualPrice || calculateBRVNPrice(product.supplier_price, 200);

  await dbQuery.run(`
    UPDATE products SET
      price = ?,
      status = 'active',
      category = ?,
      comparison_status = 'manual_approved'
    WHERE id = ?
  `, [price, category, productId]);

  await dbQuery.run(`
    UPDATE price_comparisons SET
      status = 'manual_approved',
      published_at = datetime('now')
    WHERE product_id = ? AND status = 'pending_review'
  `, [productId]);

  return { success: true, price, category };
}

/**
 * Rechaza manualmente un producto de la cola.
 */
async function rejectManualProduct(productId, reason = 'Rechazado manualmente') {
  await dbQuery.run(`
    UPDATE products SET comparison_status = 'rejected' WHERE id = ?
  `, [productId]);
  await dbQuery.run(`
    UPDATE price_comparisons SET status = 'rejected', rejection_reason = ?
    WHERE product_id = ? AND status = 'pending_review'
  `, [reason, productId]);
  return { success: true };
}

module.exports = {
  calculateBRVNPrice,
  searchMLPrice,
  searchMLPriceWithFallback,
  applyPricingRules,
  compareAndDecide,
  runBulkComparison,
  approveManualProduct,
  rejectManualProduct,
  getComparisonState
};
