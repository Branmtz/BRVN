const { dbQuery } = require('./database');

/**
 * Helper to fetch AWS Cognito guest token from Price Shoes revalidate endpoint
 */
async function getCognitoToken() {
  const revalidateUrl = "https://www.priceshoes.com/api/auth/revalidate";
  try {
    const res = await fetch(revalidateUrl, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.priceshoes.com/"
      }
    });
    if (!res.ok) throw new Error(`HTTP status ${res.status}`);
    const token = await res.json();
    return token;
  } catch (err) {
    console.error("[Cognito Token] Failed to fetch guest token:", err.message);
    return null;
  }
}

/**
 * Extracts size options from the product detail page HTML __NEXT_DATA__
 */
async function getProductSizesFromHTML(originalUrl) {
  try {
    const res = await fetch(originalUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) throw new Error(`Failed to load page HTML, status: ${res.status}`);
    const html = await res.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (match && match[1]) {
      const nextData = JSON.parse(match[1].trim());
      const product = nextData.props?.pageProps?.productInitial;
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
        if (sizes.length > 0) {
          return Array.from(new Set(sizes));
        }
      }
    }
  } catch (err) {
    console.error("[Sizes HTML Extractor] Error:", err.message);
  }
  return null;
}

/**
 * Queries the store inventories API for all sizes in parallel
 */
async function getLiveStockFromAPI(sku, sizes, token) {
  const sizesStock = {};
  let totalStock = 0;
  
  const promises = sizes.map(async (size) => {
    const url = `https://api.priceshoes.digital/v1/api-composer/nearby-stores/inventories/?product_id=${sku}&size=${size}&lat=19.451054&lon=-99.125519&radius=1000000&dark_store_id=29`;
    try {
      const res = await fetch(url, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Referer": "https://www.priceshoes.com/"
        }
      });
      if (res.ok) {
        const data = await res.json();
        const inventories = data.store_inventories || [];
        // Look for the online store (synonyms: Ecommerce, Tienda virtual, Virtual, Tienda Virtual, Online)
        const onlineInfo = inventories.find(store => {
          const name = (store.store_name || '').toUpperCase();
          return name === 'ECOMMERCE' || name === 'TIENDA VIRTUAL' || name === 'VIRTUAL' || name === 'ONLINE';
        });
        if (onlineInfo) {
          const qty = parseInt(onlineInfo.quantity) || 0;
          sizesStock[size] = qty;
          if (qty > 0) {
            totalStock += qty;
          }
        } else {
          sizesStock[size] = 0;
        }
      } else {
        sizesStock[size] = 0;
      }
    } catch (e) {
      console.warn(`[Live Stock API] Error checking size ${size}:`, e.message);
      sizesStock[size] = 0;
    }
  });

  await Promise.all(promises);

  // Return the active sizes (only sizes with stock > 0)
  const activeSizes = Object.keys(sizesStock).filter(size => sizesStock[size] > 0);

  return {
    sizes: activeSizes,
    stock: totalStock,
    sizesStock: sizesStock
  };
}

/**
 * Performs a live stock verification for a single product directly on Price Shoes
 * checks specifically for the quantity available in the online store (Tienda Virtual).
 */
