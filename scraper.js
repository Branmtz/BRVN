const { chromium } = require('playwright');
const { dbQuery } = require('./database');

// Persistent browser manager to avoid launching Chromium on every request
let persistentBrowser = null;
let persistentBrowserPromise = null;

async function getBrowserInstance() {
  try {
    if (persistentBrowser) {
      if (persistentBrowser.isConnected()) {
        return persistentBrowser;
      } else {
        console.log('[Browser Manager] Persistent browser disconnected. Cleaning up...');
        try { await persistentBrowser.close(); } catch (e) {}
        persistentBrowser = null;
        persistentBrowserPromise = null;
      }
    }

    if (!persistentBrowserPromise) {
      console.log('[Browser Manager] Launching persistent Chromium instance...');
      persistentBrowserPromise = chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
      }).then(browser => {
        persistentBrowser = browser;
        browser.on('disconnected', () => {
          console.log('[Browser Manager] Browser disconnected.');
          persistentBrowser = null;
          persistentBrowserPromise = null;
        });
        return browser;
      }).catch(err => {
        persistentBrowserPromise = null;
        throw err;
      });
    }
    return await persistentBrowserPromise;
  } catch (err) {
    console.error('[Browser Manager] Failed to launch Chromium:', err.message);
    throw err;
  }
}


/**
 * Normalizes gender value from the department or gender fields
 */
function normalizeGender(dept, gend) {
  const value = (dept || gend || '').toUpperCase();
  if (value.includes('CABALLERO') || value.includes('HOMBRE') || value.includes('MEN')) {
    return 'Hombre';
  }
  if (value.includes('DAMA') || value.includes('MUJER') || value.includes('WOMEN')) {
    return 'Mujer';
  }
  if (value.includes('NIÑO') || value.includes('NIÑA') || value.includes('KIDS') || value.includes('INFANTIL')) {
    return 'Niños';
  }
  return 'Unisex';
}

/**
 * Normalizes color value
 */
function normalizeColor(colorStr) {
  if (!colorStr) return 'Único';
  const parts = colorStr.split('|');
  return parts[0].trim();
}

/**
 * Visits a product page and extracts the sizes and total stock available specifically in the "Ecatepec" store.
 * Returns only the sizes that are actually in stock (> 0 pairs) at the Ecatepec store.
 */
