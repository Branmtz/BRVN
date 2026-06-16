let hoursChartInstance = null;
let genderChartInstance = null;

document.addEventListener('DOMContentLoaded', () => {
  checkAuth();
  initAnnouncementBanner();
  
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLoginSubmit);
  }
  
  const scraperForm = document.getElementById('scraper-form');
  if (scraperForm) {
    scraperForm.addEventListener('submit', handleScraperSubmit);
  }
});

// Rotating Announcement Banner
function initAnnouncementBanner() {
  const announcements = [
    "🎁 ¡DESCUENTO EN TU PRIMERA COMPRA! Código: MIPRIMERCOMPRA 🎁",
    "🚚 Envío Gratis en pedidos mayores a $1,499 MXN",
    "💳 Compra a MSI con Mercado Pago"
  ];
  const textEl = document.getElementById('announcement-text');
  if (!textEl) return;
  
  let index = 0;
  setInterval(() => {
    textEl.style.opacity = 0;
    setTimeout(() => {
      index = (index + 1) % announcements.length;
      textEl.textContent = announcements[index];
      textEl.style.opacity = 1;
    }, 500); // match transition duration
  }, 4000);
}

// Check JWT Token on load
function checkAuth() {
  const token = localStorage.getItem('paps_token');
  const loginBox = document.getElementById('login-container');
  const consoleBox = document.getElementById('console-container');
  const logoutContainer = document.getElementById('logout-container');
  
  if (token) {
    if (loginBox) loginBox.style.display = 'none';
    if (consoleBox) consoleBox.style.display = 'block';
    if (logoutContainer) logoutContainer.style.display = 'flex';
    
    // Load Admin Data
    loadDashboardData();
    loadOrdersTable();
    loadAbandonedTable();
    loadCatalogSources();
    loadCategories();
    loadReportsData();
    loadTrackingTable();
  } else {
    if (loginBox) loginBox.style.display = 'block';
    if (consoleBox) consoleBox.style.display = 'none';
    if (logoutContainer) logoutContainer.style.display = 'none';
  }
}

// Admin Login
async function handleLoginSubmit(e) {
  e.preventDefault();
  
  const username = document.getElementById('admin-user').value;
  const password = document.getElementById('admin-pass').value;
  
  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    const data = await res.json();
    if (res.ok && data.token) {
      localStorage.setItem('paps_token', data.token);
      checkAuth();
    } else {
      alert(data.error || 'Credenciales inválidas.');
    }
  } catch (err) {
    console.error(err);
    alert('Error al conectar con el servidor.');
  }
}

// Admin Logout
window.logoutAdmin = function() {
  localStorage.removeItem('paps_token');
  checkAuth();
};

// Switch Tabs
window.switchTab = function(sectionId, tabEl) {
  const sections = document.querySelectorAll('.admin-section');
  sections.forEach(s => s.classList.remove('active'));
  
  const tabs = document.querySelectorAll('.admin-tab');
  tabs.forEach(t => t.classList.remove('active'));
  
  document.getElementById(sectionId).classList.add('active');
  tabEl.classList.add('active');
  
  // Reload reports when switching to that tab
  if (sectionId === 'reports-section') {
    loadReportsData();
  } else if (sectionId === 'tracking-section') {
    loadTrackingTable();
  }
};

// Fetch Dashboard & Analytics Data
async function loadDashboardData() {
  const token = localStorage.getItem('paps_token');
  try {
    const res = await fetch('/api/admin/analytics', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!res.ok) throw new Error('Failed to fetch analytics');
    const data = await res.json();
    
    // Update metric cards
    document.getElementById('metrics-revenue').textContent = `$${(data.summary.revenue || 0).toLocaleString()} MXN`;
    document.getElementById('metrics-sales').textContent = data.summary.salesCount;
    document.getElementById('metrics-average').textContent = `$${(data.summary.ticketAverage || 0).toLocaleString()} MXN`;
    document.getElementById('metrics-conversion').textContent = data.summary.conversionRate;
    
    // Render Charts
    renderHoursChart(data.hours);
    renderGenderChart(data.gender);
    
  } catch (err) {
    console.error(err);
  }
}

// Render Sales by Hour Chart
function renderHoursChart(hoursData) {
  const ctx = document.getElementById('hoursChart').getContext('2d');
  
  // Initialize 24 hours template with 0 values
  const labels = Array.from({ length: 24 }, (_, i) => `${i.toString().padStart(2, '0')}:00`);
  const dataValues = Array(24).fill(0);
  
  hoursData.forEach(row => {
    const hr = parseInt(row.hour);
    if (!isNaN(hr) && hr >= 0 && hr < 24) {
      dataValues[hr] = row.count;
    }
  });
  
  if (hoursChartInstance) {
    hoursChartInstance.destroy();
  }
  
  hoursChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Pedidos Pagados',
        data: dataValues,
        backgroundColor: '#1d1d1f', // Apple gray
        borderWidth: 0,
        borderRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1 }
        }
      }
    }
  });
}

