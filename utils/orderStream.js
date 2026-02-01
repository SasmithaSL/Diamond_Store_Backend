const subscribers = new Set();

function addSubscriber(res) {
  subscribers.add(res);
}

function removeSubscriber(res) {
  subscribers.delete(res);
}

function notifyNewOrder(order) {
  if (!order) return;
  const payload = JSON.stringify({
    orderId: order.id,
    orderNumber: order.order_number,
    userId: order.user_id,
    createdAt: order.created_at,
  });

  for (const res of Array.from(subscribers)) {
    try {
      res.write(`event: new-order\ndata: ${payload}\n\n`);
    } catch (err) {
      subscribers.delete(res);
    }
  }
}

module.exports = {
  addSubscriber,
  removeSubscriber,
  notifyNewOrder,
};
