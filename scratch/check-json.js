const { dbQuery } = require('../database');

async function run() {
  try {
    const products = await dbQuery.all("SELECT id, sku, title, images, sizes FROM products WHERE status = 'active'");
    console.log(`Total active products: ${products.length}`);
    
    let badImagesCount = 0;
    let badSizesCount = 0;
    
    products.forEach(p => {
      try {
        JSON.parse(p.images || '[]');
      } catch (e) {
        console.error(`Malformed images JSON for product ID ${p.id} (${p.title}):`, p.images);
        badImagesCount++;
      }
      
      try {
        JSON.parse(p.sizes || '[]');
      } catch (e) {
        console.error(`Malformed sizes JSON for product ID ${p.id} (${p.title}):`, p.sizes);
        badSizesCount++;
      }
    });
    
    console.log(`Malformed images: ${badImagesCount}`);
    console.log(`Malformed sizes: ${badSizesCount}`);
  } catch (err) {
    console.error('Check failed:', err);
  }
}

run();