// Render Sales by Category Chart
function renderGenderChart(genderData) {
  const ctx = document.getElementById('genderChart').getContext('2d');
  
  const labels = Object.keys(genderData);
  const values = Object.values(genderData);
  
  if (genderChartInstance) {
    genderChartInstance.destroy();
  }
  
  genderChartInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [{
        data: values,
        backgroundColor: ['#1d1d1f', '#86868b', '#e5e5e5', '#a1a1a6'],
        borderWidth: 1,
        borderColor: '#fff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'right',
          labels: { boxWidth: 12 }
        }
      }
    }
  });
}

// Download CSV Report
window.downloadReport = async function() {
  const token = localStorage.getItem('paps_token');
  try {
    const res = await fetch('/api/admin/export-csv', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (res.ok) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'PAPS_Reporte_Ventas.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      alert('Error al descargar el reporte.');
    }
  } catch (err) {
    console.error(err);
  }
};

// Fetch and Render Orders Table
async function loadOrdersTable() {
  const token = localStorage.getItem('paps_token');
  const tbody = document.getElementById('orders-table-body');
  
  try {
    const res = await fetch('/api/admin/orders', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!res.ok) throw new Error('Failed to fetch orders');
    const orders = await res.json();
    
    if (orders.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--text-secondary); padding: 32px;">
            Aún no se han recibido pedidos en la tienda.
          </td>
        </tr>
      `;
      return;
    }
    
    tbody.innerHTML = orders.map(order => {
      // Format Items list
      const itemsHtml = order.items.map(item => `
        <div style="margin-bottom: 10px; font-size: 13px; line-height: 1.6;">
          • <strong style="font-size: 14px;">${item.title}</strong><br>
          <span style="font-size: 13px; font-weight: 700; color: #1d1d1f;">
            Talla: ${item.size} &nbsp;|&nbsp; Color: ${item.color} &nbsp;|&nbsp;
            <span style="color: #e0006b;">SKU: ${item.sku || 'N/A'}</span>
            &nbsp;|&nbsp; Cant: ${item.qty}
          </span>
        </div>
      `).join('');
      
      const date = new Date(order.created_at);
      const statusBadge = `<span class="badge ${order.status}">${
        order.status === 'pending' ? 'Pendiente' : 
        order.status === 'paid' ? 'Pagado' : 
        order.status === 'purchased_on_supplier' ? 'Comprado' : 'Enviado'
      }</span>`;
      
      const totalQty = order.items.reduce((sum, item) => sum + (item.qty || 1), 0);
      let actionHtml = '';
      if (order.status === 'paid') {
        // Option to go directly to Price Shoes link for manual dropshipping
        const priceShoesItems = order.items.filter(item => item.sku);
        let linkBtn = '';
        if (priceShoesItems.length > 0) {
          // Open the first item as a shortcut (since manual dropshipping goes item by item)
          const firstSku = priceShoesItems[0].sku;
          const buyUrl = `https://www.priceshoes.com/productos/${firstSku}`;
          linkBtn = `
            <a href="${buyUrl}" target="_blank" class="action-btn" style="background-color: #ff1493; display: inline-block; margin-bottom: 8px;">
              <i class="fa-solid fa-cart-shopping"></i> 👉 Comprar en Price Shoes
            </a><br>
          `;
        }
        
        // Go to tracking tab
        actionHtml = `
          ${linkBtn}
          <div style="border-top: 1px solid var(--border-color); padding-top: 8px; margin-top: 8px;">
            <button onclick="goToTrackingTab('${order.id}')" class="action-btn" style="background-color: #007aff; color: white; display: block; width: 100%; text-align: center; border-radius: 4px; padding: 6px 8px; font-size: 11px; font-weight: 600;">
              <i class="fa-solid fa-truck-fast"></i> Asignar Guía / Envío
            </button>
          </div>
        `;
      } else if (order.status === 'shipped') {
        const trackingStatusLabels = {
          compra_realizada: 'Compra Realizada',
          recolectado: 'Recolectado',
          centro_distribucion: 'En Centro de Dist.',
          en_ruta: 'En Ruta',
          entregado: 'Entregado'
        };
        const statusLabelText = trackingStatusLabels[order.tracking_status] || 'Enviado';
        actionHtml = `
          <div style="font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;">
            <strong>${order.shipping_carrier || 'Pendiente'}</strong><br>
            Guía: ${order.tracking_number || 'N/A'}<br>
            Est. Rastreo: <strong style="color:#007aff;">${statusLabelText}</strong>
          </div>
          <button onclick="goToTrackingTab('${order.id}')" class="action-btn" style="background-color: #8e8e93; color: white; display: inline-block; border-radius: 4px; padding: 4px 8px; font-size: 11px; font-weight: 600; text-align: center;">
            <i class="fa-solid fa-pen"></i> Editar Seguimiento
          </button>
        `;
      } else {
        actionHtml = `<span style="color: var(--text-secondary); font-size: 12px;">Sin acción</span>`;
      }
      
      return `
        <tr>
          <td><strong>${order.id}</strong><br><span style="font-size:11px; color:var(--text-secondary)">${date.toLocaleDateString()}</span></td>
          <td><strong>${order.customer_name}</strong></td>
          <td style="font-size:12px;">${order.customer_email}<br>${order.customer_phone}</td>
          <td>${itemsHtml}</td>
          <td><strong>$${order.total.toLocaleString()} MXN</strong></td>
          <td>${statusBadge}</td>
          <td>${actionHtml}</td>
        </tr>
      `;
    }).join('');
    
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="7" style="text-align: center; color: #ff3b30;">Error al cargar pedidos.</td></tr>`;
  }
}

// Mark order as shipped
window.shipOrder = async function(orderId) {
  const token = localStorage.getItem('paps_token');
  const carrier = document.getElementById(`carrier-${orderId}`).value.trim();
  const trackingNumber = document.getElementById(`guide-${orderId}`).value.trim();
  
  if (!carrier || !trackingNumber) {
    alert('Ingresa la paquetería y número de guía.');
    return;
  }
  
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/ship`, {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({ carrier, trackingNumber })
    });
    
    if (res.ok) {
      loadOrdersTable();
      loadDashboardData();
    } else {
      const data = await res.json();
      alert(data.error || 'Error al actualizar despacho.');
    }
  } catch (err) {
    console.error(err);
  }
};

