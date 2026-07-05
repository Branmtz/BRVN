const { createClient } = require('@libsql/client');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const dbPath = path.resolve(__dirname, 'paps_store.db');
const dbUrl = process.env.DATABASE_URL || `file:${dbPath}`;
const authToken = process.env.DATABASE_AUTH_TOKEN || '';

// Local replica file used when connecting to a remote Turso database.
// Reads are served from this local SQLite file (near-zero latency) while
// writes go to the remote and get pulled back down on each sync interval.
const localReplicaPath = path.resolve(__dirname, 'local-replica.db');
const isRemote = !dbUrl.startsWith('file:');

console.log('Initializing database client...');
console.log('Database URL:', dbUrl.startsWith('file:') ? dbUrl : dbUrl.split('@')[dbUrl.split('@').length - 1]);
console.log(isRemote ? 'Using embedded replica (local reads, synced writes).' : 'Using local file database.');

const client = isRemote
  ? createClient({
      url: `file:${localReplicaPath}`,
      syncUrl: dbUrl,
      authToken: authToken,
      syncInterval: 60 // seconds between automatic background syncs
    })
  : createClient({
      url: dbUrl,
      authToken: authToken
    });

// For remote setups, do an initial blocking sync on boot so the very first
// requests aren't served from a stale/empty local replica.
async function ensureInitialSync() {
  if (isRemote && typeof client.sync === 'function') {
    try {
      console.log('Performing initial Turso replica sync...');
      await client.sync();
      console.log('Initial Turso replica sync complete.');
    } catch (err) {
      console.error('Initial replica sync failed:', err.message);
    }
  }
}

// Polyfill dbQuery to match sqlite3 helper behavior
const dbQuery = {
  async run(sql, params = []) {
    try {
      const result = await client.execute({ sql, args: params });
      return {
        lastID: result.lastInsertRowid !== undefined ? Number(result.lastInsertRowid) : undefined,
        changes: result.rowsAffected
      };
    } catch (err) {
      throw err;
    }
  },
  async get(sql, params = []) {
    try {
      const result = await client.execute({ sql, args: params });
      return result.rows[0]; // will be undefined if no rows
    } catch (err) {
      throw err;
    }
  },
  async all(sql, params = []) {
    try {
      const result = await client.execute({ sql, args: params });
      return result.rows;
    } catch (err) {
      throw err;
    }
  }
};

// Polyfill db object to prevent crashes if external modules call db.run/get/all/close
const db = {
  run(sql, params, cb) {
    dbQuery.run(sql, params).then(res => cb && cb(null, res)).catch(err => cb && cb(err));
  },
  get(sql, params, cb) {
    dbQuery.get(sql, params).then(res => cb && cb(null, res)).catch(err => cb && cb(err));
  },
  all(sql, params, cb) {
    dbQuery.all(sql, params).then(res => cb && cb(null, res)).catch(err => cb && cb(err));
  },
  close(callback) {
    try {
      if (client && typeof client.close === 'function') {
        client.close();
      }
    } catch (err) {
      console.error('Error closing client:', err.message);
    }
    if (callback) callback();
  }
};

// Initialize connection and tables
initializeDatabase();

// SQL expression that decides whether a product counts as "tenis" under the
// current business rules. Kept as a single source of truth so it can be used
// both in the one-time backfill and in the triggers that keep it up to date.
const IS_TENIS_EXPR = `
  CASE WHEN (
    (
      UPPER(title) LIKE '%TENIS%'
      OR UPPER(title) LIKE '%SPORT%'
      OR UPPER(specifications) LIKE '%"subcategor\u00eda":"correr"%'
      OR UPPER(specifications) LIKE '%"subcategor\u00eda":"skate"%'
      OR UPPER(specifications) LIKE '%"subcategor\u00eda":"futbol"%'
      OR UPPER(specifications) LIKE '%"subcategor\u00eda":"entrenamiento"%'
      OR UPPER(specifications) LIKE '%"subcategor\u00eda":"basketball"%'
      OR UPPER(specifications) LIKE '%"subcategor\u00eda":"padel"%'
      OR UPPER(specifications) LIKE '%"subcategor\u00eda":"caminar"%'
    )
    AND NOT (
      (
        UPPER(title) LIKE '%MOCASIN%'
        OR UPPER(title) LIKE '%MOCAS\u00cdN%'
        OR UPPER(brand) IN ('SHOSH','MANET')
        OR UPPER(specifications) LIKE '%"subcategor\u00eda":"choclo"%'
      )
      AND UPPER(title) NOT LIKE '%TENIS%'
      AND UPPER(title) NOT LIKE '%SPORT%'
    )
  ) THEN 1 ELSE 0 END
`;

