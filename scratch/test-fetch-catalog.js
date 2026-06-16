async function run() {
  try {
    const start = Date.now();
    const res = await fetch('http://localhost:3000/api/products');
    const duration = Date.now() - start;
    console.log(`Status: ${res.status}`);
    console.log(`Time: ${duration}ms`);
    const text = await res.text();
    console.log(`Response length: ${Math.round(text.length / 1024)} KB`);
    if (res.status === 200) {
      const data = JSON.parse(text);
      console.log(`Products count: ${data.length}`);
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

run();
