const express = require('express');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { dbQuery } = require('./database');
const { runScraper, verifyLiveStock, syncSingleProductLive } = require('./scraper');
const {
  runBulkComparison,
  getComparisonState,
  approveManualProduct,
  rejectManualProduct,
  calculateBRVNPrice
} = require('./price-comparator');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'paps_default_jwt_secret_key_2026';

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Logistics / Shipping Router
app.use(require('./shipping'));

// Simple Rate Limiting for Login & Checkout
const rateLimitMap = new Map();
function rateLimiter(limit, windowMs) {
  return (req, res, next) => {
    const ip = req.ip;
    const now = Date.now();
    
    if (!rateLimitMap.has(ip)) {
      rateLimitMap.set(ip, []);
    }
    
    const requests = rateLimitMap.get(ip).filter(time => now - time < windowMs);
    requests.push(now);
    rateLimitMap.set(ip, requests);
    
    if (requests.length > limit) {
      return res.status(429).json({ error: 'Demasiadas peticiones. Por favor, intente más tarde.' });
    }
    next();
  };
}

// Helper: Calculate Dynamic Pricing
// Si el precio del proveedor es 0, el precio de venta es 0
// Productos propios PAPS (Picafresa, supplier_price = 1): precio directo
// Fórmula: (costo + $200 ganancia + $100 envío) / (1 - 0.034 comisión MP)
/**
 * Fórmula de precio BRVN:
 *   precio = (supplier_price + $200 ganancia + $100 envío) / (1 - 0.034 comisión MP)
 * Redondeo psicológico: sube al siguiente múltiplo de 50 y resta 1.
 *   Ej: 1,243 → 1,250 - 1 = $1,249
 * NOTA: Solo productos PAPS propios (supplier_price <= 1) usan precio directo.
 *   Todos los demás (incluyendo PS a $99) pasan por la fórmula completa.
 */
function calculatePrice(supplierPrice) {
  if (!supplierPrice || supplierPrice <= 0) return 0;
  // Solo productos propios PAPS (Picafresa) con precio simbólico usan precio directo
  if (supplierPrice <= 1) return supplierPrice;
  const raw = (supplierPrice + 200 + 100) / (1 - 0.034);
  // Redondeo psicológico: siguiente múltiplo de 50, menos 1
  return Math.ceil(raw / 50) * 50 - 1;
}

// ─────────────────────────────────────────────
// Filtro SQL global: solo tenis, sin mocasines ni marcas excluidas
// ─────────────────────────────────────────────

// Productos que SÍ son tenis (por título o subcategoría)
const TENIS_BASE_SQL = `(
  UPPER(title) LIKE '%TENIS%'
  OR UPPER(title) LIKE '%SPORT%'
  OR UPPER(specifications) LIKE '%"subcategor\u00eda":"correr"%'
  OR UPPER(specifications) LIKE '%"subcategor\u00eda":"skate"%'
  OR UPPER(specifications) LIKE '%"subcategor\u00eda":"futbol"%'
  OR UPPER(specifications) LIKE '%"subcategor\u00eda":"entrenamiento"%'
  OR UPPER(specifications) LIKE '%"subcategor\u00eda":"basketball"%'
  OR UPPER(specifications) LIKE '%"subcategor\u00eda":"padel"%'
  OR UPPER(specifications) LIKE '%"subcategor\u00eda":"caminar"%'
)`;

// Productos a excluir: mocasín, marcas SHOSH/MANET, subcategoría choclo
// EXCEPTO si el título dice TENIS o SPORT (en ese caso se conservan)
const EXCLUIR_SQL = `NOT (
  (
    UPPER(title) LIKE '%MOCASIN%'
    OR UPPER(title) LIKE '%MOCAS\u00cdN%'
    OR UPPER(brand) IN ('SHOSH','MANET')
    OR UPPER(specifications) LIKE '%"subcategor\u00eda":"choclo"%'
  )
  AND UPPER(title) NOT LIKE '%TENIS%'
  AND UPPER(title) NOT LIKE '%SPORT%'
)`;

// Filtro final combinado
const TENIS_FILTER_SQL = `(${TENIS_BASE_SQL} AND ${EXCLUIR_SQL})`;

function getProductTypeJS(p) {
  const title = (p.title || '').toUpperCase();
  let subcat = '';
  if (p.specifications) {
    try {
      const specs = typeof p.specifications === 'string' ? JSON.parse(p.specifications) : p.specifications;
      if (specs.Subcategoría) subcat = specs.Subcategoría.toUpperCase();
    } catch(e) {}
  }
  
  if (title.includes('TENIS') || ['CHOCLO', 'CORRER', 'SKATE', 'FUTBOL', 'ENTRENAMIENTO', 'BASKETBALL', 'PADEL', 'CAMINAR'].includes(subcat)) {
    return 'Tenis';
  }
  if (title.includes('SANDALIA') || title.includes('SUECO') || ['SANDALIA', 'SUECO'].includes(subcat)) {
    return 'Sandalias';
  }
  if (title.includes('BOTA') || subcat === 'BOTA') {
    return 'Botas';
  }
  if (subcat === 'ACCESORIO DE CALZADO' || subcat === 'CALCETIN' || subcat === 'CUIDADO DEL ZAPATO') {
    return 'Otros';
  }
  return 'Zapato';
}

function getKidsGenderJS(p) {
  const title = (p.title || '').toUpperCase();
  const desc = (p.description || '').toUpperCase();
  const category = (p.category || '').toUpperCase();
  
  let color = '';
  let acabado = '';
  let subcat = '';
  if (p.specifications) {
    try {
      const specs = typeof p.specifications === 'string' ? JSON.parse(p.specifications) : p.specifications;
      if (specs.Color) color = specs.Color.toUpperCase();
      if (specs.Acabado) acabado = specs.Acabado.toUpperCase();
      if (specs.Subcategoría) subcat = specs.Subcategoría.toUpperCase();
    } catch(e) {}
  }

  if (category === 'NIÑAS' || category === 'NIÑA') return 'Niña';
  if (category === 'NIÑOS' || category === 'NIÑO') return 'Niño';

  const girlKeywords = [
    'NIÑA', 'NIÑAS', 'BARBIE', 'PRINCESA', 'PRINCESAS', 'MINNIE', 'DAISY', 
    'HELLO KITTY', 'UNICORNIO', 'SIRENA', 'L.O.L.', 'FROZEN', 'ELSA', 'ANNA', 
    'LADYBUG', 'LAS CHICAS SUPER PODEROSAS', 'GIRL', 'GIRLS', 'VIVIS SHOES'
  ];
  const boyKeywords = [
    'NIÑO', 'NIÑOS', 'SPIDERMAN', 'SPIDER-MAN', 'BATMAN', 'AVENGERS', 'MARVEL', 
    'MINECRAFT', 'MARIO BROS', 'LUIGI', 'JURASSIC', 'DINOSAURIO', 'RAYO MCQUEEN', 
    'HOT WHEELS', 'DRAGON BALL', 'GOKU', 'BOY', 'BOYS'
  ];

  if (girlKeywords.some(kw => title.includes(kw) || desc.includes(kw))) return 'Niña';
  if (boyKeywords.some(kw => title.includes(kw) || desc.includes(kw))) return 'Niño';

  if (subcat === 'BALLERINA') return 'Niña';
  if (acabado === 'MOÑO' || acabado === 'FLOR' || acabado === 'BRILLOS' || acabado === 'GLITTER') return 'Niña';
  
  if (['ROSA', 'PINK', 'FUCSIA', 'LILA', 'MORADO', 'GLITTER'].some(c => color.includes(c) || title.includes(c))) {
    return 'Niña';
  }

  return 'Unisex';
}

// Helper: Send Twilio WhatsApp Message
async function sendWhatsAppAlert(orderId, customerName, total, items) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';
  const to = `whatsapp:${process.env.WHATSAPP_TO || '+525545598011'}`;
  
  if (!accountSid || !authToken || accountSid.startsWith('ACxxx')) {
    console.log('[WhatsApp Alert Mocked] Twilio credentials not fully configured.');
    console.log(`Alert Target: ${to}`);
    console.log(`Message Body: 🛍️ ¡Nuevo pedido confirmado PAPS! Folio: ${orderId}. Cliente: ${customerName}. Total: $${total} MXN. Productos: ${items.map(i => `${i.title} (SKU: ${i.sku}, Talla: ${i.size}, Color: ${i.color})`).join(', ')}.`);
    return;
  }
  
  const itemsText = items.map(i => `• ${i.title}\n  SKU: ${i.sku} | Talla: ${i.size} | Color: ${i.color}`).join('\n');
  const body = `🛍️ *¡Nueva venta en PAPS!*\n\n*Folio:* ${orderId}\n*Cliente:* ${customerName}\n*Total:* $${total} MXN\n\n*Productos del Pedido:*\n${itemsText}`;
  
  try {
    const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const params = new URLSearchParams();
    params.append('From', from);
    params.append('To', to);
    params.append('Body', body);
    
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params
    });
    
    const result = await response.json();
    if (response.ok) {
      console.log('WhatsApp alert sent successfully via Twilio SID:', result.sid);
    } else {
      console.error('Error response from Twilio API:', result);
    }
  } catch (err) {
    console.error('Failed to send Twilio WhatsApp notification:', err.message);
  }
}

// Helper: Handle Order Payment Success (Decrements PAPS stock and triggers WhatsApp Alert)
async function handleOrderPaymentSuccess(orderId, paymentId) {
  try {
    const order = await dbQuery.get("SELECT * FROM orders WHERE id = ?", [orderId]);
    if (!order) return;
    
    if (order.status === 'pending') {
      // 1. Update order status to paid and tracking_status to compra_realizada
      await dbQuery.run("UPDATE orders SET status = 'paid', mp_payment_id = ?, tracking_status = 'compra_realizada' WHERE id = ?", [paymentId, orderId]);
      console.log(`[Payment Success] Order ${orderId} successfully marked as paid. PaymentID: ${paymentId}`);
      
      // Delete coupon if used
      if (order.coupon_code && order.customer_id) {
        await dbQuery.run("DELETE FROM user_coupons WHERE user_id = ? AND LOWER(code) = ?", [order.customer_id, order.coupon_code.toLowerCase()]);
        console.log(`[Payment Success] Coupon ${order.coupon_code} deleted for customer ${order.customer_id}`);
      }
      
      // 2. Decrement stock for PAPS products
      const items = JSON.parse(order.items || '[]');
      for (const item of items) {
        const product = await dbQuery.get("SELECT * FROM products WHERE id = ?", [item.id]);
        if (product && product.origin === 'PAPS') {
          const newStock = Math.max(0, product.stock - item.qty);
          await dbQuery.run("UPDATE products SET stock = ? WHERE id = ?", [newStock, product.id]);
          console.log(`[Stock Decrement] Product ${product.title} (${product.id}) stock updated from ${product.stock} to ${newStock}`);
          
          if (newStock === 0) {
            // Mark product as inactive if it runs out of stock completely
            await dbQuery.run("UPDATE products SET status = 'inactive' WHERE id = ?", [product.id]);
            console.log(`[Stock Alert] Product ${product.title} (${product.id}) is now INACTIVE (out of stock).`);
          }
        }
      }
      
      // 3. Send WhatsApp Alert
      await sendWhatsAppAlert(orderId, order.customer_name, order.total, items);
    }
  } catch (err) {
    console.error(`Error processing payment success for order ${orderId}:`, err.message);
  }
}

// JWT Authenticator Middleware
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Acceso no autorizado.' });
  
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Sesión inválida o expirada.' });
    req.admin = user;
    next();
  });
}

const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || 'paps_customer_jwt_secret_key_2026';

function authenticateCustomer(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
  
  jwt.verify(token, CUSTOMER_JWT_SECRET, (err, customer) => {
    if (err) return res.status(403).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' });
    req.customer = customer;
    next();
  });
}

function optionalAuthenticateCustomer(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (token) {
    jwt.verify(token, CUSTOMER_JWT_SECRET, (err, customer) => {
      if (!err) req.customer = customer;
      next();
    });
  } else {
    next();
  }
}