async function getOnlineStoreSizes(browser, originalUrl, fallbackSizes) {
  console.log(`[Scraper] Checking Tienda Virtual (online) stock for: ${originalUrl}`);
  
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  
  const onlineSizes = [];
  const processedSizes = new Set();
  const sizesStockMap = {};
  let totalStock = 0;
  let isBestseller = 0;
  
  // Set up response listener to intercept inventories responses
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('nearby-stores/inventories/')) {
      try {
        const text = await response.text();
        const json = JSON.parse(text);
        const sizeLabel = json.size_label;
        const inventories = json.store_inventories || [];
        const onlineInfo = inventories.find(store => store.store_name === 'Tienda virtual');
        
        if (onlineInfo) {
          const qty = parseInt(onlineInfo.quantity) || 0;
          sizesStockMap[sizeLabel.toString().trim()] = qty;
          if (qty > 0) {
            onlineSizes.push(sizeLabel.toString().trim());
            totalStock += qty;
          }
        }
        processedSizes.add(sizeLabel.toString().trim());
      } catch (e) {
        // ignore JSON parsing or other errors
      }
    }
  });

  try {
    // Block images, stylesheets, fonts, media, and third-party trackers to make load ultra fast
    await page.route('**/*', (route) => {
      const url = route.request().url();
      const type = route.request().resourceType();
      
      const isTrackerOrUnneeded = 
        url.includes('google-analytics') || 
        url.includes('analytics') || 
        url.includes('gtm.js') || 
        url.includes('facebook') || 
        url.includes('pixel') || 
        url.includes('hotjar') || 
        url.includes('doubleclick') || 
        url.includes('ads') || 
        url.includes('sentry') || 
        url.includes('clarity.ms') ||
        url.includes('datadog');

      if (['image', 'stylesheet', 'font', 'media'].includes(type) || isTrackerOrUnneeded) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    
    // Check if the page contains a "MÁS VENDIDOS" or "MÁS VENDIDO" text banner
    const bestsellerCount = await page.locator('text=/(MÁS|MAS)\\s+VENDIDO(S)?/i').count();
    if (bestsellerCount > 0) {
      isBestseller = 1;
    }

    // Click "Ver disponibilidad en tiendas"
    const storeBtn = page.locator('text=/Ver disponibilidad en tiendas/i');
    // Wait for the button to appear in the DOM
    await storeBtn.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    
    if (await storeBtn.count() > 0) {
      await storeBtn.first().dispatchEvent('click');
      
      // Wait for responses (up to 4.5 seconds or until we processed all fallback sizes)
      const startTime = Date.now();
      const expectedCount = fallbackSizes.length;
      while (processedSizes.size < expectedCount && Date.now() - startTime < 4500) {
        await page.waitForTimeout(150);
      }
    }
  } catch (err) {
    console.warn(`[Scraper] Failed to check online store stock for ${originalUrl}:`, err.message);
  } finally {
    try {
      await page.close();
      await context.close();
    } catch (e) {}
  }

  if (onlineSizes.length > 0) {
    const uniqueSizes = Array.from(new Set(onlineSizes));
    const finalTotalStock = uniqueSizes.reduce((sum, size) => sum + (sizesStockMap[size] || 0), 0);
    console.log(`[Scraper] Tienda Virtual in-stock sizes: ${uniqueSizes.join(', ')} (Total stock: ${finalTotalStock})`);
    return {
      sizes: uniqueSizes,
      stock: finalTotalStock,
      sizesStock: sizesStockMap,
      isBestseller: isBestseller
    };
  }
  
  console.log(`[Scraper] No online store sizes found with stock > 0. Product will be marked inactive.`);
  return {
    sizes: [],
    stock: 0,
    sizesStock: {},
    isBestseller: isBestseller
  };
}

/**
 * Scrapes a search URL from Price Shoes
 * @param {string} searchUrl - The base search URL to scrape
 * @param {number} productLimit - Maximum number of products to scrape (defaults to 30)
 */
let isScrapingActive = false;

async function runScraper(searchUrl, productLimit = 30, category = 'General') {
  if (isScrapingActive) {
    console.log('[Scraper] A scraping task is already active. Skipping execution.');
    return 0;
  }
  isScrapingActive = true;
  console.log(`Starting scraper. Target product limit: ${productLimit}, Category: ${category}`);
  
  let browser;
  let totalSaved = 0;
  
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    
    const page = await context.newPage();
    
    // Intercept search API request info (token, API endpoint, filter body)
    let apiInfo = null;
    const apiPromise = new Promise((resolve) => {
      page.on('request', (request) => {
        const url = request.url();
        if (url.includes('v1/search/products')) {
          resolve({
            url: url,
            headers: request.headers(),
            method: request.method(),
            postData: request.postDataJSON()
          });
        }
      });
    });

    console.log(`Navigating to Price Shoes to intercept Cognito tokens: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: 'load', timeout: 50000 });
    
    // Wait for the first API call to trigger and get resolved
    const apiData = await Promise.race([
      apiPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout waiting for search API call interception.')), 25000))
    ]);
    
    console.log(`Successfully intercepted search API query. Base URL: ${apiData.url}`);
    
    let from = 0;
    const pageSize = 18;
    const filterBody = apiData.postData;
    const authHeader = apiData.headers['authorization'];
    const suggestionsSessionId = apiData.headers['suggestions-session-id'] || '';
    
    const requestHeaders = {
      'Content-Type': 'application/json',
      'authorization': authHeader,
      'referer': 'https://www.priceshoes.com/',
      'suggestions-session-id': suggestionsSessionId
    };

    console.log(`Starting direct API paginated fetch loop (Limit: ${productLimit})...`);
    
    while (totalSaved < productLimit) {
      let fetchUrl = apiData.url;
      if (fetchUrl.includes('from=')) {
        fetchUrl = fetchUrl.replace(/from=\d+/, `from=${from}`);
      } else {
        const separator = fetchUrl.includes('?') ? '&' : '?';
        fetchUrl = `${fetchUrl}${separator}from=${from}`;
      }
      
      console.log(`Fetching products from offset index ${from} (Saved: ${totalSaved}/${productLimit})...`);
      
      const responseJson = await page.evaluate(async ({ url, method, headers, body }) => {
        const res = await fetch(url, {
          method: method,
          headers: headers,
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`Fetch failed with status ${res.status}`);
        return res.json();
      }, { url: fetchUrl, method: apiData.method, headers: requestHeaders, body: filterBody });
      
      if (!responseJson || !responseJson.hits || !responseJson.hits.hits || responseJson.hits.hits.length === 0) {
        console.log('No more hits returned from search API. Stopping.');
        break;
      }
      
      const hits = responseJson.hits.hits;
      console.log(`Received ${hits.length} products on this batch.`);
      
      const pageProducts = [];
      for (const hit of hits) {
        const source = hit._source;
        if (source) {
          const sku = source.product_id || hit._id;
          const title = `${source.brand || ''} - ${source.name || ''}`.trim();
          const description = source.material ? `Material: ${source.material}. Subcategoría: ${source.subcategory || ''}` : `Calzado importado. Marca: ${source.brand || ''}`;
          // price_member   = precio de socio/costo (ej. $549) — se usa como nuestro costo en BRVN
          // price_customer = precio público del catálogo (ej. $749) — se guarda como ps_public_price para referencia
          const supplierPrice = source.price_member || source.price_customer || 0;
          const psPublicPrice = source.price_customer || null;
          const fallbackSizes = Array.isArray(source.sizes) ? Array.from(new Set(source.sizes.map(s => s.toString()))) : [];
          const images = Array.isArray(source.images) 
            ? source.images.map(img => `https://res.cloudinary.com/priceshoes/image/upload/${img.startsWith('/') ? img.slice(1) : img}`)
            : [];
          
          const color = normalizeColor(source.color);
          const gender = normalizeGender(source.department, source.gender);
          const originalUrl = source.url_key 
            ? `https://www.priceshoes.com/productos/${source.url_key}`
            : `https://www.priceshoes.com/productos/${sku}`;
          
          // Query the online store (Tienda Virtual) stock for this product
          console.log(`[Scraper] Querying Tienda Virtual stock for product: ${title} (${sku})`);
          const onlineStoreData = await getOnlineStoreSizes(browser, originalUrl, fallbackSizes);
          const sizes = onlineStoreData.sizes;
          const stock = onlineStoreData.stock;
          const sizesStock = onlineStoreData.sizesStock;
          
          // Detect bestseller status from API labels/flags OR page text
          const hasBestsellerLabel = (source.bestseller === true) || (Array.isArray(source.labels) && source.labels.some(label => {
            const l = label.toString().toUpperCase();
            return l.includes('MÁS VENDIDO') || l.includes('MAS VENDIDO') || l.includes('MÁS VENDIDOS') || l.includes('MAS VENDIDOS');
          }));
          const isBestseller = (hasBestsellerLabel || onlineStoreData.isBestseller) ? 1 : 0;

          const Marca = source.brand || null;
          const Modelo = source.model || null;
          const Material = source.material || null;
          const Color = color;
          const Subcategoría = source.subcategory || null;
          const Acabado = source.distinctive || null;
          const Género = gender;
          const specifications = JSON.stringify({ Marca, Modelo, Material, Color, Subcategoría, Acabado, Género });

          pageProducts.push({
            id: `ps-${sku}`,
            sku: sku,
            title: title,
            description: description,
            supplier_price: supplierPrice,
            ps_public_price: psPublicPrice,
            images: JSON.stringify(images),
            sizes: JSON.stringify(sizes),
            sizes_stock: JSON.stringify(sizesStock),
            color: color,
            gender: gender,
            origin: 'priceshoes',
            original_url: originalUrl,
            stock: stock,
            status: 'active',
            category: category,
            brand: source.brand || 'Otros',
            specifications: specifications,
            is_bestseller: isBestseller
          });
        }
      }
      
      let savedOnThisPage = 0;
      for (const item of pageProducts) {
        if (totalSaved >= productLimit) {
          break;
        }
        
        try {
          // Check if product already exists to avoid overwriting its category
          const existing = await dbQuery.get('SELECT id, category FROM products WHERE sku = ?', [item.sku]);
          
          if (existing) {
            // Si stock=0 y sin tallas → marcar inactivo; si hay stock → marcar activo
            const effectiveStatus = (item.stock === 0 && JSON.parse(item.sizes).length === 0) ? 'inactive' : 'active';
            // Update product data but PRESERVE existing category to prevent cross-category corruption
            await dbQuery.run(`
              UPDATE products SET
                title=?, description=?, supplier_price=?, ps_public_price=?, images=?, sizes=?, sizes_stock=?,
                color=?, gender=?, original_url=?, stock=?, status=?, brand=?,
                specifications=?, is_bestseller=?
              WHERE sku=?
            `, [
              item.title, item.description, item.supplier_price, item.ps_public_price, item.images, item.sizes, item.sizes_stock,
              item.color, item.gender, item.original_url, item.stock, effectiveStatus, item.brand,
              item.specifications, item.is_bestseller, item.sku
            ]);
            if (effectiveStatus === 'inactive') {
              console.log(`[Scraper] SKU ${item.sku} marcado INACTIVO (sin stock en Ecatepec).`);
            }
            // Don't count updates toward the limit — only new products count
          } else {
            // Producto nuevo — solo insertar si tiene stock real en Ecatepec
            if (item.stock === 0 && JSON.parse(item.sizes).length === 0) {
              console.log(`[Scraper] SKU ${item.sku} omitido (nuevo sin stock en Ecatepec).`);
            } else {
              await dbQuery.run(`
                INSERT INTO products (
                  id, sku, title, description, price, supplier_price, ps_public_price, images, sizes, sizes_stock, color, gender, origin, original_url, stock, status, category, brand, specifications, is_bestseller
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `, [
                item.id, item.sku, item.title, item.description, null,
                item.supplier_price, item.ps_public_price, item.images, item.sizes, item.sizes_stock, item.color, item.gender,
                item.origin, item.original_url, item.stock, item.status, item.category, item.brand,
                item.specifications, item.is_bestseller
              ]);
              totalSaved++;
              savedOnThisPage++;
            }
          }
        } catch (dbErr) {
          console.error(`DB Error saving product SKU ${item.sku}:`, dbErr.message);
        }
      }
      
      console.log(`Saved ${savedOnThisPage} new products from this page (Total Saved: ${totalSaved}/${productLimit}). Updated ${hits.length - savedOnThisPage} existing products.`);
      from += pageSize;
      
      // If this batch had no new insertions and we got a full page, the catalog is mostly already synced.
      // Stop to prevent unnecessary extra pages.
      if (savedOnThisPage === 0 && hits.length < pageSize) {
        console.log('Last page reached with no new products. Stopping.');
        break;
      }
      
      // Delay to avoid spamming the backend too fast
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  } catch (error) {
    console.error("Scraper encountered an error:", error);
  } finally {
    if (browser) {
      console.log("Closing browser context...");
      try {
        await browser.close();
      } catch (closeErr) {
        console.error("Error closing browser:", closeErr.message);
      }
    }
    isScrapingActive = false;
    console.log(`Scraper completed. Total items synchronized: ${totalSaved}`);
  }
  return totalSaved;
}

