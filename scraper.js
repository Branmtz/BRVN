const { chromium } = require('playwright');
const { dbQuery } = require('./database');

/**
 * Normalizes gender value from the department or gender fields
 */
function normalizeGender(dept, gend) {
  const value = (dept || gend || '').toUpperCase();
  if (value.includes('CABALLERO') || value.includes('HOMBRE') || value.includes('MEN')) {
    return 'Caballero';
  }
  if (value.includes('DAMA') || value.includes('MUJER') || value.includes('WOMEN')) {
    return 'Dama';
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
          // price_customer = precio público del catálogo (ej. $749) — fallback si no está el de socio
          const supplierPrice = source.price_member || source.price_customer || 0;
          const sizes = Array.isArray(source.sizes) ? source.sizes.map(s => s.toString()) : [];
          const images = Array.isArray(source.images) 
            ? source.images.map(img => `https://res.cloudinary.com/priceshoes/image/upload/${img.startsWith('/') ? img.slice(1) : img}`)
            : [];
          
          const color = normalizeColor(source.color);
          const gender = normalizeGender(source.department, source.gender);
          const originalUrl = source.url_key 
            ? `https://www.priceshoes.com/productos/${source.url_key}`
            : `https://www.priceshoes.com/productos/${sku}`;
          
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
            images: JSON.stringify(images),
            sizes: JSON.stringify(sizes),
            color: color,
            gender: gender,
            origin: 'priceshoes',
            original_url: originalUrl,
            stock: 99,
            status: 'active',
            category: category,
            brand: source.brand || 'Otros',
            specifications: specifications
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
            // Update product data but PRESERVE existing category to prevent cross-category corruption
            await dbQuery.run(`
              UPDATE products SET
                title=?, description=?, supplier_price=?, images=?, sizes=?,
                color=?, gender=?, original_url=?, stock=?, status=?, brand=?,
                specifications=?
              WHERE sku=?
            `, [
              item.title, item.description, item.supplier_price, item.images, item.sizes,
              item.color, item.gender, item.original_url, item.stock, item.status, item.brand,
              item.specifications, item.sku
            ]);
            // Don't count updates toward the limit — only new products count
          } else {
            // Brand new product — insert with the assigned category
            await dbQuery.run(`
              INSERT INTO products (
                id, sku, title, description, price, supplier_price, images, sizes, color, gender, origin, original_url, stock, status, category, brand, specifications
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              item.id, item.sku, item.title, item.description, null,
              item.supplier_price, item.images, item.sizes, item.color, item.gender,
              item.origin, item.original_url, item.stock, item.status, item.category, item.brand,
              item.specifications
            ]);
            totalSaved++;
            savedOnThisPage++;
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
 */
async function verifyLiveStock(originalUrl, size) {
  console.log(`[Live Stock Check] Verifying size "${size}" on: ${originalUrl}`);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  });
  const page = await context.newPage();
  
  let inStock = false;
  
  try {
    // Block images, stylesheets, fonts, and media to make load ultra fast
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });
    
    await page.goto(originalUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    // Extract Next.js data
    const nextDataText = await page.locator('script#__NEXT_DATA__').innerText();
    const nextData = JSON.parse(nextDataText);
    
    const sizes = findSizesInJSON(nextData);
    console.log(`[Live Stock Check] Sizes available on Price Shoes:`, sizes);
    
    if (sizes && sizes.length > 0) {
      const targetSize = size.toString().trim();
      inStock = sizes.map(s => s.toString().trim()).includes(targetSize);
    }
  } catch (err) {
    console.error('[Live Stock Check] Error parsing details:', err.message);
    // If check fails (e.g. timeout), default to true to allow sale, but log it
    inStock = true;
  } finally {
    await browser.close();
  }
  
  return inStock;
}

module.exports = {
  runScraper,
  verifyLiveStock
};
