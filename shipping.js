const express = require('express');
const router = express.Router();
const { dbQuery } = require('./database');
require('dotenv').config();

// Helper to generate progress tracking events with coherent timestamps
function getTrackingEvents(order) {
  const createdAtTime = new Date(order.created_at).getTime();
  const now = Date.now();
  const events = [];
  
  // Ensures event timestamps are relative to purchase time but in the past
  const getEventTime = (offsetMs) => {
    const targetTime = createdAtTime + offsetMs;
    return new Date(Math.min(targetTime, now)).toISOString();
  };
  
  const statuses = ['compra_realizada', 'recolectado', 'centro_distribucion', 'en_ruta', 'entregado'];
  const currentIdx = statuses.indexOf(order.tracking_status || 'compra_realizada');
  
  const eventDefs = [
    {
      status: 'compra_realizada',
      title: 'Compra realizada con éxito',
      description: 'Tu pago ha sido procesado de forma segura y el pedido está registrado en nuestro sistema.',
      location: 'Almacén BRVN',
      offset: 0
    },
    {
      status: 'recolectado',
      title: 'Recolectado por la paquetería',
      description: `El paquete ha sido recolectado por el mensajero de ${order.shipping_carrier || 'la paquetería'} en nuestro almacén.`,
      location: 'Almacén BRVN',
      offset: 3 * 3600 * 1000 // 3 hours later
    },
    {
      status: 'centro_distribucion',
      title: 'Llegada a centro de distribución',
      description: `El envío ingresó al centro de clasificación de ${order.shipping_carrier || 'la paquetería'}.`,
      location: 'Centro Logístico Regional',
      offset: 12 * 3600 * 1000 // 12 hours later
    },
    {
      status: 'en_ruta',
      title: 'En ruta de entrega',
      description: 'El repartidor local ha cargado el paquete y se encuentra en ruta hacia tu domicilio.',
      location: 'Oficina Postal de Destino',
      offset: 24 * 3600 * 1000 // 24 hours later
    },
    {
      status: 'entregado',
      title: 'Entregado',
      description: `Entregado satisfactoriamente en el domicilio. Recibido por ${order.customer_name}.`,
      location: 'Domicilio del cliente',
      offset: 28 * 3600 * 1000 // 28 hours later
    }
  ];
  
  for (let i = 0; i <= currentIdx && i < eventDefs.length; i++) {
    const def = eventDefs[i];
    events.push({
      title: def.title,
      description: def.description,
      location: def.location,
      timestamp: getEventTime(def.offset)
    });
  }
  
  return events.reverse(); // Most recent first
}

/**
 * API: GET /api/shipping/track/:trackingNumber
 * Returns real-time tracking events for the customer based on database status
 */
router.get('/api/shipping/track/:trackingNumber', async (req, res) => {
  const { trackingNumber } = req.params;
  
  try {
    const order = await dbQuery.get("SELECT * FROM orders WHERE tracking_number = ?", [trackingNumber]);
    if (!order) {
      return res.status(404).json({ error: 'Número de guía no encontrado en el sistema.' });
    }
    
    const events = getTrackingEvents(order);
    
    // Status translation for display
    let currentStatus = 'Compra realizada';
    if (order.tracking_status === 'entregado') currentStatus = 'Entregado';
    else if (order.tracking_status === 'en_ruta') currentStatus = 'En ruta de entrega';
    else if (order.tracking_status === 'centro_distribucion') currentStatus = 'Llegada a centro de distribución';
    else if (order.tracking_status === 'recolectado') currentStatus = 'Recolectado por paquetería';
    
    res.json({
      trackingNumber,
      carrier: order.shipping_carrier,
      status: currentStatus,
      orderFolio: order.id,
      events: events
    });
    
  } catch (err) {
    console.error('Error fetching tracking details:', err);
    res.status(500).json({ error: 'Failed to retrieve tracking details.' });
  }
});

module.exports = router;