/**
 * Recursively searches for the sizes array in a Next.js JSON payload
 */
function findSizesInJSON(obj) {
  if (!obj || typeof obj !== 'object') return null;
  
  // Try to find the new structure: props.pageProps.productInitial.children
  try {
    const product = obj.props?.pageProps?.productInitial;
    if (product && Array.isArray(product.children)) {
      const sizes = [];
      for (const child of product.children) {
        if (Array.isArray(child.custom_attributes)) {
          const sizeAttr = child.custom_attributes.find(attr => attr.attribute_code === 'size_label');
          if (sizeAttr && sizeAttr.value) {
            sizes.push(sizeAttr.value.toString().trim());
          }
        }
      }
      if (sizes.length > 0) return sizes;
    }
  } catch (err) {
    // ignore errors and proceed to fallback
  }

  // Fallback to old recursive search
  if (obj.product_id && Array.isArray(obj.sizes)) {
    return obj.sizes;
  }
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key) && typeof obj[key] === 'object') {
      const res = findSizesInJSON(obj[key]);
      if (res) return res;
    }
  }
  return null;
}

/**
 * Performs a live stock verification for a single product directly on Price Shoes
 * checks specifically for the quantity available in the online store (Tienda Virtual).
 */
async function verifyLiveStock(originalUrl, size) {
  console.log(`[Live Stock Check] Verifying size "${size}" on: ${originalUrl} for Tienda Virtual`);
  let browser;
  let context;
  let page;
  let inStock = false;
  
  try {
    browser = await getBrowserInstance();
    context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    });
    page = await context.newPage();
    
    let targetStoreStock = null;
    const targetSizeStr = size.toString().trim();
    
    // Set up response listener to find Tienda Virtual stock
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('nearby-stores/inventories/')) {
        try {
          const text = await response.text();
          const json = JSON.parse(text);
          const sizeLabel = (json.size_label || '').toString().trim();
          
          const responseSizeFloat = parseFloat(sizeLabel);
          const targetSizeFloat = parseFloat(targetSizeStr);
          
          if (!isNaN(responseSizeFloat) && !isNaN(targetSizeFloat) && responseSizeFloat === targetSizeFloat) {
            const inventories = json.store_inventories || [];
            const onlineInfo = inventories.find(store => store.store_name === 'Tienda virtual');
            if (onlineInfo) {
              targetStoreStock = parseInt(onlineInfo.quantity) || 0;
              console.log(`[Live Stock Check] Intercepted size ${sizeLabel} for Tienda Virtual: stock = ${targetStoreStock}`);
            }
          }
        } catch (e) {
          // ignore json errors
        }
      }
    });

    // Block images, stylesheets, fonts, media, and third-party trackers to make load ultra fast
    await page.route('**/*', (route) => {
      const url = route.request().url();
      const type = route.request().resourceType();
      
      const isTrackerOrUnneeded = 
        url.includes('google-analytics') || 
        url.includes('analytics') || 
        url.includes('gtm.js') || 
        url.includes('facebook') || 
        url.includes('pixel') || 
        url.includes('hotjar') || 
        url.includes('doubleclick') || 
        url.includes('ads') || 
        url.includes('sentry') || 
        url.includes('clarity.ms') ||
        url.includes('datadog');

      if (['image', 'stylesheet', 'font', 'media'].includes(type) || isTrackerOrUnneeded) {
        route.abort();
      } else {
        route.continue();
      }
    });
    
    await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
    
    const storeBtn = page.locator('text=/Ver disponibilidad en tiendas/i');
    // Wait for the button to appear in the DOM
    await storeBtn.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    
    if (await storeBtn.count() > 0) {
      await storeBtn.first().dispatchEvent('click');
      
      // Wait for responses (max 6 seconds)
      const startTime = Date.now();
      while (targetStoreStock === null && Date.now() - startTime < 6000) {
        await page.waitForTimeout(150);
      }
    }
    
    if (targetStoreStock !== null) {
      inStock = targetStoreStock > 0;
      console.log(`[Live Stock Check] Results for Tienda Virtual: stock = ${targetStoreStock}, inStock = ${inStock}`);
    } else {
      // Fallback: check __NEXT_DATA__
      console.warn('[Live Stock Check] Intercept failed. Falling back to general ecommerce sizes.');
      const nextDataText = await page.locator('script#__NEXT_DATA__').innerText();
      const nextData = JSON.parse(nextDataText);
      const sizes = findSizesInJSON(nextData);
      if (sizes && sizes.length > 0) {
        inStock = sizes.map(s => parseFloat(s)).includes(parseFloat(targetSizeStr));
      }
    }
  } catch (err) {
    console.error('[Live Stock Check] Error or Playwright launch failed. Defaulting to inStock = true:', err.message);
    // If check fails (e.g. timeout or Playwright missing in serverless), default to true to allow sale, but log it
    inStock = true;
  } finally {
    if (page) {
      try { await page.close(); } catch (e) {}
    }
    if (context) {
      try { await context.close(); } catch (e) {}
    }
  }
  
  return inStock;
}

