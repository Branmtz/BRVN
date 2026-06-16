const { dbQuery } = require('../database');

async function run() {
  console.log("=== DB SCHEMA VERIFICATION ===");
  try {
    // 1. Check favorites table foreign keys
    console.log("\nChecking 'favorites' foreign keys:");
    const favoritesFks = await dbQuery.all("PRAGMA foreign_key_list(favorites)");
    console.log(JSON.stringify(favoritesFks, null, 2));
    
    const favoritesPointsToUsers = favoritesFks.some(fk => fk.table === 'users');
    console.log(`Pointing to 'users'? ${favoritesPointsToUsers ? 'YES' : 'NO'}`);

    // 2. Check ratings table foreign keys
    console.log("\nChecking 'ratings' foreign keys:");
    const ratingsFks = await dbQuery.all("PRAGMA foreign_key_list(ratings)");
    console.log(JSON.stringify(ratingsFks, null, 2));
    
    const ratingsPointsToUsers = ratingsFks.some(fk => fk.table === 'users');
    console.log(`Pointing to 'users'? ${ratingsPointsToUsers ? 'YES' : 'NO'}`);

    // 3. Check orders table columns
    console.log("\nChecking 'orders' columns:");
    const ordersCols = await dbQuery.all("PRAGMA table_info(orders)");
    const hasCouponCode = ordersCols.some(col => col.name === 'coupon_code');
    console.log(`Has 'coupon_code' column? ${hasCouponCode ? 'YES' : 'NO'}`);
    if (hasCouponCode) {
      const colDetails = ordersCols.find(col => col.name === 'coupon_code');
      console.log(`Column details:`, colDetails);
    }
  } catch (err) {
    console.error("Verification failed:", err);
  } finally {
    process.exit(0);
  }
}

// Wait 1 second to let database initialize
setTimeout(run, 1000);