async function initializeDatabase() {
  try {
    await ensureInitialSync();

    // Enable WAL mode and busy timeout for better write performance and concurrency (local files only)
    if (dbUrl.startsWith('file:')) {
      try {
        await dbQuery.run('PRAGMA journal_mode = WAL');
        await dbQuery.run('PRAGMA busy_timeout = 10000');
      } catch (err) {
        console.warn('Could not configure SQLite PRAGMAs:', err.message);
      }
    }

    // 1. Create Products Table
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        sku TEXT UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        price REAL,
        supplier_price REAL,
        images TEXT, -- JSON array of image URLs
        sizes TEXT,  -- JSON array of strings: ["23", "24", "25"]
        color TEXT,
        gender TEXT, -- 'Caballero', 'Dama', 'Niños', 'Unisex'
        origin TEXT CHECK(origin IN ('PAPS', 'priceshoes')) NOT NULL,
        original_url TEXT,
        stock INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
        category TEXT DEFAULT 'General',
        brand TEXT DEFAULT NULL,
        specifications TEXT DEFAULT NULL,
        sizes_stock TEXT DEFAULT NULL,
        is_bestseller INTEGER DEFAULT 0
      )
    `);
    console.log('Products table verified/created.');

    // Create Indexes for Products Table to optimize queries and searches
    await dbQuery.run("CREATE INDEX IF NOT EXISTS idx_products_status_bestseller_id ON products(status, is_bestseller DESC, id DESC)");
    await dbQuery.run("CREATE INDEX IF NOT EXISTS idx_products_category ON products(category)");
    await dbQuery.run("CREATE INDEX IF NOT EXISTS idx_products_gender ON products(gender)");
    await dbQuery.run("CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand)");

    // Migration: created_at so the sales-prediction model can know how long
    // a product has existed (needed to tell "genuinely no demand" apart from
    // "just added, no data yet"). NOTE: Turso's remote engine rejects
    // DEFAULT CURRENT_TIMESTAMP inside ALTER TABLE ADD COLUMN (this differs
    // from a plain local SQLite file, where it's silently accepted) - so the
    // column is added with no default, then backfilled explicitly in a
    // separate UPDATE. New inserts that don't set it will simply get NULL,
    // which is fine since the model doesn't require it to be present.
    try {
      await dbQuery.run("ALTER TABLE products ADD COLUMN created_at DATETIME");
      console.log('Migrated: created_at column added to products.');
    } catch (e) {
      // column likely already exists
    }
    try {
      await dbQuery.run("UPDATE products SET created_at = datetime('now') WHERE created_at IS NULL");
    } catch (e) {
      console.warn('Could not backfill created_at:', e.message);
    }

    // Migration: precomputed is_tenis flag so the "solo tenis" filter used on
    // almost every product-listing query no longer has to evaluate ~10 LIKE
    // '%...%' comparisons (unindexable) against every single row on every request.
    try {
      await dbQuery.run("ALTER TABLE products ADD COLUMN is_tenis INTEGER DEFAULT 0");
      console.log('Migrated: is_tenis column added to products.');
    } catch (e) {
      // column likely already exists
    }
    await dbQuery.run("CREATE INDEX IF NOT EXISTS idx_products_is_tenis ON products(status, is_tenis, is_bestseller DESC, id DESC)");

    // Backfill is_tenis for any row where it hasn't been computed yet.
    // Cheap no-op after the first run since we only touch rows that need it.
    try {
      const pending = await dbQuery.get(`SELECT COUNT(*) as cnt FROM products WHERE is_tenis IS NULL OR is_tenis = 0`);
      if (pending && pending.cnt > 0) {
        await dbQuery.run(`UPDATE products SET is_tenis = ${IS_TENIS_EXPR}`);
        console.log(`Backfilled is_tenis for products table.`);
      }
    } catch (err) {
      console.warn('Could not backfill is_tenis:', err.message);
    }

    // Triggers keep is_tenis correct automatically whenever a product is
    // inserted or its title/specifications/brand change (e.g. from the scraper).
    await dbQuery.run(`
      CREATE TRIGGER IF NOT EXISTS trg_products_is_tenis_insert
      AFTER INSERT ON products
      BEGIN
        UPDATE products SET is_tenis = ${IS_TENIS_EXPR} WHERE id = NEW.id;
      END;
    `);
    await dbQuery.run(`
      CREATE TRIGGER IF NOT EXISTS trg_products_is_tenis_update
      AFTER UPDATE OF title, specifications, brand ON products
      BEGIN
        UPDATE products SET is_tenis = ${IS_TENIS_EXPR} WHERE id = NEW.id;
      END;
    `);
    console.log('is_tenis column, index and triggers verified/created.');

    // Full-text search index for products. Replaces the old
    // "title LIKE ? OR brand LIKE ? OR sku LIKE ? OR description LIKE ?"
    // (leading-wildcard LIKE can never use an index -> full table scan on
    // every keystroke) with an indexed FTS5 lookup.
    await dbQuery.run(`
      CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
        id UNINDEXED,
        title,
        brand,
        sku,
        description,
        tokenize = 'unicode61 remove_diacritics 2'
      )
    `);

    const ftsCount = await dbQuery.get('SELECT COUNT(*) as cnt FROM products_fts');
    if (!ftsCount || ftsCount.cnt === 0) {
      await dbQuery.run(`
        INSERT INTO products_fts (id, title, brand, sku, description)
        SELECT id, title, brand, sku, description FROM products
      `);
      console.log('products_fts populated from existing products.');
    }

    await dbQuery.run(`
      CREATE TRIGGER IF NOT EXISTS trg_products_fts_insert
      AFTER INSERT ON products
      BEGIN
        INSERT INTO products_fts (id, title, brand, sku, description)
        VALUES (NEW.id, NEW.title, NEW.brand, NEW.sku, NEW.description);
      END;
    `);
    await dbQuery.run(`
      CREATE TRIGGER IF NOT EXISTS trg_products_fts_update
      AFTER UPDATE OF title, brand, sku, description ON products
      BEGIN
        DELETE FROM products_fts WHERE id = OLD.id;
        INSERT INTO products_fts (id, title, brand, sku, description)
        VALUES (NEW.id, NEW.title, NEW.brand, NEW.sku, NEW.description);
      END;
    `);
    await dbQuery.run(`
      CREATE TRIGGER IF NOT EXISTS trg_products_fts_delete
      AFTER DELETE ON products
      BEGIN
        DELETE FROM products_fts WHERE id = OLD.id;
      END;
    `);
    console.log('products_fts triggers verified/created.');
    console.log('Products table indexes verified/created.');

    // Migration for products table: add category if not present
    try {
      await dbQuery.run("ALTER TABLE products ADD COLUMN category TEXT DEFAULT 'General'");
      console.log('Migrated: category column added to products.');
    } catch (e) {
      // column likely already exists
    }

    // Migration for products table: add brand if not present
    try {
      await dbQuery.run("ALTER TABLE products ADD COLUMN brand TEXT DEFAULT NULL");
      console.log('Migrated: brand column added to products.');
    } catch (e) {
      // column likely already exists
    }

    // Migration for products table: add specifications if not present
    try {
      await dbQuery.run("ALTER TABLE products ADD COLUMN specifications TEXT DEFAULT NULL");
      console.log('Migrated: specifications column added to products.');
    } catch (e) {
      // column likely already exists
    }

    // Migration for products table: add sizes_stock if not present
    try {
      await dbQuery.run("ALTER TABLE products ADD COLUMN sizes_stock TEXT DEFAULT NULL");
      console.log('Migrated: sizes_stock column added to products.');
    } catch (e) {
      // column likely already exists
    }

    // Migration for products table: add is_bestseller if not present
    try {
      await dbQuery.run("ALTER TABLE products ADD COLUMN is_bestseller INTEGER DEFAULT 0");
      console.log('Migrated: is_bestseller column added to products.');
    } catch (e) {
      // column likely already exists
    }

    // Migration: add comparison_status for price comparator
    try {
      await dbQuery.run("ALTER TABLE products ADD COLUMN comparison_status TEXT DEFAULT NULL");
      console.log('Migrated: comparison_status column added to products.');
    } catch (e) {
      // column likely already exists
    }

    // Migration: add ps_public_price (precio al público en Price Shoes)
    try {
      await dbQuery.run("ALTER TABLE products ADD COLUMN ps_public_price REAL DEFAULT NULL");
      console.log('Migrated: ps_public_price column added to products.');
    } catch (e) {
      // column likely already exists
    }

    // Create price_comparisons table
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS price_comparisons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        brvn_price REAL,
        ml_price REAL,
        ml_url TEXT,
        ml_title TEXT,
        status TEXT DEFAULT 'pending_review',
        rejection_reason TEXT,
        compared_at TEXT DEFAULT (datetime('now')),
        published_at TEXT,
        FOREIGN KEY (product_id) REFERENCES products(id)
      )
    `);
    console.log('price_comparisons table verified/created.');

    // Populate brand field for existing products if null
    try {
      const unpopulated = await dbQuery.all("SELECT id, title, origin FROM products WHERE brand IS NULL");
      if (unpopulated.length > 0) {
        console.log(`Found ${unpopulated.length} products with null brand column. Backfilling...`);
        for (const p of unpopulated) {
          let brand = 'Otros';
          if (p.origin === 'PAPS') {
            brand = 'PAPS';
          } else if (p.title && p.title.includes(' - ')) {
            brand = p.title.split(' - ')[0].trim();
          }
          await dbQuery.run("UPDATE products SET brand = ? WHERE id = ?", [brand, p.id]);
        }
        console.log('Successfully backfilled brand values.');
      }
    } catch (err) {
      console.error('Error backfilling brand values:', err.message);
    }

    // Migrate gender values 'Dama' -> 'Mujer' and 'Caballero' -> 'Hombre'
    try {
      const resultDama = await dbQuery.run("UPDATE products SET gender = 'Mujer' WHERE gender = 'Dama'");
      if (resultDama.changes > 0) {
        console.log(`Migrated ${resultDama.changes} products from gender 'Dama' to 'Mujer'.`);
      }
      const resultCaballero = await dbQuery.run("UPDATE products SET gender = 'Hombre' WHERE gender = 'Caballero'");
      if (resultCaballero.changes > 0) {
        console.log(`Migrated ${resultCaballero.changes} products from gender 'Caballero' to 'Hombre'.`);
      }
    } catch (e) {
      console.error('Error migrating gender values in DB:', e.message);
    }

    // 2. Create Orders Table
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, -- Folio format e.g. PAPS-1001
        customer_name TEXT NOT NULL,
        customer_email TEXT NOT NULL,
        customer_phone TEXT NOT NULL,
        shipping_address TEXT NOT NULL,
        items TEXT NOT NULL, -- JSON array of products: [{sku, title, size, color, price, qty}]
        total REAL NOT NULL,
        status TEXT CHECK(status IN ('pending', 'paid', 'purchased_on_supplier', 'shipped')) DEFAULT 'pending',
        mp_preference_id TEXT,
        mp_payment_id TEXT,
        tracking_number TEXT,
        shipping_carrier TEXT,
        tracking_status TEXT DEFAULT 'compra_realizada',
        shipping_cost REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Orders table verified/created.');

    // Migration for orders table: add tracking_status if not present
    try {
      await dbQuery.run("ALTER TABLE orders ADD COLUMN tracking_status TEXT DEFAULT 'compra_realizada'");
      console.log('Migrated: tracking_status column added to orders.');
    } catch (e) {
      // column likely already exists
    }

    // Migration for orders table: add shipping_cost if not present
    try {
      await dbQuery.run("ALTER TABLE orders ADD COLUMN shipping_cost REAL DEFAULT 0");
      console.log('Migrated: shipping_cost column added to orders.');
    } catch (e) {
      // column likely already exists
    }

    // 2.5. Create Shipments Table for LogiBoost Logistics Integration
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS shipments (
        tracking_number TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        carrier TEXT NOT NULL,
        service TEXT NOT NULL,
        cost REAL NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(order_id) REFERENCES orders(id)
      )
    `);
    console.log('Shipments table verified/created.');

    // 3. Create/Rename Admins and Users Tables
    let hasUsername = false;
    try {
      const tableInfo = await dbQuery.all("PRAGMA table_info(users)");
      hasUsername = tableInfo.some(col => col.name === 'username');
    } catch (e) {
      // Table doesn't exist yet
    }

    if (hasUsername) {
      try {
        await dbQuery.run("ALTER TABLE users RENAME TO admins");
        console.log('Renamed existing users table to admins.');
      } catch (renameErr) {
        console.error('Error renaming users table:', renameErr.message);
      }
    } else {
      await dbQuery.run(`
        CREATE TABLE IF NOT EXISTS admins (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL
        )
      `);
      console.log('Admins table verified/created.');
    }

    // Create the new users table (for customers)
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        apellido_pat TEXT NOT NULL,
        apellido_mat TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        telefono TEXT NOT NULL,
        password TEXT NOT NULL,
        verified INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('New users table verified/created.');

    // Create verification_codes table
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS verification_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        expires_at DATETIME NOT NULL,
        used INTEGER DEFAULT 0,
        attempts INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);
    console.log('Verification codes table verified/created.');

    // Create user_coupons table
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS user_coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        code TEXT NOT NULL,
        description TEXT,
        discount_percent REAL DEFAULT 0,
        used INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);
    console.log('User coupons table verified/created.');

    // Create global_coupons table
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS global_coupons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT UNIQUE NOT NULL,
        description TEXT,
        discount_type TEXT NOT NULL CHECK(discount_type IN ('percent', 'amount')),
        discount_value REAL NOT NULL,
        active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Global coupons table verified/created.');

    // 4. Create Catalog Sources Table (for Hourly Auto-Scraper)
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS catalog_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        products_limit INTEGER DEFAULT 30,
        category TEXT DEFAULT 'General',
        filter_keyword TEXT DEFAULT 'Tenis',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Catalog sources table verified/created.');

    // Migration for catalog_sources table: add category if not present
    try {
      await dbQuery.run("ALTER TABLE catalog_sources ADD COLUMN category TEXT DEFAULT 'General'");
      console.log('Migrated: category column added to catalog_sources.');
    } catch (e) {
      // column likely already exists
    }

    // Migration for catalog_sources table: add filter_keyword if not present
    try {
      await dbQuery.run("ALTER TABLE catalog_sources ADD COLUMN filter_keyword TEXT DEFAULT 'Tenis'");
      console.log('Migrated: filter_keyword column added to catalog_sources.');
    } catch (e) {
      // column likely already exists
    }

    // 5. Create Customers Table for Customer Accounts
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        phone TEXT,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Customers table verified/created.');

    // 6. Create Favorites Table (Saved items)
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS favorites (
        customer_id INTEGER NOT NULL,
        product_id TEXT NOT NULL,
        PRIMARY KEY (customer_id, product_id),
        FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
      )
    `);
    console.log('Favorites table verified/created.');

    // 7. Create Ratings Table (Calificaciones)
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        product_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        rating INTEGER CHECK(rating >= 1 AND rating <= 5),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(customer_id, product_id, order_id),
        FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
        FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
      )
    `);
    console.log('Ratings table verified/created.');

    // Migration for favorites and ratings: check if they point to customers and migrate to users
    try {
      const favoritesFkList = await dbQuery.all("PRAGMA foreign_key_list(favorites)");
      const pointsToCustomers = favoritesFkList.some(fk => fk.table === 'customers');
      if (pointsToCustomers) {
        console.log('Migrating favorites table: changing foreign key from customers to users...');
        await dbQuery.run("ALTER TABLE favorites RENAME TO favorites_old");
        await dbQuery.run(`
          CREATE TABLE favorites (
            customer_id INTEGER NOT NULL,
            product_id TEXT NOT NULL,
            PRIMARY KEY (customer_id, product_id),
            FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
          )
        `);
        try {
          await dbQuery.run("INSERT OR IGNORE INTO favorites (customer_id, product_id) SELECT CAST(customer_id AS INTEGER), product_id FROM favorites_old");
          await dbQuery.run("DROP TABLE favorites_old");
          console.log('Favorites table successfully migrated.');
        } catch (copyErr) {
          console.error('Error copying favorites data during migration:', copyErr.message);
        }
      }
    } catch (err) {
      console.warn('Could not check or migrate favorites foreign key:', err.message);
    }

    try {
      const ratingsFkList = await dbQuery.all("PRAGMA foreign_key_list(ratings)");
      const ratingsPointsToCustomers = ratingsFkList.some(fk => fk.table === 'customers');
      if (ratingsPointsToCustomers) {
        console.log('Migrating ratings table: changing foreign key from customers to users...');
        await dbQuery.run("ALTER TABLE ratings RENAME TO ratings_old");
        await dbQuery.run(`
          CREATE TABLE ratings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            customer_id INTEGER NOT NULL,
            product_id TEXT NOT NULL,
            order_id TEXT NOT NULL,
            rating INTEGER CHECK(rating >= 1 AND rating <= 5),
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(customer_id, product_id, order_id),
            FOREIGN KEY (customer_id) REFERENCES users(id) ON DELETE CASCADE,
            FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
            FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
          )
        `);
        try {
          await dbQuery.run(`
            INSERT OR IGNORE INTO ratings (id, customer_id, product_id, order_id, rating, created_at)
            SELECT id, CAST(customer_id AS INTEGER), product_id, order_id, rating, created_at FROM ratings_old
          `);
          await dbQuery.run("DROP TABLE ratings_old");
          console.log('Ratings table successfully migrated.');
        } catch (copyErr) {
          console.error('Error copying ratings data during migration:', copyErr.message);
        }
      }
    } catch (err) {
      console.warn('Could not check or migrate ratings foreign key:', err.message);
    }

    // Migration for orders table: add customer_id if not present
    try {
      await dbQuery.run("ALTER TABLE orders ADD COLUMN customer_id TEXT DEFAULT NULL");
      console.log('Migrated: customer_id column added to orders.');
    } catch (e) {
      // column likely already exists
    }

    // Product funnel events: vistas, click en talla/color, agregado a carrito.
    // La compra ya se puede derivar de la tabla `orders`, no se duplica aquí.
    // session_id es un identificador anónimo generado en el navegador
    // (localStorage), no requiere que el visitante esté registrado.
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS product_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        product_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        size TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await dbQuery.run("CREATE INDEX IF NOT EXISTS idx_product_events_product_type ON product_events(product_id, event_type)");
    await dbQuery.run("CREATE INDEX IF NOT EXISTS idx_product_events_session ON product_events(session_id, product_id, event_type)");
    await dbQuery.run("CREATE INDEX IF NOT EXISTS idx_product_events_created_at ON product_events(created_at)");
    console.log('product_events table and indexes verified/created.');
    try {
      await dbQuery.run("ALTER TABLE orders ADD COLUMN coupon_code TEXT DEFAULT NULL");
      console.log('Migrated: coupon_code column added to orders.');
    } catch (e) {
      // column likely already exists
    }

    // Migration for orders table: flag orders where live stock could not be
    // verified at checkout time (Playwright/scraper failure) so an admin can
    // manually confirm availability with the supplier before shipping,
    // instead of silently assuming stock either way.
    try {
      await dbQuery.run("ALTER TABLE orders ADD COLUMN stock_review_needed INTEGER DEFAULT 0");
      console.log('Migrated: stock_review_needed column added to orders.');
    } catch (e) {
      // column likely already exists
    }
    try {
      await dbQuery.run("ALTER TABLE orders ADD COLUMN stock_review_notes TEXT DEFAULT NULL");
      console.log('Migrated: stock_review_notes column added to orders.');
    } catch (e) {
      // column likely already exists
    }


    // No longer seeding the test product 'test-gratis' as requested.


    // Seed Default Admin User if empty
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'adminpaps123';
    
    const existingAdmin = await dbQuery.get('SELECT * FROM admins WHERE username = ?', [adminUser]);
    if (!existingAdmin) {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(adminPass, salt);
      const adminId = 'admin-' + Math.random().toString(36).substring(2, 11);
      
      await dbQuery.run('INSERT INTO admins (id, username, password_hash) VALUES (?, ?, ?)', [
        adminId,
        adminUser,
        hash
      ]);
      console.log(`Default admin user seeded: username="${adminUser}", password="${adminPass}"`);
    } else {
      console.log('Admin user already exists.');
    }

    // 8. Create Announcements Table
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Announcements table verified/created.');

    // Seed default announcements if table is empty
    try {
      const countRes = await dbQuery.get("SELECT COUNT(*) as count FROM announcements");
      if (countRes && countRes.count === 0) {
        const defaults = [
          "🎁 ¡Regalo en tu Primera Compra, ¡Regístrate ahora! 🎁",
          "💳 Compra a MSI con Mercado Pago",
          "🚚 Envío Gratis en pedidos mayores a $1,499 MXN"
        ];
        for (const text of defaults) {
          await dbQuery.run("INSERT INTO announcements (text) VALUES (?)", [text]);
        }
        console.log("Default announcements table seeded.");
      }
    } catch (err) {
      console.error("Error seeding announcements:", err.message);
    }

  } catch (error) {
    console.error('Error initializing database tables:', error);
  }
}

module.exports = {
  db,
  dbQuery
};