// Shared Helper: Fetch shipping rates from Skydropx
async function getShippingRates(zip_to, items_count = 1) {
  const apiKey = process.env.SKYDROPX_API_KEY;
  const weight = 1;
  
  if (!apiKey || apiKey === 'your_skydropx_api_key_here') {
    return {
      fallback: true,
      rates: [
        { carrier: 'Estafeta', service: 'Estándar (3-5 días)', total: 149 + (items_count - 1) * 30 },
        { carrier: 'FedEx',    service: 'Express (1-2 días)',   total: 199 + (items_count - 1) * 40 },
      ]
    };
  }

  const payload = {
    zip_from: process.env.ORIGIN_ZIP || '06600',
    zip_to,
    parcel: {
      mass_unit: 'KG',
      weight: weight * (items_count || 1),
      distance_unit: 'CM',
      height: 15,
      width: 25,
      length: 30
    }
  };

  const response = await fetch('https://api.skydropx.com/v1/quotations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Token ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('[Skydropx] Error:', response.status, errText);
    throw new Error('No se pudo obtener la cotización de envío de Skydropx.');
  }

  const data = await response.json();
  const rates = (data.data || []).map(r => ({
    carrier:  r.attributes?.provider  || r.provider,
    service:  r.attributes?.service_level_name || r.service_level_name,
    days:     r.attributes?.days        || r.days,
    total:    Math.round(parseFloat(r.attributes?.total_pricing || r.total_pricing || 0))
  })).filter(r => r.total > 0).sort((a, b) => a.total - b.total);

  return { fallback: false, rates };
}

// POST /api/shipping/quote
app.post('/api/shipping/quote', async (req, res) => {
  const { zip_to, items_count = 1 } = req.body;
  
  if (!zip_to || !/^\d{5}$/.test(zip_to)) {
    return res.status(400).json({ error: 'Código postal inválido. Debe ser de 5 dígitos.' });
  }

  try {
    const result = await getShippingRates(zip_to, items_count);
    res.json(result);
  } catch (err) {
    console.error('[Shipping Quote] Error:', err);
    res.status(500).json({ error: 'Error al cotizar el envío con Skydropx.' });
  }
});

/* --- PUBLIC APIS --- */