// ─── REPORTS: Load Sales Report Data ─────────────────────────────────────────
async function loadReportsData() {
  const token = localStorage.getItem('paps_token');
  const tbody = document.getElementById('reports-table-body');
  if (!tbody) return;

  try {
    const res = await fetch('/api/admin/reports', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed');
    const data = await res.json();

    // Update summary cards
    document.getElementById('rpt-revenue').textContent = `$${data.summary.revenue.toLocaleString()} MXN`;
    document.getElementById('rpt-cost').textContent = `$${data.summary.cost.toLocaleString()} MXN`;
    const profitEl = document.getElementById('rpt-profit');
    profitEl.textContent = `$${data.summary.profit.toLocaleString()} MXN`;
    profitEl.style.color = data.summary.profit >= 0 ? '#007aff' : '#ff3b30';
    document.getElementById('rpt-margin').textContent = `${data.summary.margin}%`;

    if (data.orders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:var(--text-secondary);padding:32px;">No hay pedidos pagados aún.</td></tr>`;
      return;
    }

    tbody.innerHTML = data.orders.map(o => {
      const profit = o.revenue - o.cost;
      const margin = o.revenue > 0 ? ((profit / o.revenue) * 100).toFixed(1) : '0.0';
      const profitColor = profit >= 0 ? '#34c759' : '#ff3b30';
      const profitSign = profit >= 0 ? '+' : '';
      const marginColor = parseFloat(margin) >= 0 ? '#34c759' : '#ff3b30';

      const itemsHtml = o.items.map(item => `
        <div style="margin-bottom:6px; font-size:12px; line-height:1.5;">
          • <strong style="font-size:13px;">${item.title}</strong><br>
          <span style="display:inline-flex; gap:4px; flex-wrap:wrap; margin-top:3px;">
            <span style="background:#f0f0f5; color:#3a3a5c; font-size:10px; font-weight:600; padding:1px 7px; border-radius:20px;">👟 Talla ${item.size}</span>
            <span style="background:#fff3e0; color:#b35c00; font-size:10px; font-weight:600; padding:1px 7px; border-radius:20px;">🎨 ${item.color}</span>
            <span style="background:#fce4ec; color:#c0003c; font-size:10px; font-weight:700; padding:1px 7px; border-radius:20px;">SKU: ${item.sku || 'N/A'}</span>
          </span>
        </div>
      `).join('');

      const statusLabel = { pending: 'Pendiente', paid: 'Pagado', purchased_on_supplier: 'Comprado', shipped: 'Enviado' };
      const statusColors = { pending: '#ff9500', paid: '#34c759', purchased_on_supplier: '#007aff', shipped: '#8e8e93' };
      const statusBg    = { pending: '#fff3e0', paid: '#e8f5e9', purchased_on_supplier: '#e3f2fd', shipped: '#f5f5f7' };

      return `
        <tr>
          <td><strong>${o.id}</strong></td>
          <td style="font-size:12px;white-space:nowrap;">${new Date(o.created_at).toLocaleDateString('es-MX')}</td>
          <td>
            <strong>${o.customer_name}</strong><br>
            <span style="font-size:11px;color:var(--text-secondary);">${o.customer_email}</span>
          </td>
          <td>${itemsHtml}</td>
          <td style="text-align:right;font-weight:700;color:#1d1d1f;">$${o.revenue.toLocaleString()}</td>
          <td style="text-align:right;color:#ff9500;font-weight:600;">$${o.cost.toLocaleString()}</td>
          <td style="text-align:right;font-weight:700;color:${profitColor};">${profitSign}$${profit.toLocaleString()}</td>
          <td style="text-align:center;">
            <span style="background:${marginColor}22; color:${marginColor}; font-size:12px; font-weight:700; padding:2px 10px; border-radius:20px;">${profitSign}${margin}%</span>
          </td>
          <td style="text-align:center;">
            <span style="background:${statusBg[o.status]}; color:${statusColors[o.status]}; font-size:11px; font-weight:700; padding:2px 10px; border-radius:20px; white-space:nowrap;">${statusLabel[o.status] || o.status}</span>
          </td>
        </tr>
      `;
    }).join('');

  } catch (err) {
    console.error('Error loading reports:', err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="9" style="text-align:center;color:#ff3b30;padding:32px;">Error al cargar reportes.</td></tr>`;
  }
}

// Download Detailed CSV Report
window.downloadDetailedCSV = async function() {
  const token = localStorage.getItem('paps_token');
  try {
    const res = await fetch('/api/admin/reports/csv', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (res.ok) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'PAPS_Reporte_Financiero.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } else {
      alert('Error al descargar el reporte.');
    }
  } catch (err) {
    console.error(err);
  }
};

// Fetch and Render Abandoned Carts Table
async function loadAbandonedTable() {
  const token = localStorage.getItem('paps_token');
  const tbody = document.getElementById('abandoned-table-body');
  
  try {
    const res = await fetch('/api/admin/abandoned', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!res.ok) throw new Error('Failed to fetch abandoned carts');
    const carts = await res.json();
    
    if (carts.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 32px;">
            No hay carritos abandonados. ¡Excelente tasa de conversión!
          </td>
        </tr>
      `;
      return;
    }
    
    tbody.innerHTML = carts.map(cart => {
      const itemsHtml = cart.items.map(item => `
        <div style="font-size: 13px; margin-bottom: 4px;">
          • ${item.title} (Talla: ${item.size} | Qty: ${item.qty})
        </div>
      `).join('');
      
      const date = new Date(cart.created_at);
      
      return `
        <tr>
          <td><strong>${cart.id}</strong></td>
          <td><strong>${cart.customer_name}</strong></td>
          <td style="font-size:12px;">${cart.customer_email}<br>${cart.customer_phone}</td>
          <td>${itemsHtml}</td>
          <td><strong>$${cart.total.toLocaleString()} MXN</strong></td>
          <td style="font-size:12px;">${date.toLocaleDateString()} ${date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</td>
        </tr>
      `;
    }).join('');
    
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ff3b30;">Error al cargar carritos abandonados.</td></tr>`;
  }
}

// Scraper submission
async function handleScraperSubmit(e) {
  e.preventDefault();
  
  const token = localStorage.getItem('paps_token');
  const searchUrl = document.getElementById('scraper-url').value.trim();
  const limit = document.getElementById('scraper-products').value;
  const category = document.getElementById('scraper-category').value.trim() || 'General';
  
  const statusBox = document.getElementById('scraper-status-box');
  statusBox.style.display = 'block';
  
  try {
    const res = await fetch('/api/admin/scrape', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ searchUrl, limit, category })
    });
    
    if (res.ok) {
      alert('Sincronización iniciada en segundo plano con éxito.');
      document.getElementById('scraper-url').value = '';
      loadCatalogSources();
      loadCategories();
      // Hide status box after a short delay
      setTimeout(() => {
        statusBox.style.display = 'none';
      }, 5000);
    } else {
      const data = await res.json();
      alert(data.error || 'Error al iniciar sincronización.');
      statusBox.style.display = 'none';
    }
  } catch (err) {
    console.error(err);
    alert('Error al conectar con el servidor.');
    statusBox.style.display = 'none';
  }
}

