document.addEventListener('DOMContentLoaded', () => {
  initAnnouncementBanner();
  const form = document.getElementById('tracking-form');
  if (form) {
    form.addEventListener('submit', handleTrackingSubmit);
  }
});

// Rotating Announcement Banner
async function initAnnouncementBanner() {
  const textEl = document.getElementById('announcement-text');
  if (!textEl) return;
  
  let announcements = [
    "🎁 ¡DESCUENTO EN TU PRIMERA COMPRA! Código: MIPRIMERCOMPRA 🎁",
    "🚚 Envío Gratis en pedidos mayores a $1,499 MXN",
    "💳 Compra a MSI con Mercado Pago"
  ];
  
  try {
    const res = await fetch('/api/announcements');
    if (res.ok) {
      const data = await res.json();
      if (data && data.length > 0) {
        announcements = data.map(a => a.text);
      }
    }
  } catch (err) {
    console.error('Error fetching announcements:', err);
  }
  
  if (announcements.length === 0) return;
  textEl.textContent = announcements[0];
  
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

async function handleTrackingSubmit(e) {
  e.preventDefault();
  
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Buscando...';
  
  const folio = document.getElementById('track-folio').value.toUpperCase().trim();
  const contact = document.getElementById('track-contact').value.trim();
  
  const resultDiv = document.getElementById('tracking-result');
  
  try {
    const res = await fetch('/api/orders/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folio, contact })
    });
    
    const data = await res.json();
    
    if (res.ok) {
      // Show results
      resultDiv.style.display = 'block';
      
      // Update basic fields
      document.getElementById('result-folio').textContent = `Pedido: ${data.folio}`;
      
      // Format date
      const date = new Date(data.createdAt);
      document.getElementById('result-date').textContent = `Fecha: ${date.toLocaleDateString()} ${date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
      
      // Update Timeline Steps
      updateTimeline(data.trackingStatus);
      
      // Update Shipping Info
      const shippingBox = document.getElementById('shipping-info-box');
      const eventsBox = document.getElementById('logistics-events-box');
      if (data.trackingNumber) {
        shippingBox.style.display = 'block';
        document.getElementById('carrier-name').textContent = data.shippingCarrier || 'Pendiente';
        document.getElementById('tracking-code').textContent = data.trackingNumber;
        
        // Generate Link
        const carrierLink = document.getElementById('carrier-link');
        const carrier = (data.shippingCarrier || '').toUpperCase();
        if (carrier.includes('DHL')) {
          carrierLink.href = `https://www.dhl.com/es-es/home/tracking/tracking-express.html?submit=1&tracking-id=${data.trackingNumber}`;
        } else if (carrier.includes('FEDEX')) {
          carrierLink.href = `https://www.fedex.com/fedextrack/?trknbr=${data.trackingNumber}`;
        } else if (carrier.includes('ESTAFETA')) {
          carrierLink.href = `https://www.estafeta.com/Herramientas/Rastreo`;
        } else {
          carrierLink.href = `https://www.google.com/search?q=rastreo+${encodeURIComponent(data.shippingCarrier || '')}+${encodeURIComponent(data.trackingNumber)}`;
        }

        // Load Real-Time Events
        fetchAndRenderLogisticsEvents(data.trackingNumber);
      } else {
        shippingBox.style.display = 'none';
        if (eventsBox) eventsBox.style.display = 'none';
      }
      
      // Render Items list
      const itemsContainer = document.getElementById('result-items');
      itemsContainer.innerHTML = data.items.map(item => `
        <div style="display: flex; justify-content: space-between; align-items: center; font-size: 14px; padding: 8px 0; border-bottom: 1px solid var(--border-color);">
          <div>
            <span style="font-weight: 500;">${item.title}</span><br>
            <span style="font-size: 12px; color: var(--text-secondary);">Talla: ${item.size} | Color: ${item.color} | Cantidad: ${item.qty}</span>
          </div>
          <span style="font-weight: 600;">$${(item.price * item.qty).toLocaleString()} MXN</span>
        </div>
      `).join('');
      
      // Scroll to result smoothly
      resultDiv.scrollIntoView({ behavior: 'smooth' });
      
    } else {
      alert(data.error || 'No se pudo encontrar el pedido. Verifica los datos.');
      resultDiv.style.display = 'none';
    }
  } catch (err) {
    console.error(err);
    alert('Error al consultar el rastreo. Revisa tu conexión.');
    resultDiv.style.display = 'none';
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = '<i class="fa-solid fa-magnifying-glass"></i> Consultar Estado';
  }
}

function updateTimeline(trackingStatus) {
  // Clear states
  const steps = ['compra_realizada', 'recolectado', 'centro_distribucion', 'en_ruta', 'entregado'];
  steps.forEach(s => {
    const el = document.getElementById(`step-${s}`);
    if (el) {
      el.className = 'timeline-step';
    }
  });
  
  // Set completed / active based on trackingStatus
  const index = steps.indexOf(trackingStatus);
  if (index !== -1) {
    for (let i = 0; i <= index; i++) {
      const el = document.getElementById(`step-${steps[i]}`);
      if (el) {
        el.classList.add('completed');
        if (i === index) {
          el.classList.add('current');
        }
      }
    }
  }
}

async function fetchAndRenderLogisticsEvents(trackingNumber) {
  const eventsBox = document.getElementById('logistics-events-box');
  const eventsList = document.getElementById('logistics-events-list');
  if (!eventsBox || !eventsList) return;
  
  eventsBox.style.display = 'block';
  eventsList.innerHTML = '<p style="font-size: 13px; color: var(--text-secondary);"><i class="fa-solid fa-spinner fa-spin"></i> Cargando historial de rastreo...</p>';
  
  try {
    const res = await fetch(`/api/shipping/track/${trackingNumber}`);
    if (!res.ok) throw new Error('Failed to fetch tracking history');
    const data = await res.json();
    
    if (data.events && data.events.length > 0) {
      eventsList.innerHTML = data.events.map(event => {
        const date = new Date(event.timestamp);
        const dateStr = `${date.toLocaleDateString('es-MX')} ${date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}`;
        return `
          <div style="display: flex; gap: 12px; font-size: 13px; line-height: 1.4; border-bottom: 1px dashed var(--border-color); padding-bottom: 10px;">
            <div style="color: var(--text-secondary); font-size: 11px; font-weight: 600; white-space: nowrap; width: 110px; padding-top: 2px;">
              ${dateStr}
            </div>
            <div style="flex-grow: 1;">
              <div style="font-weight: 600; color: var(--text-primary);">${event.title}</div>
              <div style="color: var(--text-secondary); font-size: 12px; margin-top: 2px;">${event.description}</div>
              <div style="font-size: 11px; font-weight: 600; color: #007aff; margin-top: 4px; display: flex; align-items: center; gap: 4px;">
                <i class="fa-solid fa-location-dot"></i> ${event.location}
              </div>
            </div>
          </div>
        `;
      }).join('');
    } else {
      eventsList.innerHTML = '<p style="font-size: 13px; color: var(--text-secondary);">No hay movimientos de envío registrados aún.</p>';
    }
  } catch (err) {
    console.error(err);
    eventsList.innerHTML = '<p style="font-size: 13px; color: #ff3b30;">No se pudo cargar el historial de rastreo de LogiBoost.</p>';
  }
}
