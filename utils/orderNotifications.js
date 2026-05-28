const { sendEmail } = require('./emailOtp');

const ORDER_STATUS_MESSAGES = {
  accepted: 'Your order is ready',
  out_from_warehouse: 'Your order is out from warehouse',
  delivered: 'Your order has been delivered',
  cancelled: 'Your order was cancelled',
};

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
}[character]));

const orderStatusMessage = (status) => ORDER_STATUS_MESSAGES[status] || String(status || 'Order updated').replace(/_/g, ' ');

const sendOrderStatusEmail = async ({ order, status }) => {
  const email = String(order?.customer_email || order?.email || '').trim();
  if (!email) return { sent: false, skipped: true, reason: 'missing_email' };

  const orderCode = order?.order_code || order?.id || 'your order';
  const statusMessage = orderStatusMessage(status);
  const safeOrderCode = escapeHtml(orderCode);
  const safeStatusMessage = escapeHtml(statusMessage);

  await sendEmail({
    to: email,
    subject: `Poohter order update: ${statusMessage}`,
    text: [
      'Hi,',
      '',
      `${statusMessage}.`,
      `Order: ${orderCode}`,
      '',
      'Thank you for shopping with Poohter.',
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
        <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;padding:28px">
          <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:#2563eb;letter-spacing:.06em;text-transform:uppercase">Poohter</p>
          <h1 style="margin:0 0 12px;font-size:24px;line-height:1.2">${safeStatusMessage}</h1>
          <p style="margin:0 0 16px;color:#475569;line-height:1.6">Order <strong>${safeOrderCode}</strong> has been updated.</p>
          <p style="margin:0;color:#64748b;line-height:1.5">Thank you for shopping with Poohter.</p>
        </div>
      </div>
    `,
  });

  return { sent: true, skipped: false };
};

const sendOrderStatusEmailSafely = async ({ order, status }) => {
  try {
    return await sendOrderStatusEmail({ order, status });
  } catch (error) {
    console.error('[order email] failed to send status email', {
      orderId: order?.id,
      orderCode: order?.order_code,
      status,
      error: error.message,
    });
    return { sent: false, skipped: false, error: error.message };
  }
};

module.exports = {
  orderStatusMessage,
  sendOrderStatusEmailSafely,
};