// GET Health Check (to keep serverless warm)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// GET Catalog of active products
app.get('/api/products', optionalAuthenticateCustomer, async (req, res) => {
  try {
    const { gender, page = 0, limit = 24 } = req.query;
    const offset = parseInt(page) * parseInt(limit);

    let whereClauses = ["status = 'active'", TENIS_FILTER_SQL];
    const params = [];

    if (gender && gender !== 'all') {
      if (gender === 'Hombres') {
        whereClauses.push("(LOWER(gender) IN ('hombre','caballero','hombres') OR LOWER(category) LIKE '%hombre%' OR LOWER(category) LIKE '%caballero%')");
      } else if (gender === 'Mujeres') {
        whereClauses.push("(LOWER(gender) IN ('mujer','dama','mujeres') OR LOWER(category) LIKE '%mujer%' OR LOWER(category) LIKE '%dama%')");
      } else if (gender === 'Niños') {
        whereClauses.push("(LOWER(gender) IN ('ninos','nino','nina','niños','niño','niña') OR LOWER(category) LIKE '%nino%' OR LOWER(category) LIKE '%kids%' OR LOWER(category) LIKE '%infantil%')");
      }
    }

    if (req.query.search) {
      const s = `%${req.query.search.toLowerCase()}%`;
      whereClauses.push(`(LOWER(title) LIKE '${s}' OR LOWER(brand) LIKE '${s}' OR LOWER(sku) LIKE '${s}' OR LOWER(description) LIKE '${s}')`);
    }

    if (req.query.brand && req.query.brand !== 'all') {
      whereClauses.push("brand = ?");
      params.push(req.query.brand);
    }

    if (req.query.type && req.query.type !== 'all') {
      const typeSandaliaSql = `(LOWER(title) LIKE '%sandalia%' OR LOWER(title) LIKE '%sueco%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"sandalia"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"sueco"%')`;
      
      const typeBotaSql = `(LOWER(title) LIKE '%bota%' 
                OR LOWER(title) LIKE '%botin%' 
                OR LOWER(title) LIKE '%botín%' 
                OR LOWER(title) LIKE '%botÍn%'
                OR LOWER(specifications) LIKE '%"subcategoría":"bota"%')`;
      
      const typeZapatoSql = `(LOWER(title) LIKE '%mocasin%' 
                OR LOWER(title) LIKE '%mocasín%' 
                OR LOWER(title) LIKE '%mocasÍn%'
                OR LOWER(title) LIKE '%zapato%' 
                OR LOWER(title) LIKE '%zapatilla%' 
                OR LOWER(title) LIKE '%ballerina%' 
                OR LOWER(title) LIKE '%alpargata%'
                OR LOWER(specifications) LIKE '%"subcategoría":"ballerina"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"zapatilla"%')`;

      const typeTenisSql = `(LOWER(title) LIKE '%tenis%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"choclo"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"correr"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"skate"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"futbol"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"entrenamiento"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"basketball"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"padel"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"caminar"%')`;

      const typeOtrosSql = `(LOWER(specifications) LIKE '%"subcategoría":"accesorio de calzado"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"calcetin"%' 
                OR LOWER(specifications) LIKE '%"subcategoría":"cuidado del zapato"%')`;

      if (req.query.type === 'Sandalias') {
        whereClauses.push(typeSandaliaSql);
      } else if (req.query.type === 'Botas') {
        whereClauses.push(typeBotaSql);
      } else if (req.query.type === 'Zapato') {
        whereClauses.push(`(${typeZapatoSql} OR (NOT ${typeSandaliaSql} AND NOT ${typeBotaSql} AND NOT ${typeTenisSql} AND NOT ${typeOtrosSql}))`);
      } else if (req.query.type === 'Tenis') {
        whereClauses.push(`(${typeTenisSql} AND NOT ${typeSandaliaSql} AND NOT ${typeBotaSql} AND NOT ${typeZapatoSql})`);
      }
    }

    if (req.query.kids_gender && req.query.kids_gender !== 'all') {
      const niñaClause = `(
        LOWER(category) = 'niñas' OR LOWER(category) = 'niña'
        OR LOWER(title) LIKE '%niña%' OR LOWER(title) LIKE '%niñas%' OR LOWER(title) LIKE '%niña%' OR LOWER(title) LIKE '%niñas%'
        OR LOWER(title) LIKE '%barbie%' OR LOWER(title) LIKE '%princesa%' OR LOWER(title) LIKE '%princesas%' OR LOWER(title) LIKE '%minnie%' OR LOWER(title) LIKE '%daisy%' OR LOWER(title) LIKE '%hello kitty%' OR LOWER(title) LIKE '%unicornio%' OR LOWER(title) LIKE '%sirena%' OR LOWER(title) LIKE '%l.o.l.%' OR LOWER(title) LIKE '%frozen%' OR LOWER(title) LIKE '%elsa%' OR LOWER(title) LIKE '%anna%' OR LOWER(title) LIKE '%ladybug%' OR LOWER(title) LIKE '%las chicas super poderosas%' OR LOWER(title) LIKE '%girl%' OR LOWER(title) LIKE '%girls%' OR LOWER(title) LIKE '%vivis shoes%'
        OR LOWER(description) LIKE '%niña%' OR LOWER(description) LIKE '%niñas%' OR LOWER(description) LIKE '%niña%' OR LOWER(description) LIKE '%niñas%'
        OR LOWER(description) LIKE '%barbie%' OR LOWER(description) LIKE '%princesa%' OR LOWER(description) LIKE '%princesas%' OR LOWER(description) LIKE '%minnie%' OR LOWER(description) LIKE '%daisy%' OR LOWER(description) LIKE '%hello kitty%' OR LOWER(description) LIKE '%unicornio%' OR LOWER(description) LIKE '%sirena%' OR LOWER(description) LIKE '%l.o.l.%' OR LOWER(description) LIKE '%frozen%' OR LOWER(description) LIKE '%elsa%' OR LOWER(description) LIKE '%anna%' OR LOWER(description) LIKE '%ladybug%' OR LOWER(description) LIKE '%las chicas super poderosas%' OR LOWER(description) LIKE '%girl%' OR LOWER(description) LIKE '%girls%' OR LOWER(description) LIKE '%vivis shoes%'
        OR LOWER(specifications) LIKE '%"subcategoría":"ballerina"%'
        OR LOWER(specifications) LIKE '%"acabado":"moño"%' OR LOWER(specifications) LIKE '%"acabado":"flor"%' OR LOWER(specifications) LIKE '%"acabado":"brillos"%' OR LOWER(specifications) LIKE '%"acabado":"glitter"%'
        OR LOWER(specifications) LIKE '%"color":"%rosa%"%' OR LOWER(specifications) LIKE '%"color":"%pink%"%' OR LOWER(specifications) LIKE '%"color":"%fucsia%"%' OR LOWER(specifications) LIKE '%"color":"%lila%"%' OR LOWER(specifications) LIKE '%"color":"%morado%"%' OR LOWER(specifications) LIKE '%"color":"%glitter%"%'
        OR LOWER(title) LIKE '%rosa%' OR LOWER(title) LIKE '%pink%' OR LOWER(title) LIKE '%fucsia%' OR LOWER(title) LIKE '%lila%' OR LOWER(title) LIKE '%morado%' OR LOWER(title) LIKE '%glitter%'
      )`;
      const niñoClause = `(
        LOWER(category) = 'niños' OR LOWER(category) = 'niño'
        OR LOWER(title) LIKE '%niño%' OR LOWER(title) LIKE '%niños%' OR LOWER(title) LIKE '%niño%' OR LOWER(title) LIKE '%niños%'
        OR LOWER(title) LIKE '%spiderman%' OR LOWER(title) LIKE '%spider-man%' OR LOWER(title) LIKE '%batman%' OR LOWER(title) LIKE '%avengers%' OR LOWER(title) LIKE '%marvel%' OR LOWER(title) LIKE '%minecraft%' OR LOWER(title) LIKE '%mario bros%' OR LOWER(title) LIKE '%luigi%' OR LOWER(title) LIKE '%jurassic%' OR LOWER(title) LIKE '%dinosaurio%' OR LOWER(title) LIKE '%rayo mcqueen%' OR LOWER(title) LIKE '%hot wheels%' OR LOWER(title) LIKE '%dragon ball%' OR LOWER(title) LIKE '%goku%' OR LOWER(title) LIKE '%boy%' OR LOWER(title) LIKE '%boys%'
        OR LOWER(description) LIKE '%niño%' OR LOWER(description) LIKE '%niños%' OR LOWER(description) LIKE '%niño%' OR LOWER(description) LIKE '%niños%'
        OR LOWER(description) LIKE '%spiderman%' OR LOWER(description) LIKE '%spider-man%' OR LOWER(description) LIKE '%batman%' OR LOWER(description) LIKE '%avengers%' OR LOWER(description) LIKE '%marvel%' OR LOWER(description) LIKE '%minecraft%' OR LOWER(description) LIKE '%mario bros%' OR LOWER(description) LIKE '%luigi%' OR LOWER(description) LIKE '%jurassic%' OR LOWER(description) LIKE '%dinosaurio%' OR LOWER(description) LIKE '%rayo mcqueen%' OR LOWER(description) LIKE '%hot wheels%' OR LOWER(description) LIKE '%dragon ball%' OR LOWER(description) LIKE '%goku%' OR LOWER(description) LIKE '%boy%' OR LOWER(description) LIKE '%boys%'
      )`;

      if (req.query.kids_gender === 'Niña') {
        whereClauses.push(`(${niñaClause} OR (NOT ${niñaClause} AND NOT ${niñoClause}))`);
      } else if (req.query.kids_gender === 'Niño') {
        whereClauses.push(`(${niñoClause} OR (NOT ${niñaClause} AND NOT ${niñoClause}))`);
      }
    }

    const where = whereClauses.join(' AND ');

    const products = await dbQuery.all(
      `SELECT * FROM products WHERE ${where} ORDER BY is_bestseller DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, parseInt(limit), offset]
    );

    const totalRow = await dbQuery.get(
      `SELECT COUNT(*) as total FROM products WHERE ${where}`,
      params
    );

    // Fetch average ratings only for this batch
    const productIds = products.map(p => p.id);
    let ratingsMap = {};
    if (productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(',');
      const ratingsData = await dbQuery.all(
        `SELECT product_id, AVG(rating) as avgRating, COUNT(rating) as countRating FROM ratings WHERE product_id IN (${placeholders}) GROUP BY product_id`,
        productIds
      );
      ratingsData.forEach(r => {
        ratingsMap[r.product_id] = {
          average: r.avgRating ? parseFloat(r.avgRating.toFixed(1)) : 0,
          count: r.countRating || 0
        };
      });
    }

    // Fetch favorites if customer is logged in
    const customerId = req.customer ? req.customer.id : null;
    const favoriteIds = new Set();
    if (customerId && productIds.length > 0) {
      const placeholders = productIds.map(() => '?').join(',');
      const favs = await dbQuery.all(
        `SELECT product_id FROM favorites WHERE customer_id = ? AND product_id IN (${placeholders})`,
        [customerId, ...productIds]
      );
      favs.forEach(f => favoriteIds.add(f.product_id));
    }

    const mappedProducts = products.map(p => ({
      ...p,
      price: calculatePrice(p.supplier_price),
      images: JSON.parse(p.images || '[]'),
      sizes: JSON.parse(p.sizes || '[]'),
      isFavorite: customerId ? favoriteIds.has(p.id) : false,
      rating: ratingsMap[p.id] || { average: 0, count: 0 }
    }));

    res.json({
      products: mappedProducts,
      total: totalRow.total,
      page: parseInt(page),
      limit: parseInt(limit),
      hasMore: offset + products.length < totalRow.total
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el catálogo de productos.' });
  }
});

// GET Categories of active products
app.get('/api/categories', async (req, res) => {
  const { gender } = req.query;
  try {
    let rows;
    if (gender) {
      rows = await dbQuery.all(
        `SELECT DISTINCT category FROM products WHERE status = 'active' AND ${TENIS_FILTER_SQL} AND category IS NOT NULL AND gender = ?`,
        [gender]
      );
    } else {
      rows = await dbQuery.all(
        `SELECT DISTINCT category FROM products WHERE status = 'active' AND ${TENIS_FILTER_SQL} AND category IS NOT NULL`
      );
    }
    const categories = rows.map(r => r.category);
    res.json(categories);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener las categorías.' });
  }
});

// GET Categories with product count (for admin panel)
app.get('/api/categories/detailed', authenticateAdmin, async (req, res) => {
  try {
    const rows = await dbQuery.all(
      `SELECT category as name, COUNT(*) as count FROM products WHERE status = 'active' AND ${TENIS_FILTER_SQL} AND category IS NOT NULL GROUP BY category ORDER BY category ASC`
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener las categorías detalladas.' });
  }
});

// GET Brands of active products (optional ?gender= filter)
app.get('/api/brands', async (req, res) => {
  try {
    const { gender } = req.query;
    let whereClause = `status = 'active' AND ${TENIS_FILTER_SQL} AND brand IS NOT NULL`;

    if (gender && gender !== 'all') {
      if (gender === 'Hombres') {
        whereClause += " AND (LOWER(gender) IN ('hombre','caballero','hombres') OR LOWER(category) LIKE '%hombre%' OR LOWER(category) LIKE '%caballero%')";
      } else if (gender === 'Mujeres') {
        whereClause += " AND (LOWER(gender) IN ('mujer','dama','mujeres') OR LOWER(category) LIKE '%mujer%' OR LOWER(category) LIKE '%dama%')";
      } else if (gender === 'Niños') {
        whereClause += " AND (LOWER(gender) IN ('ninos','nino','nina','niños','niño','niña') OR LOWER(category) LIKE '%nino%' OR LOWER(category) LIKE '%kids%' OR LOWER(category) LIKE '%infantil%')";
      }
    }

    const rows = await dbQuery.all(`SELECT DISTINCT brand FROM products WHERE ${whereClause} ORDER BY brand ASC`);
    const brands = rows.map(r => r.brand);
    res.json(brands);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener las marcas.' });
  }
});

// GET Trends (Best Sellers)
app.get('/api/products/trends', optionalAuthenticateCustomer, async (req, res) => {
  try {
    const orders = await dbQuery.all("SELECT items FROM orders WHERE status IN ('paid', 'purchased_on_supplier', 'shipped')");
    
    const salesMap = {};
    const productIdsWithSales = new Set();
    orders.forEach(order => {
      try {
        const items = JSON.parse(order.items || '[]');
        items.forEach(item => {
          const pid = item.id;
          if (pid) {
            salesMap[pid] = (salesMap[pid] || 0) + (item.qty || 1);
            productIdsWithSales.add(pid);
          }
        });
      } catch (e) {
        // ignore
      }
    });
    
    // Query only bestsellers or products with sales
    let products;
    const salesIds = Array.from(productIdsWithSales);
    
    // "Más vendidos": solo tenis aprobados por el admin con ventas reales
    if (salesIds.length > 0) {
      const placeholders = salesIds.map(() => '?').join(',');
      const sql = `SELECT * FROM products
        WHERE status = 'active'
          AND ${TENIS_FILTER_SQL}
          AND comparison_status IN ('auto_published', 'manual_approved')
          AND id IN (${placeholders})`;
      products = await dbQuery.all(sql, salesIds);
    }

    // Si no hay ventas aún, mostrar todos los tenis aprobados por el admin
    if (!products || products.length === 0) {
      products = await dbQuery.all(
        `SELECT * FROM products WHERE status = 'active' AND ${TENIS_FILTER_SQL} AND comparison_status IN ('auto_published', 'manual_approved') ORDER BY id DESC LIMIT 24`
      );
    }
    
    // Fetch average ratings
    const ratingsData = await dbQuery.all("SELECT product_id, AVG(rating) as avgRating, COUNT(rating) as countRating FROM ratings GROUP BY product_id");
    const ratingsMap = {};
    ratingsData.forEach(r => {
      ratingsMap[r.product_id] = {
        average: r.avgRating ? parseFloat(r.avgRating.toFixed(1)) : 0,
        count: r.countRating || 0
      };
    });

    const customerId = req.customer ? req.customer.id : null;
    const favoriteIds = new Set();
    if (customerId) {
      const favs = await dbQuery.all("SELECT product_id FROM favorites WHERE customer_id = ?", [customerId]);
      favs.forEach(f => favoriteIds.add(f.product_id));
    }

    const mappedProducts = products.map(p => {
      const currentPrice = calculatePrice(p.supplier_price);
      return {
        ...p,
        price: currentPrice,
        images: JSON.parse(p.images || '[]'),
        sizes: JSON.parse(p.sizes || '[]'),
        isFavorite: customerId ? favoriteIds.has(p.id) : false,
        rating: ratingsMap[p.id] || { average: 0, count: 0 },
        salesCount: salesMap[p.id] || 0
      };
    });
    
    // Filter to only include products that are marked as bestseller or have sales
    let trendsList = mappedProducts.filter(p => p.is_bestseller === 1 || p.salesCount > 0);
    if (trendsList.length === 0) {
      // Fallback: if no bestsellers or sales yet, show top products by default (up to 12)
      trendsList = mappedProducts.slice(0, 12);
    } else {
      // Sort by bestseller status desc, then by salesCount desc
      trendsList.sort((a, b) => {
        const bestA = a.is_bestseller || 0;
        const bestB = b.is_bestseller || 0;
        if (bestB !== bestA) {
          return bestB - bestA;
        }
        return b.salesCount - a.salesCount;
      });
    }
    
    if (req.query.brand && req.query.brand !== 'all') {
      trendsList = trendsList.filter(p => p.brand === req.query.brand);
    }
    if (req.query.type && req.query.type !== 'all') {
      trendsList = trendsList.filter(p => getProductTypeJS(p) === req.query.type);
    }
    if (req.query.kids_gender && req.query.kids_gender !== 'all') {
      trendsList = trendsList.filter(p => {
        const kidsGender = getKidsGenderJS(p);
        if (req.query.kids_gender === 'Niña') {
          return kidsGender === 'Niña' || kidsGender === 'Unisex';
        } else if (req.query.kids_gender === 'Niño') {
          return kidsGender === 'Niño' || kidsGender === 'Unisex';
        }
        return true;
      });
    }

    res.json(trendsList);
  } catch (err) {
    console.error('Trends error:', err);
    res.status(500).json({ error: 'Error al obtener tendencias.' });
  }
});

// GET Single product detail (Non-blocking: returns cached db values instantly)
app.get('/api/products/:id', optionalAuthenticateCustomer, async (req, res) => {
  try {
    const product = await dbQuery.get("SELECT * FROM products WHERE id = ?", [req.params.id]);
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    
    // Fetch average rating
    const ratingResult = await dbQuery.get("SELECT AVG(rating) as avgRating, COUNT(rating) as countRating FROM ratings WHERE product_id = ?", [product.id]);
    
    // Fetch favorite status
    const customerId = req.customer ? req.customer.id : null;
    let isFavorite = false;
    if (customerId) {
      const fav = await dbQuery.get("SELECT 1 FROM favorites WHERE customer_id = ? AND product_id = ?", [customerId, product.id]);
      isFavorite = !!fav;
    }
    
    const parsedSizes = Array.from(new Set(JSON.parse(product.sizes || '[]')));
    const sortedSizes = parsedSizes.sort((a, b) => {
      const numA = parseFloat(a);
      const numB = parseFloat(b);
      if (isNaN(numA) && isNaN(numB)) return a.toString().localeCompare(b.toString());
      if (isNaN(numA)) return 1;
      if (isNaN(numB)) return -1;
      return numA - numB;
    });

    res.json({
      ...product,
      price: calculatePrice(product.supplier_price),
      images: JSON.parse(product.images || '[]'),
      sizes: sortedSizes,
      sizes_stock: JSON.parse(product.sizes_stock || '{}'),
      isFavorite,
      rating: {
        average: ratingResult.avgRating ? parseFloat(ratingResult.avgRating.toFixed(1)) : 0,
        count: ratingResult.countRating || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener los detalles del producto.' });
  }
});

// GET Live sync product stock on demand (called in background after page load)
app.get('/api/products/:id/sync', optionalAuthenticateCustomer, async (req, res) => {
  try {
    const product = await dbQuery.get("SELECT * FROM products WHERE id = ?", [req.params.id]);
    if (!product) return res.status(404).json({ error: 'Producto no encontrado.' });
    
    if (product.origin === 'priceshoes') {
      try {
        const liveData = await syncSingleProductLive(product);
        if (liveData) {
          const sortedSizes = liveData.sizes.sort((a, b) => {
            const numA = parseFloat(a);
            const numB = parseFloat(b);
            if (isNaN(numA) && isNaN(numB)) return a.toString().localeCompare(b.toString());
            if (isNaN(numA)) return 1;
            if (isNaN(numB)) return -1;
            return numA - numB;
          });

          return res.json({
            success: true,
            stock: liveData.stock,
            sizes: sortedSizes,
            sizes_stock: liveData.sizes_stock
          });
        }
      } catch (syncErr) {
        console.error(`[Single Product Sync API] Failed live sync for product ID ${product.id}:`, syncErr.message);
      }
    }
    
    // Fallback: return current database stock/sizes
    const parsedSizes = Array.from(new Set(JSON.parse(product.sizes || '[]')));
    const sortedSizes = parsedSizes.sort((a, b) => {
      const numA = parseFloat(a);
      const numB = parseFloat(b);
      if (isNaN(numA) && isNaN(numB)) return a.toString().localeCompare(b.toString());
      if (isNaN(numA)) return 1;
      if (isNaN(numB)) return -1;
      return numA - numB;
    });

    res.json({
      success: false,
      stock: product.stock,
      sizes: sortedSizes,
      sizes_stock: JSON.parse(product.sizes_stock || '{}')
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al sincronizar el producto.' });
  }
});

// POST Checkout and Payment preference generation
app.post('/api/checkout', rateLimiter(10, 60000), async (req, res) => {
  const { customerName, customerEmail, customerPhone, shippingAddress, items, shippingCarrier, couponCode } = req.body;
  
  if (!customerName || !customerEmail || !customerPhone || !shippingAddress || !items || items.length === 0) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  }
  
  try {
    // Attempt to parse customer JWT from Authorization header
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    let customerId = null;
    if (token) {
      try {
        const decoded = jwt.verify(token, CUSTOMER_JWT_SECRET);
        customerId = decoded.id;
      } catch (tokenErr) {
        // invalid token, process as guest
      }
    }

    // Validate Coupon if provided
    let coupon = null;
    if (couponCode) {
      if (!customerId) {
        return res.status(400).json({ error: 'Inicia sesión para aplicar un cupón.' });
      }
      // 1. Search user coupons first
      coupon = await dbQuery.get(
        "SELECT * FROM user_coupons WHERE user_id = ? AND LOWER(code) = ? AND used = 0",
        [customerId, couponCode.trim().toLowerCase()]
      );
      if (!coupon) {
        // 2. Search global coupons
        coupon = await dbQuery.get(
          "SELECT * FROM global_coupons WHERE LOWER(code) = ?",
          [couponCode.trim().toLowerCase()]
        );
      }
      if (!coupon) {
        return res.status(400).json({ error: 'El cupón no es válido o ya fue utilizado.' });
      }
    }

    // 1. Calculate secure total from DB prices (prevent client-side tampering)
    let itemsSubtotal = 0;
    const finalItems = [];
    
    for (const item of items) {
      const product = await dbQuery.get("SELECT * FROM products WHERE id = ?", [item.id]);
      if (!product) {
        return res.status(400).json({ error: `El producto ${item.title} no está disponible.` });
      }
      
      const sizesArray = JSON.parse(product.sizes || '[]');
      const isPicafresa = product.title && product.title.toLowerCase().includes('picafresa');
      if (!isPicafresa && !sizesArray.includes(item.size.toString())) {
        return res.status(400).json({ error: `La talla ${item.size} no está disponible para ${product.title}.` });
      }
      
      // Check stock for local PAPS products
      if (product.origin === 'PAPS' && product.stock < item.qty) {
        return res.status(400).json({ 
          error: `Lo sentimos, el producto "${product.title}" no tiene suficiente stock disponible (Disponible: ${product.stock}).` 
        });
      }
      
      // Real-time stock verification for Price Shoes dropshipping products
      if (product.origin === 'priceshoes' && product.original_url) {
        const isStillInStock = await verifyLiveStock(product.original_url, item.size);
        if (!isStillInStock) {
          // If the size is out of stock on Price Shoes, remove it from our local database to keep it updated
          const updatedSizes = sizesArray.filter(s => s.toString().trim() !== item.size.toString().trim());
          await dbQuery.run("UPDATE products SET sizes = ? WHERE id = ?", [JSON.stringify(updatedSizes), product.id]);
          
          return res.status(400).json({ 
            error: `Lo sentimos, el producto "${product.title}" se acaba de agotar en la talla ${item.size} en el almacén del proveedor. Tu saldo no ha sido cobrado.` 
          });
        }
      }
      
      const securePrice = calculatePrice(product.supplier_price);
      itemsSubtotal += securePrice * item.qty;
      
      finalItems.push({
        id: product.id,
        sku: product.sku,
        title: product.title,
        size: item.size,
        color: item.color || product.color,
        price: securePrice,
        qty: item.qty
      });
    }

    let discountAmount = 0;
    if (coupon) {
      if (coupon.discount_type === 'amount') {
        discountAmount = coupon.discount_value || 0;
      } else if (coupon.discount_type === 'percent') {
        discountAmount = itemsSubtotal * ((coupon.discount_value || 0) / 100);
      } else {
        // user coupon fallback (uses discount_percent)
        discountAmount = itemsSubtotal * ((coupon.discount_percent || 0) / 100);
      }
    }
    let calculatedTotal = itemsSubtotal - discountAmount;

    // Envío incluido en el precio del producto — no se suma costo adicional
    // Solo se registra el método de entrega elegido por el cliente
    const selectedShippingCost = 0;
    let finalCarrierName = shippingCarrier && shippingCarrier.toLowerCase().includes('recoger')
      ? 'Recoger en persona'
      : (shippingCarrier || 'Envío a domicilio');

    calculatedTotal = Math.round(calculatedTotal * 100) / 100;
    
    // 2. Generate unique Folio
    const lastOrder = await dbQuery.get("SELECT id FROM orders ORDER BY created_at DESC LIMIT 1");
    let nextNum = 1001;
    if (lastOrder && (lastOrder.id.startsWith('MARYLIN-') || lastOrder.id.startsWith('BRVN-') || lastOrder.id.startsWith('PAPS-'))) {
      const lastNum = parseInt(lastOrder.id.split('-')[1]);
      if (!isNaN(lastNum)) nextNum = lastNum + 1;
    }
    const orderFolio = `BRVN-${nextNum}`;
    
    // 3. Register Order in Pending state
    // For pickup orders, selectedShippingCost is already 0 (set in the shipping calc block above)
    const shippingCostToSave = shippingCarrier && shippingCarrier.toLowerCase().includes('recoger') ? 0 : selectedShippingCost;
    await dbQuery.run(`
      INSERT INTO orders (
        id, customer_name, customer_email, customer_phone, shipping_address, items, total, status, customer_id, shipping_carrier, coupon_code, shipping_cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `, [
      orderFolio,
      customerName,
      customerEmail,
      customerPhone,
      shippingAddress,
      JSON.stringify(finalItems),
      calculatedTotal,
      customerId,
      finalCarrierName,
      coupon ? coupon.code : null,
      shippingCostToSave
    ]);

    // Bypassing payment preference creation for zero cost test checkout
    if (calculatedTotal === 0) {
      console.log(`[Zero Price Checkout] Generated link for folio: ${orderFolio}`);
      return res.json({
        folio: orderFolio,
        checkoutUrl: `/simulated-payment.html?folio=${orderFolio}&total=0`
      });
    }

    // (Envío ya incluido en precio — no se recalcula aquí)
    
    // 4. Create Mercado Pago Preference
    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    const isMock = !mpToken || mpToken.startsWith('TEST-xxx');
    
    if (isMock) {
      // Return a simulated checkout link for local sandbox testing
      console.log(`[Mercado Pago Preference Mocked] Generated link for folio: ${orderFolio}`);
      return res.json({
        folio: orderFolio,
        checkoutUrl: `/simulated-payment.html?folio=${orderFolio}&total=${calculatedTotal}`
      });
    }
    
    // Call Mercado Pago API
    const host = req.get('host');
    let baseUrl = process.env.PUBLIC_URL || `https://${host}`;
    
    // Mercado Pago does not allow localhost or local IPs in back_urls.
    // If running locally, we check if PUBLIC_URL is defined in .env, otherwise fallback to a dummy public URL.
    if (host.includes('localhost') || host.includes('127.0.0.1') || host.startsWith('192.168.')) {
      if (process.env.PUBLIC_URL) {
        baseUrl = process.env.PUBLIC_URL;
      } else {
        console.warn('[Mercado Pago] Local host detected. Mercado Pago does not allow localhost in back_urls. Falling back to a dummy public URL (https://brvn-store.com). To test redirects locally, please set PUBLIC_URL in your .env (e.g. using ngrok).');
        baseUrl = 'https://brvn-store.com';
      }
    }

    const preferenceData = {
      items: finalItems.map(i => ({
        id: i.id,
        title: `${i.title} (Talla: ${i.size}, Color: ${i.color})`,
        quantity: i.qty,
        unit_price: i.price,
        currency_id: 'MXN'
      })),
      payer: {
        name: customerName,
        email: customerEmail,
        phone: {
          number: customerPhone.replace(/\D/g, '')
        }
      },
      back_urls: {
        success: `${baseUrl}/checkout-result.html?status=success&folio=${orderFolio}`,
        failure: `${baseUrl}/checkout-result.html?status=failure&folio=${orderFolio}`,
        pending: `${baseUrl}/checkout-result.html?status=pending&folio=${orderFolio}`
      },
      auto_return: 'approved',
      external_reference: orderFolio,
      notification_url: `${baseUrl}/api/webhooks/mercadopago`
    };
    
    const mpResponse = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${mpToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(preferenceData)
    });
    
    const prefResult = await mpResponse.json();
    if (mpResponse.ok && prefResult.init_point) {
      // Save MP Preference ID in orders DB
      await dbQuery.run("UPDATE orders SET mp_preference_id = ? WHERE id = ?", [prefResult.id, orderFolio]);
      
      res.json({
        folio: orderFolio,
        checkoutUrl: prefResult.init_point
      });
    } else {
      console.error('Mercado Pago Error:', prefResult);
      res.status(500).json({ error: 'Error al contactar con la pasarela de pagos.' });
    }
    
  } catch (err) {
    console.error('Checkout error:', err);
    res.status(500).json({ error: 'Ocurrió un error al procesar la compra.' });
  }
});

// POST Mercado Pago Webhook / Notification IPN
app.post('/api/webhooks/mercadopago', async (req, res) => {
  // Respond instantly to MP to acknowledge receipt
  res.status(200).send('OK');
  
  const query = req.query || {};
  const body = req.body || {};
  
  // Mercado Pago sends webhooks in req.body and IPNs in req.query
  const topic = query.topic || query.type || body.type || body.action;
  const resourceId = query.id || query['data.id'] || (body.data && body.data.id) || body.id;
  
  // Normalizing topic since MP action webhook can send "payment.created" or similar
  const isPaymentEvent = topic === 'payment' || (topic && topic.startsWith('payment'));
  
  if (isPaymentEvent && resourceId) {
    try {
      const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
      if (!mpToken || mpToken.startsWith('TEST-xxx')) return;
      
      // Query payment details from Mercado Pago API
      const mpPayResponse = await fetch(`https://api.mercadopago.com/v1/payments/${resourceId}`, {
        headers: { 'Authorization': `Bearer ${mpToken}` }
      });
      
      if (mpPayResponse.ok) {
        const payment = await mpPayResponse.json();
        const folio = payment.external_reference;
        const status = payment.status;
        
        if (status === 'approved' && folio) {
          await handleOrderPaymentSuccess(folio, resourceId.toString());
        }
      }
    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }
  }
});

// POST Client Order Tracking
app.post('/api/orders/track', async (req, res) => {
  const { folio, contact } = req.body;
  if (!folio || !contact) {
    return res.status(400).json({ error: 'Folio y contacto son obligatorios.' });
  }
  
  try {
    const order = await dbQuery.get(`
      SELECT * FROM orders 
      WHERE id = ? AND (LOWER(customer_email) = ? OR customer_phone = ?)
    `, [
      folio.trim(),
      contact.trim().toLowerCase(),
      contact.trim()
    ]);
    
    if (!order) {
      return res.status(404).json({ error: 'No se encontró ningún pedido con esos datos de folio y contacto.' });
    }
    
    res.json({
      folio: order.id,
      customerName: order.customer_name,
      items: JSON.parse(order.items),
      total: order.total,
      status: order.status,
      trackingStatus: order.tracking_status || 'compra_realizada',
      trackingNumber: order.tracking_number,
      shippingCarrier: order.shipping_carrier,
      createdAt: order.created_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al consultar el rastreo de pedido.' });
  }
});

// POST Simulated Payment Callback (for Mock Sandbox testing)
app.post('/api/checkout/simulate-payment', async (req, res) => {
  const { folio } = req.body;
  try {
    const order = await dbQuery.get("SELECT * FROM orders WHERE id = ?", [folio]);
    if (order && order.status === 'pending') {
      const paymentId = `SIM-PAY-${Date.now()}`;
      await handleOrderPaymentSuccess(folio, paymentId);
      res.json({ success: true });
    } else {
      res.status(400).json({ error: 'El pedido no existe o ya está pagado.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Error en la simulación de pago.' });
  }
});

// POST Verify Mercado Pago Payment (fallback when redirecting back)
app.post('/api/checkout/verify-payment', async (req, res) => {
  const { folio, paymentId } = req.body;
  if (!folio || !paymentId) {
    return res.status(400).json({ error: 'Folio y paymentId son requeridos.' });
  }

  try {
    const order = await dbQuery.get("SELECT * FROM orders WHERE id = ?", [folio]);
    if (!order) {
      return res.status(404).json({ error: 'Pedido no encontrado.' });
    }

    if (order.status !== 'pending') {
      // Order is already paid or processed
      return res.json({ success: true, status: order.status });
    }

    const mpToken = process.env.MERCADOPAGO_ACCESS_TOKEN;
    const isMock = !mpToken || mpToken.startsWith('TEST-xxx');

    if (isMock) {
      // In sandbox mock mode, if we get here we can approve it if requested
      if (paymentId.startsWith('SIM-PAY-')) {
        await handleOrderPaymentSuccess(folio, paymentId);
        return res.json({ success: true, status: 'paid' });
      }
      return res.status(400).json({ error: 'Credenciales de prueba activas. Use el simulador.' });
    }

    // Call Mercado Pago API to verify payment status
    const mpPayResponse = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
      headers: { 'Authorization': `Bearer ${mpToken}` }
    });

    if (mpPayResponse.ok) {
      const payment = await mpPayResponse.json();
      const mpFolio = payment.external_reference;
      const mpStatus = payment.status;

      if (mpFolio === folio && mpStatus === 'approved') {
        await handleOrderPaymentSuccess(folio, paymentId.toString());
        return res.json({ success: true, status: 'paid' });
      } else {
        return res.status(400).json({ 
          error: `El pago no está aprobado o no coincide con el folio. Estado MP: ${mpStatus}` 
        });
      }
    } else {
      const errData = await mpPayResponse.text();
      console.error('Error verifying payment with Mercado Pago:', errData);
      return res.status(500).json({ error: 'No se pudo verificar el pago con Mercado Pago.' });
    }
  } catch (err) {
    console.error('Error in verify-payment:', err);
    res.status(500).json({ error: 'Error interno al verificar el pago.' });
  }
});


/* --- NODEMAILER & AUTH SIGNUP / VERIFICATION SYSTEM --- */

const nodemailer = require('nodemailer');
let mailTransporter;

async function initNodemailer() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  
  if (host && user && pass) {
    mailTransporter = nodemailer.createTransport({
      host: host,
      port: parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth: {
        user: user,
        pass: pass
      },
      connectionTimeout: 10000, // 10 seconds timeout
      greetingTimeout: 10000,
      socketTimeout: 15000
    });
    console.log(`[Email] Nodemailer configured using SMTP: ${host}`);
  } else {
    console.log('[Email] No SMTP credentials in environment. Generating dynamic Ethereal test account...');
    try {
      const testAccount = await nodemailer.createTestAccount();
      mailTransporter = nodemailer.createTransport({
        host: testAccount.smtp.host,
        port: testAccount.smtp.port,
        secure: testAccount.smtp.secure,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass
        }
      });
      console.log('--------------------------------------------------');
      console.log('📧 Dynamic Ethereal Email Account Generated!');
      console.log(`SMTP Host: ${testAccount.smtp.host}`);
      console.log(`SMTP Port: ${testAccount.smtp.port}`);
      console.log(`User:      ${testAccount.user}`);
      console.log(`Pass:      ${testAccount.pass}`);
      console.log('--------------------------------------------------');
    } catch (err) {
      console.error('Failed to create Nodemailer test account:', err.message);
    }
  }
}

