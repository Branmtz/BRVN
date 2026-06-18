const { createClient } = require('@libsql/client');
const path = require('path');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const dbPath = path.resolve(__dirname, 'paps_store.db');
const dbUrl = process.env.DATABASE_URL || `file:${dbPath}`;
const authToken = process.env.DATABASE_AUTH_TOKEN || '';

console.log('Initializing database client...');
console.log('Database URL:', dbUrl.startsWith('file:') ? dbUrl : dbUrl.split('@')[dbUrl.split('@').length - 1]);

const client = createClient({
  url: dbUrl,
  authToken: authToken
});

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

async function initializeDatabase() {
  try {
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

    // 4. Create Catalog Sources Table (for Hourly Auto-Scraper)
    await dbQuery.run(`
      CREATE TABLE IF NOT EXISTS catalog_sources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        url TEXT UNIQUE NOT NULL,
        products_limit INTEGER DEFAULT 30,
        category TEXT DEFAULT 'General',
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

    // Migration for orders table: add coupon_code if not present
    try {
      await dbQuery.run("ALTER TABLE orders ADD COLUMN coupon_code TEXT DEFAULT NULL");
      console.log('Migrated: coupon_code column added to orders.');
    } catch (e) {
      // column likely already exists
    }

    // Seed Test Product with Price 0
    try {
      const testProduct = await dbQuery.get("SELECT * FROM products WHERE id = 'test-gratis'");
      if (!testProduct) {
        await dbQuery.run(`
          INSERT INTO products (id, sku, title, description, price, supplier_price, images, sizes, color, gender, origin, stock, status, category, brand)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          'test-gratis',
          'TEST-GRATIS-001',
          'Calzado de Prueba Gratis',
          'Calzado de prueba con precio de $0 MXN para verificar flujos de compra, historial y calificaciones sin costo.',
          0,
          0,
          JSON.stringify(['/logo.png']),
          JSON.stringify(['23', '24', '25', '26', '27', '28']),
          'Blanco',
          'Unisex',
          'PAPS',
          999,
          'active',
          'Pruebas',
          'PAPS'
        ]);
        console.log('Seeded test product with price 0.');
      }
    } catch (seedErr) {
      console.error('Error seeding test product:', seedErr.message);
    }

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

  } catch (error) {
    console.error('Error initializing database tables:', error);
  }
}

module.exports = {
  db,
  dbQuery
};