async function verifyLiveStock(originalUrl, size, productSku = null) {
  console.log(`[Live Stock Check] Verifying size "${size}" on: ${originalUrl} (SKU: ${productSku})`);
  
  let sku = productSku;
  if (!sku) {
    // Fallback: extract from URL
    const match = originalUrl.match(/(\d+)(?:\?|$)/);
    sku = match ? match[1] : null;
  }
  if (!sku) {
    console.error("[Live Stock Check] Could not resolve SKU for URL:", originalUrl);
    return { status: 'unverified', reason: 'Could not resolve SKU' };
  }

  const token = await getCognitoToken();
  if (!token) {
    console.warn("[Live Stock Check] Could not retrieve auth token.");
    return { status: 'unverified', reason: 'Could not retrieve auth token' };
  }

  // Query stock for this specific size
  const url = `https://api.priceshoes.digital/v1/api-composer/nearby-stores/inventories/?product_id=${sku}&size=${size}&lat=19.451054&lon=-99.125519&radius=1000000&dark_store_id=29`;
  try {
    const res = await fetch(url, {
      headers: {
        "Authorization": `Bearer ${token}`,
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.priceshoes.com/"
      }
    });
    if (res.ok) {
      const data = await res.json();
      const inventories = data.store_inventories || [];
      const onlineInfo = inventories.find(store => {
        const name = (store.store_name || '').toUpperCase();
        return name === 'ECOMMERCE' || name === 'TIENDA VIRTUAL' || name === 'VIRTUAL' || name === 'ONLINE';
      });
      if (onlineInfo) {
        const qty = parseInt(onlineInfo.quantity) || 0;
        console.log(`[Live Stock Check] Verified size "${size}" stock in Ecommerce: ${qty}`);
        return {
          status: qty > 0 ? 'in_stock' : 'out_of_stock',
          quantity: qty
        };
      } else {
        return { status: 'out_of_stock', reason: 'Online inventory not found' };
      }
    } else {
      console.warn(`[Live Stock Check] API returned status ${res.status}`);
      return { status: 'unverified', reason: `API returned status ${res.status}` };
    }
  } catch (err) {
    console.error("[Live Stock Check] Failed to query live API:", err.message);
    return { status: 'unverified', reason: err.message };
  }
}

/**
 * Performs a live scraper update for a single product.
 * Fetches sizes, sizes_stock, and total stock for the Ecatepec store on Price Shoes.
 * Updates the database and returns the fresh details.
 */
async function syncSingleProductLive(product) {
  if (!product || product.origin !== 'priceshoes') return null;

  console.log(`[On-Demand Sync] Triggering live Tienda Virtual stock sync for SKU: ${product.sku} (${product.id})...`);
  
  try {
    // 1. Get Cognito token
    const token = await getCognitoToken();
    if (!token) {
      throw new Error("Failed to retrieve guest token from Price Shoes");
    }

    // 2. Try to get fresh sizes list from HTML __NEXT_DATA__
    let sizes = await getProductSizesFromHTML(product.original_url);
    if (!sizes || sizes.length === 0) {
      // Fallback: use database sizes
      try {
        const parsed = typeof product.sizes === 'string' ? JSON.parse(product.sizes) : (product.sizes || []);
        sizes = Array.from(new Set(parsed));
      } catch (e) {
        sizes = [];
      }
    }

    if (!sizes || sizes.length === 0) {
      console.log(`[On-Demand Sync] No sizes found for SKU: ${product.sku}. Skipping.`);
      return {
        sizes: [],
        stock: 0,
        sizes_stock: {}
      };
    }

    // 3. Query stock for all sizes in parallel
    const stockData = await getLiveStockFromAPI(product.sku, sizes, token);
    
    // 4. Update the DB
    await dbQuery.run(`
      UPDATE products SET
        sizes = ?,
        sizes_stock = ?,
        stock = ?
      WHERE id = ?
    `, [
      JSON.stringify(stockData.sizes),
      JSON.stringify(stockData.sizesStock),
      stockData.stock,
      product.id
    ]);

    console.log(`[On-Demand Sync] Live sync successful for SKU: ${product.sku}. Stock: ${stockData.stock}.`);
    return {
      sizes: stockData.sizes,
      stock: stockData.stock,
      sizes_stock: stockData.sizesStock
    };
  } catch (err) {
    console.error(`[On-Demand Sync] Failed live sync for product ID ${product.id}:`, err.message);
    return {
      success: false,
      error: err.message,
      stack: err.stack
    };
  }
}

module.exports = {
  verifyLiveStock,
  syncSingleProductLive
};