initNodemailer();

const https = require('https');

async function sendMailHelper(mailOptions) {
  const host = process.env.SMTP_HOST;
  const pass = process.env.SMTP_PASS;

  if (host === 'smtp.resend.com' && pass && pass.startsWith('re_')) {
    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        from: mailOptions.from,
        to: Array.isArray(mailOptions.to) ? mailOptions.to : [mailOptions.to],
        subject: mailOptions.subject,
        html: mailOptions.html
      });

      const options = {
        hostname: 'api.resend.com',
        port: 443,
        path: '/emails',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${pass}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const parsed = JSON.parse(body);
              resolve({ messageId: parsed.id });
            } catch (e) {
              resolve({ messageId: 'unknown' });
            }
          } else {
            reject(new Error(`Resend API returned status ${res.statusCode}: ${body}`));
          }
        });
      });

      req.on('error', (e) => reject(e));
      req.write(postData);
      req.end();
    });
  }

  if (!mailTransporter) {
    console.warn(`[Email Warning] Transporter not ready. Verification code/link could not be sent.`);
    return { isFallback: true, messageId: 'fallback-no-transporter' };
  }
  return mailTransporter.sendMail(mailOptions);
}

function isValidCode(code) {
  const digits = code.split('').map(Number);
  let consecutiveCount = 1;
  for (let i = 1; i < digits.length; i++) {
    const diff = digits[i] - digits[i - 1];
    if (diff === 1 || diff === -1) {
      consecutiveCount++;
      if (consecutiveCount > 2) return false;
    } else {
      consecutiveCount = 1;
    }
  }
  return true;
}

