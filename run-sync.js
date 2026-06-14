const { dbQuery } = require('./database');
const { runScraper } = require('./scraper');

async function runSync() {
  console.log('\n=== CLI Background Sync Started ===');
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
    console.error('Error running background sync:', err.message);
    process.exit(1);
  }
  console.log('=== CLI Background Sync Completed ===\n');
  process.exit(0);
}

runSync();
