/**
 * Sends a PDF invoice via Meta's WhatsApp Cloud API.
 * @param {string} recipientPhone - Recipient phone number (e.g. 9876543210 or +919876543210)
 * @param {string} invoiceNumber - The unique invoice number (e.g. INV-1780417...)
 * @param {string} pdfUrl - The publicly accessible URL pointing to the static PDF invoice
 * @returns {Promise<boolean>} True if sent successfully, false otherwise
 */
async function sendWhatsAppInvoice(recipientPhone, invoiceNumber, pdfUrl) {
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  pdfUrl = "https://scolding-chain-quarterly.ngrok-free.dev/invoices/INV-1780426563120-977.pdf"
  if (!phoneId || !accessToken) {
    console.log('[WhatsApp Meta API] Skipping send. Credentials (WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN) are not configured in .env');
    return false;
  }

  // Clean phone number (strip non-digits)
  let cleanPhone = recipientPhone.replace(/\D/g, '');
  // Default to adding Indian country code '91' if it is a 10-digit number
  if (cleanPhone.length === 10) {
    cleanPhone = '91' + cleanPhone;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneId}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: cleanPhone,
    type: 'document',
    document: {
      link: pdfUrl,
      filename: `${invoiceNumber}.pdf`,
      caption: `Thank you for shopping with us! Here is your invoice ${invoiceNumber} from Aura Supermarket.`
    }
  };

  try {
    console.log("pdfUrl: ", pdfUrl);
    console.log(`[WhatsApp Meta API] Sending PDF invoice ${invoiceNumber} to ${cleanPhone} via Meta API...`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const responseData = await response.json();
    if (response.ok) {
      console.log(`[WhatsApp Meta API] Message sent successfully! Msg ID:`, responseData.messages?.[0]?.id);
      return true;
    } else {
      console.error(`[WhatsApp Meta API] Error response from Meta Cloud API:`, responseData);
      return false;
    }
  } catch (err) {
    console.error(`[WhatsApp Meta API] Failed to send message via Meta Cloud API:`, err);
    return false;
  }
}

module.exports = { sendWhatsAppInvoice };