function generateCode() {
  let code;
  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (!isValidCode(code));
  return code;
}

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  const { nombre, apellido_pat, apellido_mat, email, telefono, password } = req.body;
  
  if (!nombre || !apellido_pat || !apellido_mat || !email || !telefono || !password) {
    return res.status(400).json({ error: 'Todos los campos son obligatorios.' });
  }
  
  if (!/^\d{10}$/.test(telefono.trim())) {
    return res.status(400).json({ error: 'El número de teléfono debe ser de 10 dígitos.' });
  }
  
  // Password validation rules
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }
  if (!/[A-Z]/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe contener al menos una letra mayúscula.' });
  }
  if (!/[a-z]/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe contener al menos una letra minúscula.' });
  }
  if (!/\d/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe contener al menos un número.' });
  }
  if (!/[!@#$%^&*]/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe contener al menos un símbolo especial (!@#$%^&*).' });
  }
  
  try {
    const existing = await dbQuery.get("SELECT id, verified FROM users WHERE LOWER(email) = ?", [email.trim().toLowerCase()]);
    if (existing) {
      if (existing.verified === 1) {
        return res.status(400).json({ error: 'El correo electrónico ya está registrado.' });
      } else {
        // Delete the unverified user and their codes to allow them to register again and receive a new code
        await dbQuery.run("DELETE FROM verification_codes WHERE user_id = ?", [existing.id]);
        await dbQuery.run("DELETE FROM users WHERE id = ?", [existing.id]);
      }
    }
    
    const passwordHash = await bcrypt.hash(password, 12);
    
    const result = await dbQuery.run(`
      INSERT INTO users (nombre, apellido_pat, apellido_mat, email, telefono, password, verified)
      VALUES (?, ?, ?, ?, ?, ?, 0)
    `, [nombre.trim(), apellido_pat.trim(), apellido_mat.trim(), email.trim().toLowerCase(), telefono.trim(), passwordHash]);
    
    const userId = result.lastID;
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    
    await dbQuery.run(`
      INSERT INTO verification_codes (code, user_id, expires_at, used, attempts)
      VALUES (?, ?, ?, 0, 0)
    `, [code, userId, expiresAt]);
    
    const mailOptions = {
      from: '"B R V N" <noreply@brvn.com.mx>',
      to: email.trim().toLowerCase(),
      subject: 'Código de verificación - B R V N',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
          <h2 style="text-align: center; color: #111; letter-spacing: 0.2em; font-weight: bold;">B R V N</h2>
          <p style="color: #666; font-size: 16px; line-height: 1.5; text-align: center;">Gracias por registrarte. Para completar tu registro, por favor ingresa el siguiente código de verificación:</p>
          <div style="background-color: #f9f9f9; padding: 15px; text-align: center; border-radius: 6px; margin: 25px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 0.1em; color: #000;">${code}</span>
          </div>
          <p style="color: #ff3b30; font-size: 13px; font-weight: bold; text-align: center; margin-top: 15px;">Este código expira en 5 minutos.</p>
        </div>
      `
    };
    
    const info = await sendMailHelper(mailOptions);
    if (!info.isFallback) {
      console.log(`[Email] Verification code sent to ${email}: ${info.messageId}`);
    }
    
    res.json({ success: true, message: 'Usuario registrado. Por favor verifica tu correo.', email: email.trim().toLowerCase() });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Ocurrió un error al registrar la cuenta.' });
  }
});

// POST /api/auth/verify-email
app.post('/api/auth/verify-email', async (req, res) => {
  const { email, code } = req.body;
  if (!email || !code) {
    return res.status(400).json({ error: 'El correo y el código son obligatorios.' });
  }
  
  try {
    const user = await dbQuery.get("SELECT * FROM users WHERE LOWER(email) = ?", [email.trim().toLowerCase()]);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (user.verified === 1) {
      return res.status(400).json({ error: 'La cuenta ya está verificada.' });
    }
    
    const lastCode = await dbQuery.get(`
      SELECT * FROM verification_codes 
      WHERE user_id = ? AND used = 0
      ORDER BY created_at DESC LIMIT 1
    `, [user.id]);
    
    if (!lastCode) {
      return res.status(400).json({ error: 'Código incorrecto.' });
    }
    
    if (lastCode.attempts >= 5) {
      await dbQuery.run("UPDATE verification_codes SET used = 1 WHERE id = ?", [lastCode.id]);
      return res.status(400).json({ error: 'Código incorrecto. Límite de intentos alcanzado.' });
    }
    
    const now = new Date();
    const expiresAt = new Date(lastCode.expires_at);
    if (now > expiresAt) {
      return res.status(400).json({ error: 'Código expirado, solicita uno nuevo.' });
    }
    
    if (lastCode.code !== code.toString().trim()) {
      const newAttempts = lastCode.attempts + 1;
      if (newAttempts >= 5) {
        await dbQuery.run("UPDATE verification_codes SET used = 1, attempts = ? WHERE id = ?", [newAttempts, lastCode.id]);
        return res.status(400).json({ error: 'Código incorrecto. Límite de intentos alcanzado.' });
      } else {
        await dbQuery.run("UPDATE verification_codes SET attempts = ? WHERE id = ?", [newAttempts, lastCode.id]);
        const remaining = 5 - newAttempts;
        return res.status(400).json({ error: `Código incorrecto. Intentos restantes: ${remaining}` });
      }
    }
    
    // Success: Mark code as used and update user verified
    await dbQuery.run("UPDATE verification_codes SET used = 1 WHERE id = ?", [lastCode.id]);
    await dbQuery.run("UPDATE users SET verified = 1 WHERE id = ?", [user.id]);

    // Seed welcome coupons
    try {
      await dbQuery.run("INSERT INTO user_coupons (user_id, code, description, discount_percent, used) VALUES (?, 'MIPRIMERCOMPRA', '10% de Descuento en tu Primer Pedido', 10, 0)", [user.id]);
      await dbQuery.run("INSERT INTO user_coupons (user_id, code, description, discount_percent, used) VALUES (?, 'PAPSGIFT', 'Regalo en tu Primera Compra', 0, 0)", [user.id]);
    } catch (couponErr) {
      console.error('Error seeding coupons for verified user:', couponErr.message);
    }
    
    const fullName = `${user.nombre} ${user.apellido_pat} ${user.apellido_mat}`.trim();
    const token = jwt.sign({ id: user.id, email: user.email, name: fullName }, CUSTOMER_JWT_SECRET, { expiresIn: '30d' });
    
    res.json({
      success: true,
      token,
      customer: {
        id: user.id,
        name: fullName,
        email: user.email,
        phone: user.telefono
      }
    });
  } catch (err) {
    console.error('Verification error:', err);
    res.status(500).json({ error: 'Error interno al verificar el código.' });
  }
});

// POST /api/auth/resend-code
app.post('/api/auth/resend-code', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'El correo electrónico es requerido.' });
  }
  
  try {
    const user = await dbQuery.get("SELECT * FROM users WHERE LOWER(email) = ?", [email.trim().toLowerCase()]);
    if (!user) {
      return res.status(404).json({ error: 'Usuario no encontrado.' });
    }
    if (user.verified === 1) {
      return res.status(400).json({ error: 'La cuenta ya está verificada.' });
    }
    
    // Invalidate previous codes
    await dbQuery.run("UPDATE verification_codes SET used = 1 WHERE user_id = ?", [user.id]);
    
    const code = generateCode();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    
    await dbQuery.run(`
      INSERT INTO verification_codes (code, user_id, expires_at, used, attempts)
      VALUES (?, ?, ?, 0, 0)
    `, [code, user.id, expiresAt]);
    
    const mailOptions = {
      from: '"B R V N" <noreply@brvn.com.mx>',
      to: email.trim().toLowerCase(),
      subject: 'Nuevo código de verificación - B R V N',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
          <h2 style="text-align: center; color: #111; letter-spacing: 0.2em; font-weight: bold;">B R V N</h2>
          <p style="color: #666; font-size: 16px; line-height: 1.5; text-align: center;">Aquí está tu nuevo código de verificación:</p>
          <div style="background-color: #f9f9f9; padding: 15px; text-align: center; border-radius: 6px; margin: 25px 0;">
            <span style="font-size: 32px; font-weight: bold; letter-spacing: 0.1em; color: #000;">${code}</span>
          </div>
          <p style="color: #ff3b30; font-size: 13px; font-weight: bold; text-align: center; margin-top: 15px;">Este código expira en 5 minutos.</p>
        </div>
      `
    };
    
    const info = await sendMailHelper(mailOptions);
    if (!info.isFallback) {
      console.log(`[Email] New code sent to ${email}: ${info.messageId}`);
    }
    
    res.json({ success: true, message: 'Nuevo código enviado con éxito.' });
  } catch (err) {
    console.error('Resend error:', err);
    res.status(500).json({ error: 'Error al reenviar el código.' });
  }
});