// Fetch and Render Catalog Sources list
async function loadCatalogSources() {
  const token = localStorage.getItem('paps_token');
  const tbody = document.getElementById('catalog-sources-table-body');
  if (!tbody) return;
  
  try {
    const res = await fetch('/api/admin/catalog-sources', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (!res.ok) throw new Error('Failed to fetch catalog sources');
    const sources = await res.json();
    
    if (sources.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="4" style="text-align: center; color: var(--text-secondary); padding: 16px;">
            No hay fuentes de catálogo registradas para sincronización automática.
          </td>
        </tr>
      `;
      return;
    }
    
    tbody.innerHTML = sources.map(source => {
      // Shorten display URL if too long
      const displayUrl = source.url.length > 80 ? source.url.substring(0, 77) + '...' : source.url;
      return `
        <tr>
          <td>
            <a href="${source.url}" target="_blank" style="font-size: 13px; color: #1d1d1f; text-decoration: underline;" title="${source.url}">
              ${displayUrl}
            </a>
          </td>
          <td style="font-size: 13px;">${source.category || 'General'}</td>
          <td style="font-size: 13px; text-align: center; font-weight: 600;">${source.products_limit}</td>
          <td style="text-align: center;">
            <button onclick="deleteCatalogSource(${source.id})" class="action-btn" style="background-color: #ff3b30; color: white; padding: 4px 8px; font-size: 11px;">
              <i class="fa-solid fa-trash-can"></i> Eliminar
            </button>
          </td>
        </tr>
      `;
    }).join('');
    
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: #ff3b30; padding: 16px;">Error al cargar fuentes.</td></tr>`;
  }
}

// Delete Catalog Source
window.deleteCatalogSource = async function(id) {
  if (!confirm('¿Estás seguro de que deseas eliminar esta fuente de catálogo? Ya no se sincronizará automáticamente.')) {
    return;
  }
  
  const token = localStorage.getItem('paps_token');
  try {
    const res = await fetch(`/api/admin/catalog-sources/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    if (res.ok) {
      loadCatalogSources();
    } else {
      const data = await res.json();
      alert(data.error || 'Error al eliminar fuente.');
    }
  } catch (err) {
    console.error(err);
    alert('Error al conectar con el servidor.');
  }
};

// Fetch categories from /api/categories and populate scraper category datalist and categories manager table
async function loadCategories() {
  const token = localStorage.getItem('paps_token');
  try {
    // Fetch categories with product counts
    const [catRes, srcRes] = await Promise.all([
      fetch('/api/categories/detailed', { headers: { 'Authorization': `Bearer ${token}` } }),
      fetch('/api/admin/catalog-sources',  { headers: { 'Authorization': `Bearer ${token}` } })
    ]);

    const categories = catRes.ok ? await catRes.json() : [];
    const sources    = srcRes.ok ? await srcRes.json() : [];

    // Build a map: category -> count of catalog sources
    const sourceCountMap = {};
    sources.forEach(s => {
      const key = (s.category || 'General').trim().toLowerCase();
      sourceCountMap[key] = (sourceCountMap[key] || 0) + 1;
    });

    // Populate datalist for scraper input
    const datalist = document.getElementById('existing-categories');
    if (datalist) {
      datalist.innerHTML = categories.map(c => `<option value="${c.name}"></option>`).join('');
    }

    // Populate categories manager list
    const tbody = document.getElementById('categories-table-body');
    if (tbody) {
      if (categories.length === 0) {
        tbody.innerHTML = `
          <tr>
            <td colspan="3" style="text-align: center; color: var(--text-secondary); padding: 16px;">
              No hay categorías activas.
            </td>
          </tr>
        `;
        return;
      }

      tbody.innerHTML = categories.map(c => {
        const srcCount = sourceCountMap[c.name.trim().toLowerCase()] || 0;
        const srcBadge = srcCount > 0
          ? `<span style="background:#e3f2fd;color:#1565c0;font-size:10px;font-weight:700;padding:1px 7px;border-radius:20px;margin-left:6px;">🔄 ${srcCount} fuente${srcCount > 1 ? 's' : ''}</span>`
          : `<span style="background:#fce4ec;color:#c0003c;font-size:10px;font-weight:600;padding:1px 7px;border-radius:20px;margin-left:6px;">⚠️ Sin fuente</span>`;
        return `
          <tr>
            <td style="font-size: 14px; font-weight: 600; color: #1d1d1f;">
              ${c.name}
              ${srcBadge}
            </td>
            <td style="font-size: 12px; color: var(--text-secondary); text-align:center;">${c.count} productos</td>
            <td style="text-align: center;">
              <button onclick="deleteCategory('${c.name.replace(/'/g, "\\'")}')" class="action-btn" style="background-color: #ff3b30; color: white; padding: 4px 10px; font-size: 11px;">
                <i class="fa-solid fa-trash-can"></i> Eliminar
              </button>
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    console.error('Error loading categories:', err);
    const tbody = document.getElementById('categories-table-body');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: #ff3b30; padding: 16px;">Error al cargar categorías.</td></tr>`;
    }
  }
}

// Delete category and all associated products and sources
window.deleteCategory = async function(categoryName) {
  const confirmationMsg = `¿Eliminar permanentemente la categoría "${categoryName}" y TODOS sus productos y fuentes de catálogo?\n\nEsta acción no se puede deshacer.`;
  if (!confirm(confirmationMsg)) return;

  const token = localStorage.getItem('paps_token');
  try {
    const res = await fetch(`/api/admin/categories/${encodeURIComponent(categoryName)}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      const data = await res.json();
      const msg = `✅ Categoría "${categoryName}" eliminada.\n\n` +
        `• ${data.deletedProducts} productos eliminados\n` +
        `• ${data.deletedSources} fuentes de catálogo eliminadas\n\n` +
        (data.deletedSources === 0
          ? '⚠️ ADVERTENCIA: No se encontraron fuentes de catálogo con ese nombre exacto. Si la categoría reaparece, revisa la pestaña "Fuentes de Catálogo Activas" y elimina manualmente las fuentes relacionadas.'
          : 'La categoría no volverá a reaparecer en los sincronizados automáticos.');
      alert(msg);
      loadCategories();
      loadCatalogSources();
      loadDashboardData();
    } else {
      const data = await res.json();
      alert(data.error || 'Error al eliminar la categoría.');
    }
  } catch (err) {
    console.error(err);
    alert('Error al conectar con el servidor.');
  }
};

/* ─── TRACKING & LOGISTICS FLOW ─── */

function getCarrierTrackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return '#';
  const c = carrier.toUpperCase();
  if (c.includes('DHL')) {
    return `https://www.dhl.com/es-es/home/tracking/tracking-express.html?submit=1&tracking-id=${trackingNumber}`;
  } else if (c.includes('FEDEX')) {
    return `https://www.fedex.com/fedextrack/?trknbr=${trackingNumber}`;
  } else if (c.includes('ESTAFETA')) {
    return `https://www.estafeta.com/Herramientas/Rastreo`;
  } else {
    return `https://www.google.com/search?q=rastreo+${encodeURIComponent(carrier)}+${encodeURIComponent(trackingNumber)}`;
  }
}

// Fetch all active orders and load tracking details
window.loadTrackingTable = async function() {
  const token = localStorage.getItem('paps_token');
  const tbody = document.getElementById('tracking-table-body');
  if (!tbody) return;
  
  try {
    const res = await fetch('/api/admin/orders', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) throw new Error('Failed to fetch orders');
    const orders = await res.json();
    
    // Filter out pending (abandoned) orders
    const activeOrders = orders.filter(o => o.status !== 'pending');
    
    if (activeOrders.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-secondary); padding: 32px;">No hay pedidos activos para seguimiento.</td></tr>`;
      return;
    }
    
    tbody.innerHTML = activeOrders.map(order => {
      const carrierValue = order.shipping_carrier || '';
      const trackingNumberValue = order.tracking_number || '';
      const trackingStatusValue = order.tracking_status || 'compra_realizada';
      
      let linkHtml = '';
      if (trackingNumberValue && carrierValue) {
        const url = getCarrierTrackingUrl(carrierValue, trackingNumberValue);
        linkHtml = `
          <div style="margin-top: 6px;">
            <a href="${url}" target="_blank" style="font-size: 11px; color: #007aff; text-decoration: none; font-weight: 600;">
              <i class="fa-solid fa-arrow-up-right-from-square"></i> Probar enlace
            </a>
          </div>
        `;
      }
      
      return `
        <tr data-order-id="${order.id}">
          <td><strong>${order.id}</strong><br><span style="font-size:11px; color:var(--text-secondary)">${new Date(order.created_at).toLocaleDateString()}</span></td>
          <td><strong>${order.customer_name}</strong><br><span style="font-size:11px; color:var(--text-secondary)">${order.customer_phone}</span></td>
          <td>
            <input type="text" id="track-carrier-${order.id}" class="admin-input-small" placeholder="Ej. FedEx, DHL" value="${carrierValue}" style="width: 110px; padding: 6px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 13px;">
          </td>
          <td>
            <input type="text" id="track-number-${order.id}" class="admin-input-small" placeholder="Número de guía" value="${trackingNumberValue}" style="width: 140px; padding: 6px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 13px;">
            ${linkHtml}
          </td>
          <td>
            <select id="track-status-${order.id}" style="padding: 6px; border: 1px solid var(--border-color); border-radius: 4px; font-size: 13px; background-color: #fff; width: 185px;">
              <option value="compra_realizada" ${trackingStatusValue === 'compra_realizada' ? 'selected' : ''}>1. Compra realizada con éxito</option>
              <option value="recolectado" ${trackingStatusValue === 'recolectado' ? 'selected' : ''}>2. Recolectado por paquetería</option>
              <option value="centro_distribucion" ${trackingStatusValue === 'centro_distribucion' ? 'selected' : ''}>3. Llegada a centro dist.</option>
              <option value="en_ruta" ${trackingStatusValue === 'en_ruta' ? 'selected' : ''}>4. En ruta de entrega</option>
              <option value="entregado" ${trackingStatusValue === 'entregado' ? 'selected' : ''}>5. Entregado</option>
            </select>
          </td>
          <td style="text-align: center;">
            <button onclick="updateOrderTracking('${order.id}')" class="action-btn" style="background-color: #007aff; color: white; padding: 6px 12px; font-size: 12px; font-weight: 600; border-radius: 4px; border: none; cursor: pointer;">
              <i class="fa-solid fa-floppy-disk"></i> Guardar
            </button>
          </td>
        </tr>
      `;
    }).join('');
    
  } catch (err) {
    console.error(err);
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: #ff3b30; padding: 16px;">Error al cargar datos de seguimiento.</td></tr>`;
  }
};

// Update order tracking status and details
window.updateOrderTracking = async function(orderId) {
  const token = localStorage.getItem('paps_token');
  const carrier = document.getElementById(`track-carrier-${orderId}`).value.trim();
  const trackingNumber = document.getElementById(`track-number-${orderId}`).value.trim();
  const trackingStatus = document.getElementById(`track-status-${orderId}`).value;
  
  try {
    const res = await fetch(`/api/admin/orders/${orderId}/tracking`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ 
        tracking_status: trackingStatus, 
        tracking_number: trackingNumber, 
        shipping_carrier: carrier 
      })
    });
    
    if (res.ok) {
      alert('✅ Seguimiento de pedido actualizado.');
      loadTrackingTable();
      loadOrdersTable();
      loadReportsData();
    } else {
      const data = await res.json();
      alert(data.error || 'Error al actualizar el seguimiento.');
    }
  } catch (err) {
    console.error(err);
    alert('Error al conectar con el servidor.');
  }
};

