async function run() {
  try {
    const promises = Array.from({ length: 30 }).map(async (_, idx) => {
      try {
        const start = Date.now();
        const res = await fetch('http://localhost:3000/api/products/trends');
        const duration = Date.now() - start;
        console.log(`Req ${idx}: Status = ${res.status}, Time = ${duration}ms`);
        if (res.status !== 200) {
          const text = await res.text();
          console.log(`Req ${idx} failed response:`, text);
        }
        return res.status;
      } catch (err) {
        console.error(`Req ${idx} fetch error:`, err.message);
        return 500;
      }
    });

    const results = await Promise.all(promises);
    const successCount = results.filter(s => s === 200).length;
    console.log(`Success: ${successCount}/30`);
  } catch (err) {
    console.error('Test error:', err);
  }
}

run();