// POST /api/auth/forgot-password
app.post('/api/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: 'El correo electrónico es requerido.' });
  }
  
  try {
    const user = await dbQuery.get("SELECT * FROM users WHERE LOWER(email) = ?", [email.trim().toLowerCase()]);
    
    // Security best practice: Always respond with success
    res.json({ success: true, message: 'Si el correo está registrado, recibirás un enlace de recuperación en unos momentos.' });
    
    if (user) {
      const resetToken = jwt.sign({ resetUserId: user.id, email: user.email }, CUSTOMER_JWT_SECRET, { expiresIn: '15m' });
      
      const host = req.get('host');
      const protocol = req.protocol;
      const baseUrl = `${protocol}://${host}`;
      
      const mailOptions = {
        from: '"B R V N" <noreply@brvn.com.mx>',
        to: email.trim().toLowerCase(),
        subject: 'Restablecer contraseña - B R V N',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
            <h2 style="text-align: center; color: #111; letter-spacing: 0.2em; font-weight: bold;">B R V N</h2>
            <p style="color: #666; font-size: 16px; line-height: 1.5;">Recibimos una solicitud para restablecer tu contraseña. Haz clic en el siguiente enlace para crear una nueva contraseña:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${baseUrl}/reset-password.html?token=${resetToken}" style="background-color: #000; color: #fff; padding: 12px 24px; text-decoration: none; border-radius: 4px; font-weight: bold; font-size: 14px; display: inline-block;">Restablecer Contraseña</a>
            </div>
            <p style="color: #999; font-size: 12px; text-align: center; margin-top: 15px;">Este enlace es válido por 15 minutos.</p>
          </div>
        `
      };
      
      const info = await sendMailHelper(mailOptions);
      if (!info.isFallback) {
        console.log(`[Email] Password reset sent to ${email}: ${info.messageId}`);
      } else {
        console.warn(`[Email Warning] Transporter not ready. Reset link for ${email} is: ${baseUrl}/reset-password.html?token=${resetToken}`);
      }
    }
  } catch (err) {
    console.error('Forgot password error:', err);
  }
});

// POST /api/auth/reset-password
app.post('/api/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'El token y la contraseña son obligatorios.' });
  }
  
  if (password.length < 8) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres.' });
  }
  if (!/[A-Z]/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe contener al menos una letra mayúscula.' });
  }
  if (!/[a-z]/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe contener al menos una letra minúscula.' });
  }
  if (!/\d/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe contener al menos un número.' });
  }
  if (!/[!@#$%^&*]/.test(password)) {
    return res.status(400).json({ error: 'La contraseña debe contener al menos un símbolo especial (!@#$%^&*).' });
  }
  
  try {
    let decoded;
    try {
      decoded = jwt.verify(token, CUSTOMER_JWT_SECRET);
    } catch (err) {
      return res.status(400).json({ error: 'El enlace de recuperación es inválido o ha expirado.' });
    }
    
    if (!decoded.resetUserId) {
      return res.status(400).json({ error: 'Enlace de recuperación inválido.' });
    }
    
    const passwordHash = await bcrypt.hash(password, 12);
    await dbQuery.run("UPDATE users SET password = ? WHERE id = ?", [passwordHash, decoded.resetUserId]);
    
    res.json({ success: true, message: 'Tu contraseña ha sido restablecida exitosamente.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Ocurrió un error al restablecer la contraseña.' });
  }
});


/* --- CUSTOMER APIS --- */

// GET active coupons for customer
app.get('/api/coupons', authenticateCustomer, async (req, res) => {
  try {
    const coupons = await dbQuery.all("SELECT code, description, discount_percent FROM user_coupons WHERE user_id = ? AND used = 0", [req.customer.id]);
    res.json({ success: true, coupons });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener los cupones.' });
  }
});

// POST validate coupon code
app.post('/api/coupons/validate', authenticateCustomer, async (req, res) => {
  const { code } = req.body;
  if (!code) {
    return res.status(400).json({ error: 'El código de cupón es obligatorio.' });
  }
  try {
    const normalizedCode = code.trim().toLowerCase();
    
    // 1. First search user-specific coupons
    const dbCoupon = await dbQuery.get(
      "SELECT * FROM user_coupons WHERE user_id = ? AND LOWER(code) = ? AND used = 0",
      [req.customer.id, normalizedCode]
    );
    
    if (dbCoupon) {
      return res.json({
        success: true,
        code: dbCoupon.code,
        description: dbCoupon.description,
        discount_percent: dbCoupon.discount_percent,
        discount_type: 'percent',
        discount_value: dbCoupon.discount_percent
      });
    }

    // 2. Then search global coupons
    const globalCoupon = await dbQuery.get(
      "SELECT * FROM global_coupons WHERE LOWER(code) = ?",
      [normalizedCode]
    );

    if (globalCoupon) {
      return res.json({
        success: true,
        code: globalCoupon.code,
        description: globalCoupon.description,
        discount_percent: globalCoupon.discount_type === 'percent' ? globalCoupon.discount_value : 0,
        discount_type: globalCoupon.discount_type,
        discount_value: globalCoupon.discount_value
      });
    }

    return res.status(400).json({ error: 'El cupón no es válido o ya fue utilizado.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al validar el cupón.' });
  }
});

// POST Customer Register
app.post('/api/customer/register', async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Nombre, correo y contraseña son obligatorios.' });
  }
  try {
    const existing = await dbQuery.get("SELECT id FROM users WHERE LOWER(email) = ?", [email.trim().toLowerCase()]);
    if (existing) {
      return res.status(400).json({ error: 'El correo electrónico ya está registrado.' });
    }
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);
    
    const parts = name.trim().split(/\s+/);
    const nombre = parts[0] || '';
    const apellido_pat = parts[1] || '';
    const apellido_mat = parts.slice(2).join(' ') || '';
    
    await dbQuery.run(`
      INSERT INTO users (nombre, apellido_pat, apellido_mat, email, telefono, password, verified)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `, [nombre, apellido_pat, apellido_mat, email.trim().toLowerCase(), phone ? phone.trim() : '', hash]);
    
    const user = await dbQuery.get("SELECT id FROM users WHERE LOWER(email) = ?", [email.trim().toLowerCase()]);
    
    // Seed welcome coupons
    try {
      await dbQuery.run("INSERT INTO user_coupons (user_id, code, description, discount_percent, used) VALUES (?, 'MIPRIMERCOMPRA', '10% de Descuento en tu Primer Pedido', 10, 0)", [user.id]);
      await dbQuery.run("INSERT INTO user_coupons (user_id, code, description, discount_percent, used) VALUES (?, 'PAPSGIFT', 'Regalo en tu Primera Compra', 0, 0)", [user.id]);
    } catch (couponErr) {
      console.error('Error seeding coupons for registered customer:', couponErr.message);
    }

    const token = jwt.sign({ id: user.id, email: email.trim().toLowerCase(), name: name.trim() }, CUSTOMER_JWT_SECRET, { expiresIn: '30d' });
    
    res.json({ success: true, token, customer: { id: user.id, name: name.trim(), email: email.trim().toLowerCase() } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la cuenta.' });
  }
});

// POST Customer Login
app.post('/api/customer/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Correo y contraseña son obligatorios.' });
  }
  try {
    const user = await dbQuery.get("SELECT * FROM users WHERE LOWER(email) = ?", [email.trim().toLowerCase()]);
    if (!user) {
      return res.status(401).json({ error: 'El correo o la contraseña son incorrectos.' });
    }
    if (user.verified !== 1) {
      return res.status(401).json({ error: 'Tu cuenta no está verificada. Por favor, verifica tu correo primero.' });
    }
    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: 'El correo o la contraseña son incorrectos.' });
    }
    
    const fullName = `${user.nombre} ${user.apellido_pat} ${user.apellido_mat}`.trim();
    const token = jwt.sign({ id: user.id, email: user.email, name: fullName }, CUSTOMER_JWT_SECRET, { expiresIn: '30d' });
    
    res.json({
      success: true,
      token,
      customer: {
        id: user.id,
        name: fullName,
        email: user.email,
        phone: user.telefono
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en el inicio de sesión.' });
  }
});

// GET Customer Profile Info
app.get('/api/customer/profile', authenticateCustomer, async (req, res) => {
  try {
    const user = await dbQuery.get("SELECT id, nombre, apellido_pat, apellido_mat, email, telefono as phone, created_at FROM users WHERE id = ?", [req.customer.id]);
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
    
    const fullName = `${user.nombre} ${user.apellido_pat} ${user.apellido_mat}`.trim();
    res.json({
      id: user.id,
      name: fullName,
      nombre: user.nombre,
      apellido_pat: user.apellido_pat,
      apellido_mat: user.apellido_mat,
      email: user.email,
      phone: user.phone,
      created_at: user.created_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener perfil del cliente.' });
  }
});

// PUT Update Customer Profile Info
app.put('/api/customer/profile', authenticateCustomer, async (req, res) => {
  const { nombre, apellido_pat, apellido_mat, name, phone, password } = req.body;
  
  let finalNombre = nombre;
  let finalPat = apellido_pat;
  let finalMat = apellido_mat;
  
  if (!finalNombre && name) {
    const parts = name.trim().split(/\s+/);
    finalNombre = parts[0] || '';
    finalPat = parts[1] || '';
    finalMat = parts.slice(2).join(' ') || '';
  }
  
  if (!finalNombre) {
    return res.status(400).json({ error: 'El nombre es obligatorio.' });
  }
  
  try {
    if (password && password.trim().length >= 8) {
      const passwordHash = await bcrypt.hash(password.trim(), 12);
      await dbQuery.run(
        "UPDATE users SET nombre = ?, apellido_pat = ?, apellido_mat = ?, telefono = ?, password = ? WHERE id = ?",
        [finalNombre, finalPat || '', finalMat || '', phone || '', passwordHash, req.customer.id]
      );
    } else {
      await dbQuery.run(
        "UPDATE users SET nombre = ?, apellido_pat = ?, apellido_mat = ?, telefono = ? WHERE id = ?",
        [finalNombre, finalPat || '', finalMat || '', phone || '', req.customer.id]
      );
    }
    res.json({ success: true, message: 'Perfil actualizado exitosamente.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar el perfil.' });
  }
});

// GET Customer Purchase History
app.get('/api/customer/orders', authenticateCustomer, async (req, res) => {
  try {
    const orders = await dbQuery.all("SELECT * FROM orders WHERE customer_id = ? ORDER BY created_at DESC", [req.customer.id]);
    
    const customerRatings = await dbQuery.all("SELECT product_id, order_id, rating FROM ratings WHERE customer_id = ?", [req.customer.id]);
    const ratedMap = {};
    customerRatings.forEach(r => {
      ratedMap[`${r.order_id}-${r.product_id}`] = r.rating;
    });
    
    const mapped = orders.map(o => {
      const items = JSON.parse(o.items || '[]');
      const itemsWithRating = items.map(item => ({
        ...item,
        userRating: ratedMap[`${o.id}-${item.id}`] || 0
      }));
      return {
        ...o,
        items: itemsWithRating
      };
    });
    res.json(mapped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener el historial de pedidos.' });
  }
});

// POST Favorite (Toggle)
app.post('/api/customer/favorites', authenticateCustomer, async (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: 'El ID del producto es requerido.' });
  
  try {
    const existing = await dbQuery.get("SELECT * FROM favorites WHERE customer_id = ? AND product_id = ?", [req.customer.id, productId]);
    
    if (existing) {
      await dbQuery.run("DELETE FROM favorites WHERE customer_id = ? AND product_id = ?", [req.customer.id, productId]);
      res.json({ success: true, saved: false });
    } else {
      await dbQuery.run("INSERT INTO favorites (customer_id, product_id) VALUES (?, ?)", [req.customer.id, productId]);
      res.json({ success: true, saved: true });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al actualizar favoritos.' });
  }
});

// GET Customer Favorites
app.get('/api/customer/favorites', authenticateCustomer, async (req, res) => {
  try {
    const rows = await dbQuery.all(`
      SELECT p.* FROM products p
      JOIN favorites f ON p.id = f.product_id
      WHERE f.customer_id = ? AND p.status = 'active'
    `, [req.customer.id]);
    
    // Fetch average ratings
    const ratingsData = await dbQuery.all("SELECT product_id, AVG(rating) as avgRating, COUNT(rating) as countRating FROM ratings GROUP BY product_id");
    const ratingsMap = {};
    ratingsData.forEach(r => {
      ratingsMap[r.product_id] = {
        average: r.avgRating ? parseFloat(r.avgRating.toFixed(1)) : 0,
        count: r.countRating || 0
      };
    });

    const mapped = rows.map(p => {
      return {
        ...p,
        price: calculatePrice(p.supplier_price),
        images: JSON.parse(p.images || '[]'),
        sizes: JSON.parse(p.sizes || '[]'),
        isFavorite: true,
        rating: ratingsMap[p.id] || { average: 0, count: 0 }
      };
    });
    
    res.json(mapped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener favoritos.' });
  }
});

// POST Rate Product (Order Rating)
app.post('/api/customer/orders/:orderId/rate', authenticateCustomer, async (req, res) => {
  const { productId, rating } = req.body;
  const { orderId } = req.params;
  
  const r = parseInt(rating);
  if (!productId || isNaN(r) || r < 1 || r > 5) {
    return res.status(400).json({ error: 'Producto y calificación (1-5) válidos son requeridos.' });
  }
  
  try {
    const order = await dbQuery.get("SELECT * FROM orders WHERE id = ? AND customer_id = ? AND status IN ('paid', 'purchased_on_supplier', 'shipped')", [orderId, req.customer.id]);
    if (!order) {
      return res.status(400).json({ error: 'No se encontró una compra elegible para calificar.' });
    }
    
    const items = JSON.parse(order.items || '[]');
    const hasProduct = items.some(item => item.id === productId);
    if (!hasProduct) {
      return res.status(400).json({ error: 'El producto no forma parte de este pedido.' });
    }
    
    await dbQuery.run(`
      INSERT INTO ratings (customer_id, product_id, order_id, rating)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(customer_id, product_id, order_id) DO UPDATE SET rating = excluded.rating
    `, [req.customer.id, productId, orderId, r]);
    
    res.json({ success: true, rating: r });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al registrar la calificación.' });
  }
});




/* --- ADMIN APIS (JWT Protected) --- */

// POST Admin Login
app.post('/api/admin/login', rateLimiter(5, 60000), async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuario y contraseña son requeridos.' });
  }
  
  try {
    const user = await dbQuery.get("SELECT * FROM admins WHERE username = ?", [username]);
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas.' });
    
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas.' });
    
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } catch (err) {
    res.status(500).json({ error: 'Error en el inicio de sesión.' });
  }
});

// GET All Orders list
app.get('/api/admin/orders', authenticateAdmin, async (req, res) => {
  try {
    const orders = await dbQuery.all("SELECT * FROM orders ORDER BY created_at DESC");
    const mapped = orders.map(o => ({
      ...o,
      items: JSON.parse(o.items)
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener los pedidos.' });
  }
});

// POST Ship Order (Sets carrier and tracking ID)
app.post('/api/admin/orders/:id/ship', authenticateAdmin, async (req, res) => {
  const { carrier, trackingNumber } = req.body;
  if (!carrier || !trackingNumber) {
    return res.status(400).json({ error: 'Paquetería y número de guía son requeridos.' });
  }
  
  try {
    const order = await dbQuery.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
    
    await dbQuery.run(`
      UPDATE orders 
      SET status = 'shipped', tracking_number = ?, shipping_carrier = ?, tracking_status = 'recolectado' 
      WHERE id = ?
    `, [trackingNumber, carrier, req.params.id]);
    
    console.log(`Order ${req.params.id} marked as SHIPPED via ${carrier} with guide ${trackingNumber}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar despacho del pedido.' });
  }
});