// Navigation tab shortcut and scroll helper
window.goToTrackingTab = function(orderId) {
  const trackingBtn = document.getElementById('tracking-tab-btn');
  if (trackingBtn) {
    switchTab('tracking-section', trackingBtn);
    setTimeout(() => {
      const row = document.querySelector(`#tracking-table-body tr[data-order-id="${orderId}"]`);
      if (row) {
        row.scrollIntoView({ behavior: 'smooth', block: 'center' });
        row.style.backgroundColor = '#e3f2fd';
        setTimeout(() => {
          row.style.backgroundColor = '';
        }, 2000);
      }
    }, 150);
  }
};

// Preview purge by keyword
window.previewPurgeProducts = async function() {
  const keywordInput = document.getElementById('purge-keyword-input');
  const previewBox = document.getElementById('purge-preview-box');
  if (!keywordInput || !previewBox) return;

  const query = keywordInput.value.trim();
  if (!query) {
    alert('Por favor ingresa una palabra clave para buscar.');
    return;
  }

  const token = localStorage.getItem('paps_token');
  try {
    previewBox.style.display = 'block';
    previewBox.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Buscando coincidencias...`;

    const res = await fetch(`/api/admin/products/purge/preview?query=${encodeURIComponent(query)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || 'Failed to fetch preview');
    }

    const data = await res.json();
    previewBox.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary);">Resultados de búsqueda:</div>
      <p style="margin-top: 4px; color: var(--text-secondary);">
        Se encontraron <strong>${data.count}</strong> productos que coinciden con la palabra clave <strong>"${query}"</strong> (en título, descripción, categoría, marca o SKU).
      </p>
    `;
  } catch (err) {
    console.error('Error previewing purge:', err);
    previewBox.innerHTML = `<span style="color: #ff3b30;"><i class="fa-solid fa-triangle-exclamation"></i> Error al realizar la búsqueda: ${err.message}</span>`;
  }
};

// Execute purge by keyword
window.executePurgeProducts = async function() {
  const keywordInput = document.getElementById('purge-keyword-input');
  const previewBox = document.getElementById('purge-preview-box');
  if (!keywordInput) return;

  const query = keywordInput.value.trim();
  if (!query) {
    alert('Por favor ingresa una palabra clave para eliminar.');
    return;
  }

  const confirmationMsg = `⚠️ ¡ATENCIÓN! ⚠️\n\n¿Estás completamente seguro de que deseas eliminar de forma permanente TODOS los productos que contengan la palabra clave "${query}"?\n\nEsta acción eliminará los productos de la base de datos y no se puede deshacer.`;
  if (!confirm(confirmationMsg)) return;

  const token = localStorage.getItem('paps_token');
  try {
    if (previewBox) {
      previewBox.style.display = 'block';
      previewBox.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Eliminando productos...`;
    }

    const res = await fetch('/api/admin/products/purge', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ query })
    });

    if (!res.ok) {
      const errorData = await res.json();
      throw new Error(errorData.error || 'Failed to execute purge');
    }

    const data = await res.json();
    alert(`✅ Purgado de catálogo exitoso:\n\n• Se eliminaron ${data.deletedCount} productos que contenían la palabra clave "${query}".`);
    
    if (previewBox) {
      previewBox.style.display = 'none';
      previewBox.innerHTML = '';
    }
    keywordInput.value = '';
    
    // Refresh categories count
    if (typeof loadCategories === 'function') {
      loadCategories();
    }
  } catch (err) {
    console.error('Error executing purge:', err);
    alert(`❌ Error al eliminar productos: ${err.message}`);
    if (previewBox) {
      previewBox.innerHTML = `<span style="color: #ff3b30;"><i class="fa-solid fa-triangle-exclamation"></i> Error al eliminar: ${err.message}</span>`;
    }
  }
};

