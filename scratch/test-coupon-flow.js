require('dotenv').config();
const jwt = require('jsonwebtoken');
const { dbQuery } = require('../database');

const CUSTOMER_JWT_SECRET = process.env.CUSTOMER_JWT_SECRET || 'paps_customer_jwt_secret_key_2026';

async function testCouponFlow() {
  console.log("=== STARTING COUPON FLOW INTEGRATION TEST ===");
  const testUserId = 16; // User 'Brandon'
  const couponCode = 'TESTCOUPON';
  
  try {
    // Generate valid JWT token for the user
    const token = jwt.sign({ id: testUserId, email: 'mrtinezbrandon@gmail.com', name: 'Brandon' }, CUSTOMER_JWT_SECRET, { expiresIn: '30d' });
    console.log("Generated test customer JWT token.");

    // 1. Reset coupon and order state for the test
    await dbQuery.run("DELETE FROM user_coupons WHERE user_id = ? AND LOWER(code) = ?", [testUserId, couponCode.toLowerCase()]);
    
    // Insert a fresh coupon
    await dbQuery.run(`
      INSERT INTO user_coupons (user_id, code, description, discount_percent, used)
      VALUES (?, ?, ?, ?, 0)
    `, [testUserId, couponCode, 'Cupón de prueba del 20%', 20]);
    console.log("1. Inserted coupon TESTCOUPON with 20% discount.");

    // 2. Validate coupon via API
    console.log("\n2. Validating coupon via API...");
    const validateRes = await fetch('http://localhost:3000/api/coupons/validate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ code: couponCode })
    });
    
    const validateData = await validateRes.json();
    console.log("Validation response:", validateData);
    if (!validateRes.ok || !validateData.success) {
      throw new Error(`Coupon validation failed: ${validateData.error}`);
    }

    // 3. Perform Checkout via API
    console.log("\n3. Performing checkout via API...");
    // Let's retrieve test product price
    const product = await dbQuery.get("SELECT * FROM products WHERE id = 'test-gratis'");
    
    // We update supplier_price of 'test-gratis' to 100 for predictable calculation,
    // and ensure sizes, stock, and origin are set so that checkout doesn't fail.
    const originalProduct = await dbQuery.get("SELECT * FROM products WHERE id = 'test-gratis'");
    await dbQuery.run("UPDATE products SET supplier_price = 100, sizes = ?, stock = 100, origin = 'PAPS' WHERE id = 'test-gratis'", [JSON.stringify(['24'])]);
    
    // Calculate the expected unit price
    // Since calculatePrice depends on the current hour:
    const hour = new Date().getHours();
    const isNight = hour >= 0 && hour < 5;
    const surcharge = isNight ? 300 : 500;
    const unitPrice = 100 + surcharge; // 400 or 600
    
    // Let's buy 2 units of test-gratis
    const qty = 2;
    const subtotal = unitPrice * qty;
    const discountAmount = subtotal * 0.20;
    const discountedSubtotal = subtotal - discountAmount;
    
    // Shipping carrier standard will cotizar live rate or flat $150
    console.log(`Expected Unit Price: $${unitPrice}, Qty: ${qty}, Subtotal: $${subtotal}`);
    console.log(`Expected Discount (20%): $${discountAmount}, Discounted Subtotal: $${discountedSubtotal}`);

    const checkoutRes = await fetch('http://localhost:3000/api/checkout', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        customerName: 'Brandon Martinez',
        customerEmail: 'mrtinezbrandon@gmail.com',
        customerPhone: '5545598011',
        shippingAddress: 'Calle Falsa 123, Colonia Centro, C.P. 06600, CDMX, Cerca del metro',
        shippingCarrier: 'Envío Estándar',
        items: [{ id: 'test-gratis', size: '24', qty }],
        couponCode: couponCode
      })
    });

    const checkoutData = await checkoutRes.json();
    console.log("Checkout response:", checkoutData);
    if (!checkoutRes.ok || !checkoutData.folio) {
      throw new Error(`Checkout failed: ${checkoutData.error}`);
    }
    
    const folio = checkoutData.folio;

    // 4. Verify checkout order in DB
    console.log("\n4. Checking order in database...");
    const order = await dbQuery.get("SELECT * FROM orders WHERE id = ?", [folio]);
    console.log("DB Order details:", {
      id: order.id,
      total: order.total,
      status: order.status,
      coupon_code: order.coupon_code,
      customer_id: order.customer_id
    });
    
    const actualShippingCost = order.total - discountedSubtotal;
    console.log(`Actual shipping cost calculated: $${actualShippingCost}`);
    
    if (actualShippingCost <= 0) {
      throw new Error(`Invalid shipping cost! Expected positive shipping, got: ${actualShippingCost}`);
    }
    if (order.coupon_code !== couponCode) {
      throw new Error(`Order coupon_code mismatch! Expected: ${couponCode}, Got: ${order.coupon_code}`);
    }
    if (order.status !== 'pending') {
      throw new Error(`Order status mismatch! Expected: pending, Got: ${order.status}`);
    }

    // 5. Simulate Payment Success via API
    console.log("\n5. Simulating payment success via API...");
    const payRes = await fetch('http://localhost:3000/api/checkout/simulate-payment', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ folio })
    });
    
    const payData = await payRes.json();
    console.log("Payment response:", payData);
    if (!payRes.ok || !payData.success) {
      throw new Error(`Payment simulation failed: ${payData.error}`);
    }

    // 6. Verify coupon deletion in DB
    console.log("\n6. Checking if coupon was deleted from DB...");
    const dbCouponAfter = await dbQuery.get("SELECT * FROM user_coupons WHERE user_id = ? AND LOWER(code) = ?", [testUserId, couponCode.toLowerCase()]);
    console.log("Coupon in DB after payment success (should be undefined):", dbCouponAfter);
    
    if (dbCouponAfter) {
      throw new Error("Coupon was not deleted from database after successful payment!");
    }
    
    console.log("\n=== INTEGRATION TEST PASSED SUCCESSFULLY! ===");
    
    // Clean up: Reset test-gratis back to original values
    if (originalProduct) {
      await dbQuery.run(`
        UPDATE products 
        SET supplier_price = ?, sizes = ?, stock = ?, origin = ? 
        WHERE id = 'test-gratis'
      `, [originalProduct.supplier_price, originalProduct.sizes, originalProduct.stock, originalProduct.origin]);
    } else {
      await dbQuery.run("UPDATE products SET supplier_price = 0 WHERE id = 'test-gratis'");
    }
    
  } catch (err) {
    console.error("\n=== INTEGRATION TEST FAILED! ===");
    console.error(err.message);
    // Clean up on failure
    await dbQuery.run("UPDATE products SET supplier_price = 0 WHERE id = 'test-gratis'");
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

testCouponFlow();