// POST Update Order Tracking Details (Admin only)
app.post('/api/admin/orders/:id/tracking', authenticateAdmin, async (req, res) => {
  const { tracking_status, tracking_number, shipping_carrier } = req.body;
  const validStatuses = ['compra_realizada', 'recolectado', 'centro_distribucion', 'en_ruta', 'entregado'];
  
  if (!tracking_status || !validStatuses.includes(tracking_status)) {
    return res.status(400).json({ error: 'Estado de seguimiento no válido.' });
  }
  
  try {
    const order = await dbQuery.get("SELECT * FROM orders WHERE id = ?", [req.params.id]);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado.' });
    
    let newOrderStatus = order.status;
    if (tracking_status === 'compra_realizada') {
      newOrderStatus = 'paid';
    } else {
      newOrderStatus = 'shipped';
    }
    
    await dbQuery.run(`
      UPDATE orders 
      SET tracking_status = ?, tracking_number = ?, shipping_carrier = ?, status = ?
      WHERE id = ?
    `, [
      tracking_status, 
      tracking_number !== undefined ? tracking_number.trim() : order.tracking_number, 
      shipping_carrier !== undefined ? shipping_carrier.trim() : order.shipping_carrier, 
      newOrderStatus, 
      req.params.id
    ]);
    
    console.log(`Order ${req.params.id} tracking updated: status=${tracking_status}, carrier=${shipping_carrier}, trackingNumber=${tracking_number}`);
    res.json({ success: true, trackingStatus: tracking_status });
  } catch (err) {
    console.error('Error updating order tracking:', err);
    res.status(500).json({ error: 'Error interno al actualizar el seguimiento del pedido.' });
  }
});

// GET Admin Dashboard Data Analytics
app.get('/api/admin/analytics', authenticateAdmin, async (req, res) => {
  try {
    // 1. Core aggregates
    const salesData = await dbQuery.get("SELECT SUM(total) as revenue, COUNT(*) as count FROM orders WHERE status != 'pending'");
    const totalRevenue = salesData.revenue || 0;
    const salesCount = salesData.count || 0;
    
    const pendingData = await dbQuery.get("SELECT COUNT(*) as count FROM orders WHERE status = 'pending'");
    const abandonedCarts = pendingData.count || 0;
    
    // Conversions: approved orders / total orders logged
    const totalLogged = salesCount + abandonedCarts;
    const conversionRate = totalLogged > 0 ? ((salesCount / totalLogged) * 100).toFixed(1) : 0;
    
    // 2. Hour Analysis (0 - 23)
    const hourRows = await dbQuery.all(`
      SELECT STRFTIME('%H', created_at) as hour, COUNT(*) as count, SUM(total) as revenue 
      FROM orders 
      WHERE status != 'pending' 
      GROUP BY hour
    `);
    
    // 3. Gender/Category Analysis
    const orderRows = await dbQuery.all("SELECT items FROM orders WHERE status != 'pending'");
    const genderStats = { 'Hombre': 0, 'Mujer': 0, 'Niños': 0, 'Unisex': 0 };
    
    for (const row of orderRows) {
      try {
        const items = JSON.parse(row.items);
        for (const item of items) {
          // Look up product category
          const prod = await dbQuery.get("SELECT gender FROM products WHERE sku = ?", [item.sku]);
          let itemGender = prod ? prod.gender : 'Unisex';
          if (itemGender === 'Caballero') itemGender = 'Hombre';
          if (itemGender === 'Dama') itemGender = 'Mujer';
          genderStats[itemGender] = (genderStats[itemGender] || 0) + item.qty;
        }
      } catch (e) {
        // ignore JSON parse errors
      }
    }
    
    res.json({
      summary: {
        revenue: totalRevenue,
        salesCount: salesCount,
        abandonedCarts: abandonedCarts,
        conversionRate: `${conversionRate}%`,
        ticketAverage: salesCount > 0 ? Math.round(totalRevenue / salesCount) : 0
      },
      hours: hourRows,
      gender: genderStats
    });
    
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ error: 'Error al compilar analíticas.' });
  }
});

// GET Detailed Financial Sales Report
app.get('/api/admin/reports', authenticateAdmin, async (req, res) => {
  try {
    // Fetch all paid orders (exclude 'pending' which are just abandoned carts)
    const orders = await dbQuery.all(
      "SELECT * FROM orders WHERE status != 'pending' ORDER BY created_at DESC"
    );

    let totalRevenue = 0;
    let totalCost = 0;
    const enrichedOrders = [];

    for (const order of orders) {
      let items = [];
      try { items = JSON.parse(order.items || '[]'); } catch (e) { items = []; }

      // Calculate supplier cost for this order by looking up each SKU's supplier_price
      let orderCost = 0;
      for (const item of items) {
        const prod = await dbQuery.get(
          "SELECT supplier_price FROM products WHERE sku = ?", [item.sku]
        );
        const supplierPrice = prod ? (prod.supplier_price || 0) : 0;
        orderCost += supplierPrice * (item.qty || 1);
      }

      totalRevenue += order.total || 0;
      totalCost    += orderCost;

      enrichedOrders.push({
        id: order.id,
        created_at: order.created_at,
        customer_name: order.customer_name,
        customer_email: order.customer_email,
        status: order.status,
        items: items,
        revenue: Math.round(order.total || 0),
        cost: Math.round(orderCost)
      });
    }

    const totalProfit = totalRevenue - totalCost;
    const totalMargin = totalRevenue > 0
      ? ((totalProfit / totalRevenue) * 100).toFixed(1)
      : '0.0';

    res.json({
      summary: {
        revenue: Math.round(totalRevenue),
        cost:    Math.round(totalCost),
        profit:  Math.round(totalProfit),
        margin:  totalMargin
      },
      orders: enrichedOrders
    });

  } catch (err) {
    console.error('Reports error:', err);
    res.status(500).json({ error: 'Error al generar el reporte financiero.' });
  }
});

// GET Detailed Financial Report as CSV
app.get('/api/admin/reports/csv', authenticateAdmin, async (req, res) => {
  try {
    const orders = await dbQuery.all(
      "SELECT * FROM orders WHERE status != 'pending' ORDER BY created_at DESC"
    );

    let csv = "Folio,Fecha,Cliente,Email,Telefono,Producto,SKU,Talla,Color,Cantidad,Ingreso (MXN),Costo Proveedor (MXN),Ganancia (MXN),Margen (%),Estatus\r\n";

    for (const order of orders) {
      let items = [];
      try { items = JSON.parse(order.items || '[]'); } catch (e) { items = []; }

      for (const item of items) {
        const prod = await dbQuery.get("SELECT supplier_price FROM products WHERE sku = ?", [item.sku]);
        const supplierPrice = prod ? (prod.supplier_price || 0) : 0;
        const itemRevenue = (item.price || 0) * (item.qty || 1);
        const itemCost    = supplierPrice * (item.qty || 1);
        const itemProfit  = itemRevenue - itemCost;
        const itemMargin  = itemRevenue > 0 ? ((itemProfit / itemRevenue) * 100).toFixed(1) : '0.0';

        csv += [
          `"${order.id}"`,
          `"${order.created_at}"`,
          `"${order.customer_name}"`,
          `"${order.customer_email}"`,
          `"${order.customer_phone}"`,
          `"${(item.title || '').replace(/"/g, '""')}"`,
          `"${item.sku || ''}"`,
          `"${item.size || ''}"`,
          `"${item.color || ''}"`,
          item.qty || 1,
          Math.round(itemRevenue),
          Math.round(itemCost),
          Math.round(itemProfit),
          itemMargin,
          `"${order.status}"`
        ].join(',') + '\r\n';
      }
    }

    res.header('Content-Type', 'text/csv; charset=utf-8');
    res.attachment('PAPS_Reporte_Financiero.csv');
    res.send('\uFEFF' + csv); // BOM for Excel UTF-8 compatibility
  } catch (err) {
    console.error('CSV export error:', err);
    res.status(500).json({ error: 'Error al exportar reporte CSV.' });
  }
});

// GET Export Analytics to CSV format
app.get('/api/admin/export-csv', authenticateAdmin, async (req, res) => {
  try {
    const orders = await dbQuery.all("SELECT id, customer_name, customer_email, customer_phone, total, status, created_at FROM orders ORDER BY created_at DESC");
    
    let csv = "Folio,Cliente,Email,Telefono,Monto Total,Estatus,Fecha\r\n";
    for (const o of orders) {
      csv += `"${o.id}","${o.customer_name}","${o.customer_email}","${o.customer_phone}",${o.total},"${o.status}","${o.created_at}"\r\n`;
    }
    
    res.header('Content-Type', 'text/csv');
    res.attachment('PAPS_Reporte_Ventas.csv');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: 'Error al exportar reporte.' });
  }
});

// GET Abandoned Carts Details
app.get('/api/admin/abandoned', authenticateAdmin, async (req, res) => {
  try {
    const carts = await dbQuery.all("SELECT * FROM orders WHERE status = 'pending' ORDER BY created_at DESC");
    const mapped = carts.map(c => ({
      ...c,
      items: JSON.parse(c.items)
    }));
    res.json(mapped);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener carritos abandonados.' });
  }
});