/**
 * Performs a live scraper update for a single product.
 * Fetches sizes, sizes_stock, and total stock for the Ecatepec store on Price Shoes.
 * Updates the database and returns the fresh details.
 */
async function syncSingleProductLive(product) {
  if (!product || product.origin !== 'priceshoes') return null;

  console.log(`[On-Demand Sync] Triggering live Tienda Virtual stock sync for SKU: ${product.sku} (${product.id})...`);
  let browser;
  try {
    // 1. Parse current sizes to pass as fallback sizes
    let fallbackSizes = [];
    try {
      const parsed = typeof product.sizes === 'string' ? JSON.parse(product.sizes) : (product.sizes || []);
      fallbackSizes = Array.from(new Set(parsed));
    } catch (e) {
      fallbackSizes = [];
    }

    // 2. Get browser singleton
    browser = await getBrowserInstance();

    // 3. Get online store (Tienda Virtual) sizes
    const onlineStoreData = await getOnlineStoreSizes(browser, product.original_url, fallbackSizes);
    
    const sizes = onlineStoreData.sizes;
    const stock = onlineStoreData.stock;
    const sizesStock = onlineStoreData.sizesStock;

    // 4. Update the DB
    await dbQuery.run(`
      UPDATE products SET
        sizes = ?,
        sizes_stock = ?,
        stock = ?
      WHERE id = ?
    `, [
      JSON.stringify(sizes),
      JSON.stringify(sizesStock),
      stock,
      product.id
    ]);

    console.log(`[On-Demand Sync] Live sync successful for SKU: ${product.sku}. Stock: ${stock}.`);
    return {
      sizes,
      stock,
      sizes_stock: sizesStock
    };
  } catch (err) {
    console.error(`[On-Demand Sync] Failed live sync for product ID ${product.id}:`, err.message);
    return null;
  } finally {
    // Persistent browser is kept open for subsequent requests.
  }
}

module.exports = {
  runScraper,
  verifyLiveStock,
  syncSingleProductLive
};