/* ── Admin: Global Coupons ─────────────────────────────── */

window.loadAdminCoupons = async function() {
  const listEl = document.getElementById('admin-coupons-list');
  if (!listEl) return;
  listEl.innerHTML = '<p style="color:#aaa;">Cargando...</p>';
  try {
    const token = localStorage.getItem('admin_token');
    const res = await fetch('/api/admin/coupons', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (!data.success || data.coupons.length === 0) {
      listEl.innerHTML = '<p style="color:#aaa; font-style: italic;">No hay cupones globales creados aún.</p>';
      return;
    }
    listEl.innerHTML = `
      <table style="width:100%; border-collapse: collapse; font-size: 13px;">
        <thead>
          <tr style="border-bottom: 2px solid #e5e5e5; text-align: left; color: var(--text-secondary);">
            <th style="padding: 8px 12px;">Código</th>
            <th style="padding: 8px 12px;">Descripción</th>
            <th style="padding: 8px 12px;">Tipo</th>
            <th style="padding: 8px 12px;">Valor</th>
            <th style="padding: 8px 12px;"></th>
          </tr>
        </thead>
        <tbody>
          ${data.coupons.map(c => `
            <tr style="border-bottom: 1px solid #f0f0f0;">
              <td style="padding: 10px 12px; font-weight: 700; font-family: monospace; font-size: 14px;">${c.code}</td>
              <td style="padding: 10px 12px; color: var(--text-secondary);">${c.description || '—'}</td>
              <td style="padding: 10px 12px;">${c.discount_type === 'percent' ? 'Porcentaje (%)' : 'Monto fijo ($)'}</td>
              <td style="padding: 10px 12px; font-weight: 600; color: #34c759;">
                ${c.discount_type === 'percent' ? c.discount_value + '%' : '$' + Number(c.discount_value).toLocaleString() + ' MXN'}
              </td>
              <td style="padding: 10px 12px; text-align: right;">
                <button onclick="deleteAdminCoupon(${c.id}, '${c.code}')"
                  style="background: none; border: 1px solid #ff3b30; color: #ff3b30; border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; transition: all 0.15s;">
                  <i class="fa-solid fa-trash-can"></i> Eliminar
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    listEl.innerHTML = `<p style="color:#ff3b30;">Error al cargar cupones: ${err.message}</p>`;
  }
};

window.createAdminCoupon = async function() {
  const code = document.getElementById('new-coupon-code')?.value?.trim();
  const description = document.getElementById('new-coupon-desc')?.value?.trim();
  const discount_type = document.getElementById('new-coupon-type')?.value;
  const discount_value = document.getElementById('new-coupon-value')?.value;
  const msgEl = document.getElementById('coupon-create-msg');

  if (!code || !discount_value) {
    if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#ff3b30'; msgEl.textContent = 'El código y el valor son obligatorios.'; }
    return;
  }

  try {
    const token = localStorage.getItem('admin_token');
    const res = await fetch('/api/admin/coupons', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ code, description, discount_type, discount_value: parseFloat(discount_value) })
    });
    const data = await res.json();
    if (!res.ok) {
      if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#ff3b30'; msgEl.textContent = data.error; }
      return;
    }
    if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#34c759'; msgEl.textContent = `✅ ${data.message}`; }
    // Clear form
    document.getElementById('new-coupon-code').value = '';
    document.getElementById('new-coupon-desc').value = '';
    document.getElementById('new-coupon-value').value = '';
    // Reload list
    loadAdminCoupons();
  } catch (err) {
    if (msgEl) { msgEl.style.display = 'block'; msgEl.style.color = '#ff3b30'; msgEl.textContent = `Error: ${err.message}`; }
  }
};

window.deleteAdminCoupon = async function(id, code) {
  if (!confirm(`¿Eliminar el cupón "${code}"?`)) return;
  try {
    const token = localStorage.getItem('admin_token');
    const res = await fetch(`/api/admin/coupons/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    if (res.ok) {
      loadAdminCoupons();
    } else {
      alert(`❌ ${data.error}`);
    }
  } catch (err) {
    alert(`❌ Error: ${err.message}`);
  }
};