// POST Trigger Scraper
app.post('/api/admin/scrape', authenticateAdmin, async (req, res) => {
  const { searchUrl, limit, category } = req.body;
  if (!searchUrl) return res.status(400).json({ error: 'URL del catálogo es requerida.' });
  
  const productLimit = parseInt(limit) || 30;
  const targetCategory = category || 'General';
  console.log(`[Admin Scraper Request] Starting scrape for URL: ${searchUrl}, limit: ${productLimit}, category: ${targetCategory}`);
  
  // Save URL as a catalog source so it updates every hour automatically
  try {
    await dbQuery.run(`
      INSERT INTO catalog_sources (url, products_limit, category) 
      VALUES (?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET 
        products_limit = excluded.products_limit,
        category = excluded.category
    `, [searchUrl, productLimit, targetCategory]);
    console.log(`[Admin Scraper] Catalog source saved/updated in DB for auto-sync.`);
  } catch (dbErr) {
    console.error(`[Admin Scraper] Error saving catalog source in DB:`, dbErr.message);
  }
  
  // Run scraper asynchronously in background so the request responds instantly
  runScraper(searchUrl, productLimit, targetCategory)
    .then(saved => {
      console.log(`[Admin Scraper Async] Scraper completed. Saved: ${saved} products.`);
    })
    .catch(err => {
      console.error(`[Admin Scraper Async] Scraper failed:`, err);
    });
    
  res.json({ success: true, message: 'La sincronización ha comenzado en segundo plano.' });
});

// GET All Catalog Sources
app.get('/api/admin/catalog-sources', authenticateAdmin, async (req, res) => {
  try {
    const sources = await dbQuery.all("SELECT * FROM catalog_sources ORDER BY created_at DESC");
    res.json(sources);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener las fuentes del catálogo.' });
  }
});

// DELETE A Catalog Source
app.delete('/api/admin/catalog-sources/:id', authenticateAdmin, async (req, res) => {
  try {
    await dbQuery.run("DELETE FROM catalog_sources WHERE id = ?", [req.params.id]);
    console.log(`[Admin] Catalog source ID ${req.params.id} deleted.`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar la fuente del catálogo.' });
  }
});

// DELETE A Category and all its associated products and catalog sources
app.delete('/api/admin/categories/:categoryName', authenticateAdmin, async (req, res) => {
  const { categoryName } = req.params;
  const normalizedName = categoryName.trim();
  
  try {
    // Use LOWER(TRIM()) for case-insensitive matching to catch any casing/spacing mismatches
    const deletedProducts = await dbQuery.run(
      "DELETE FROM products WHERE LOWER(TRIM(category)) = LOWER(TRIM(?))", 
      [normalizedName]
    );
    const deletedSources = await dbQuery.run(
      "DELETE FROM catalog_sources WHERE LOWER(TRIM(category)) = LOWER(TRIM(?))", 
      [normalizedName]
    );
    
    console.log(`[Admin] Category "${normalizedName}" deleted: ${deletedProducts.changes} products, ${deletedSources.changes} catalog sources removed.`);
    res.json({ 
      success: true, 
      deletedProducts: deletedProducts.changes, 
      deletedSources: deletedSources.changes 
    });
  } catch (err) {
    console.error('Error deleting category:', err);
    res.status(500).json({ error: 'Error al eliminar la categoría y sus elementos asociados.' });
  }
});

// GET Preview purge count by keyword (Admin only)
app.get('/api/admin/products/purge/preview', authenticateAdmin, async (req, res) => {
  const { query } = req.query;
  if (!query || !query.trim()) {
    return res.status(400).json({ error: 'La palabra clave de búsqueda es requerida.' });
  }

  const keyword = `%${query.trim().toLowerCase()}%`;
  try {
    const result = await dbQuery.get(
      "SELECT COUNT(*) as count FROM products WHERE LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(category) LIKE ? OR LOWER(sku) LIKE ? OR LOWER(brand) LIKE ?",
      [keyword, keyword, keyword, keyword, keyword]
    );
    res.json({ count: result.count || 0 });
  } catch (err) {
    console.error('Error previewing product purge:', err);
    res.status(500).json({ error: 'Error al obtener la vista previa de la purga.' });
  }
});

// POST Purge products by keyword (Admin only)
app.post('/api/admin/products/purge', authenticateAdmin, async (req, res) => {
  const { query } = req.body;
  if (!query || query.trim().length < 3) {
    return res.status(400).json({ error: 'La palabra clave de purga debe tener al menos 3 caracteres.' });
  }

  const keyword = `%${query.trim().toLowerCase()}%`;
  try {
    const result = await dbQuery.run(
      "DELETE FROM products WHERE LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(category) LIKE ? OR LOWER(sku) LIKE ? OR LOWER(brand) LIKE ?",
      [keyword, keyword, keyword, keyword, keyword]
    );
    console.log(`[Admin Purge] Deleted ${result.changes} products matching keyword "${query.trim()}".`);
    res.json({ success: true, deletedCount: result.changes });
  } catch (err) {
    console.error('Error executing product purge:', err);
    res.status(500).json({ error: 'Error al eliminar los productos coincidentes.' });
  }
});

// GET Admin coupons list (Admin only)
app.get('/api/admin/coupons', authenticateAdmin, async (req, res) => {
  try {
    const coupons = await dbQuery.all("SELECT * FROM global_coupons ORDER BY created_at DESC");
    res.json({ success: true, coupons });
  } catch (err) {
    console.error('Error fetching admin coupons:', err);
    res.status(500).json({ error: 'Error al obtener los cupones.' });
  }
});

// POST Create global coupon (Admin only)
app.post('/api/admin/coupons', authenticateAdmin, async (req, res) => {
  const { code, description, discount_type, discount_value } = req.body;
  if (!code || !discount_type || discount_value === undefined) {
    return res.status(400).json({ error: 'Código, tipo y valor son requeridos.' });
  }
  if (discount_type !== 'percent' && discount_type !== 'amount') {
    return res.status(400).json({ error: 'Tipo de descuento inválido.' });
  }
  try {
    const existing = await dbQuery.get("SELECT id FROM global_coupons WHERE LOWER(code) = ?", [code.trim().toLowerCase()]);
    if (existing) {
      return res.status(400).json({ error: 'El cupón ya existe.' });
    }
    await dbQuery.run(
      "INSERT INTO global_coupons (code, description, discount_type, discount_value) VALUES (?, ?, ?, ?)",
      [code.trim().toUpperCase(), description || null, discount_type, parseFloat(discount_value)]
    );
    res.json({ success: true, message: 'Cupón creado exitosamente.' });
  } catch (err) {
    console.error('Error creating admin coupon:', err);
    res.status(500).json({ error: 'Error al crear el cupón.' });
  }
});

// DELETE Admin coupon (Admin only)
app.delete('/api/admin/coupons/:id', authenticateAdmin, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await dbQuery.run("DELETE FROM global_coupons WHERE id = ?", [id]);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'El cupón no existe.' });
    }
    res.json({ success: true, message: 'Cupón eliminado exitosamente.' });
  } catch (err) {
    console.error('Error deleting admin coupon:', err);
    res.status(500).json({ error: 'Error al eliminar el cupón.' });
  }
});

// GET Debug SMTP Connection and Email Sending
app.get('/api/debug/test-email', async (req, res) => {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  
  if (!host || !user || !pass) {
    return res.json({ 
      error: 'Missing SMTP credentials on the server.',
      SMTP_HOST: host || 'MISSING',
      SMTP_USER: user || 'MISSING',
      SMTP_PASS: pass ? 'CONFIGURED (NOT EMPTY)' : 'MISSING'
    });
  }
  
  try {
    if (!mailTransporter) {
      return res.status(500).json({ error: 'mailTransporter is not initialized.' });
    }
    
    console.log('[Debug Email] Verifying transporter...');
    await mailTransporter.verify();
    
    console.log('[Debug Email] Sending test email...');
    const info = await mailTransporter.sendMail({
      from: '"B R V N" <noreply@brvn.com.mx>',
      to: 'mrtinezbrandon@gmail.com',
      subject: 'Debug Email - B R V N',
      text: 'This is a test debug email from production.'
    });
    
    res.json({
      success: true,
      message: 'SMTP connection and email sending were successful!',
      messageId: info.messageId
    });
  } catch (err) {
    console.error('[Debug Email Error]:', err);
    res.status(500).json({
      success: false,
      error: err.message,
      stack: err.stack,
      code: err.code,
      command: err.command
    });
  }
});

// Function to run the hourly sync of all catalog sources
async function runHourlySync() {
  console.log('\n=== Hourly Background Sync Started ===');
  try {
    const sources = await dbQuery.all("SELECT * FROM catalog_sources");
    console.log(`Found ${sources.length} active catalog sources to sync.`);
    for (const source of sources) {
      console.log(`Syncing source: ${source.url} (limit: ${source.products_limit}, category: ${source.category})`);
      try {
        const savedCount = await runScraper(source.url, source.products_limit, source.category || 'General');
        console.log(`Successfully synced ${savedCount} products for source ID ${source.id}`);
      } catch (scrapeErr) {
        console.error(`Scraper error for source ID ${source.id}:`, scrapeErr.message);
      }
    }
  } catch (err) {
    console.error('Error running hourly background sync:', err.message);
  }
  console.log('=== Hourly Background Sync Completed ===\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// PRICE COMPARATOR ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/price-comparison/run — Lanza comparación masiva en background
app.post('/api/admin/price-comparison/run', authenticateAdmin, (req, res) => {
  const state = getComparisonState();
  if (state.running) {
    return res.json({ success: false, message: 'Ya hay una comparación en curso.', state });
  }
  // Lanzar en background sin bloquear la respuesta
  runBulkComparison().catch(err => {
    console.error('[API] Error en runBulkComparison:', err.message);
  });
  res.json({ success: true, message: 'Comparación iniciada en background.' });
});

// GET /api/admin/price-comparison/status — Estado en tiempo real del proceso
app.get('/api/admin/price-comparison/status', authenticateAdmin, (req, res) => {
  res.json(getComparisonState());
});

// GET /api/admin/price-comparison/pending — Productos en cola de revisión manual
app.get('/api/admin/price-comparison/pending', authenticateAdmin, async (req, res) => {
  try {
    const pending = await dbQuery.all(`
      SELECT
        p.id, p.sku, p.title, p.brand, p.gender, p.supplier_price,
        p.ps_public_price, p.images, p.specifications,
        pc.brvn_price, pc.ml_price, pc.ml_url, pc.ml_title,
        pc.compared_at, pc.rejection_reason,
        pc.id AS comparison_id
      FROM products p
      LEFT JOIN price_comparisons pc ON pc.product_id = p.id AND pc.status = 'pending_review'
      WHERE p.comparison_status = 'pending_review'
      ORDER BY pc.compared_at DESC
    `);

    const enriched = pending.map(p => ({
      ...p,
      brvn_suggested: calculateBRVNPrice(p.supplier_price, 200),
      brvn_min: calculateBRVNPrice(p.supplier_price, 150),
      ps_margin: p.ps_public_price ? Math.round(p.ps_public_price - p.supplier_price) : null,
      images: (() => { try { return JSON.parse(p.images); } catch { return []; } })()
    }));

    res.json({ success: true, total: enriched.length, items: enriched });
  } catch (err) {
    console.error('[API] Error cargando revisión manual:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/admin/price-comparison/results — Historial completo de comparaciones
app.get('/api/admin/price-comparison/results', authenticateAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const status = req.query.status || null;

    let sql = `
      SELECT
        pc.id, pc.sku, pc.brvn_price, pc.ml_price, pc.ml_url, pc.ml_title,
        pc.status, pc.rejection_reason, pc.compared_at, pc.published_at,
        p.title, p.brand, p.gender, p.supplier_price, p.images
      FROM price_comparisons pc
      LEFT JOIN products p ON p.id = pc.product_id
    `;
    const params = [];
    if (status) {
      sql += ' WHERE pc.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY pc.compared_at DESC LIMIT ?';
    params.push(limit);

    const results = await dbQuery.all(sql, params);
    res.json({ success: true, total: results.length, items: results });
  } catch (err) {
    console.error('[API] Error cargando historial:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/price-comparison/approve/:id — Aprueba y publica producto manual
app.post('/api/admin/price-comparison/approve/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { price } = req.body;
    const result = await approveManualProduct(id, price ? parseFloat(price) : null);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[API] Error aprobando producto:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/admin/price-comparison/reject/:id — Rechaza producto de la cola manual
app.post('/api/admin/price-comparison/reject/:id', authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    const result = await rejectManualProduct(id, reason);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[API] Error rechazando producto:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Schedule hourly sync only if not running on Vercel
if (!process.env.VERCEL) {
  // Automatic sync on localhost has been disabled to avoid high CPU/memory usage and overlapping runs.
  // You can still trigger the sync manually from the admin panel.
  // If you want to enable automatic intervals in the future, uncomment the lines below:
  // setInterval(runHourlySync, 3600000); // 1 hour in ms
  // setTimeout(runHourlySync, 5000);

  // Start server
  app.listen(PORT, () => {
    console.log(`PAPS store server running securely at http://localhost:${PORT}`);
  });
}

// Export the Express app for Vercel Serverless Functions
module.exports = app;