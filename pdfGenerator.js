const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');

/**
 * Generates a professionally styled PDF invoice.
 * @param {Object} invoice - Invoice metadata (invoice_number, date, branch_name, cashier_name, customer_name, mobile_number, subtotal, discount, tax, total, payment_method, points_earned)
 * @param {Array} items - List of items in the invoice (name, sku, quantity, unit_price, subtotal, unit, gst_rate)
 * @param {string} filePath - Absolute path where the PDF should be written
 */
function generateInvoicePDF(invoice, items, filePath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 50, size: 'A4' });
      const writeStream = fs.createWriteStream(filePath);
      
      doc.pipe(writeStream);

      // Colors
      const primaryColor = '#4f46e5'; // Premium Indigo
      const secondaryColor = '#0f766e'; // Teal Accent
      const darkColor = '#1e293b'; // Slate 800
      const lightColor = '#f8fafc'; // Slate 50
      const borderColor = '#e2e8f0'; // Slate 200
      const textMuted = '#64748b'; // Slate 500

      // ==========================================
      // HEADER BANNER & BRANDING
      // ==========================================
      // Top accent bar
      doc.rect(0, 0, doc.page.width, 15).fill(primaryColor);

      // Brand Title
      doc.fillColor(primaryColor)
         .fontSize(24)
         .font('Helvetica-Bold')
         .text('AURA SUPERMARKET', 50, 40);

      doc.fillColor(textMuted)
         .fontSize(9)
         .font('Helvetica')
         .text('Premium Retail & Quality Experience', 50, 68);

      // Invoice Label
      doc.fillColor(darkColor)
         .fontSize(20)
         .font('Helvetica-Bold')
         .text('INVOICE', 400, 40, { align: 'right' });

      // Invoice Number & Date (Positioned in columns to prevent overlap)
      doc.fillColor(darkColor)
         .fontSize(9.5)
         .font('Helvetica-Bold')
         .text('Invoice No:', 350, 65, { width: 75, align: 'right' });
      doc.font('Helvetica')
         .text(invoice.invoice_number, 430, 65, { width: 115, align: 'left' });

      doc.font('Helvetica-Bold')
         .text('Date:', 350, 80, { width: 75, align: 'right' });
      doc.font('Helvetica')
         .text(invoice.date, 430, 80, { width: 115, align: 'left' });

      // Line separator below header
      doc.moveTo(50, 105)
         .lineTo(doc.page.width - 50, 105)
         .strokeColor(borderColor)
         .lineWidth(1)
         .stroke();

      // ==========================================
      // METADATA GRID (2 COLUMNS)
      // ==========================================
      const metaY = 120;
      
      // Column 1: Store & Transaction Info
      doc.fillColor(primaryColor)
         .fontSize(11)
         .font('Helvetica-Bold')
         .text('TRANSACTION DETAILS', 50, metaY);

      doc.fillColor(darkColor)
         .fontSize(9.5)
         .font('Helvetica-Bold')
         .text('Location: ', 50, metaY + 18, { continued: true })
         .font('Helvetica')
         .text(invoice.branch_name || 'Central Outlet')
         .font('Helvetica-Bold')
         .text('Cashier: ', 50, metaY + 32, { continued: true })
         .font('Helvetica')
         .text(invoice.cashier_name || 'Terminal Operator')
         .font('Helvetica-Bold')
         .text('Payment Method: ', 50, metaY + 46, { continued: true })
         .font('Helvetica')
         .text(invoice.payment_method);

      // Column 2: Customer details
      doc.fillColor(primaryColor)
         .fontSize(11)
         .font('Helvetica-Bold')
         .text('BILL TO (CUSTOMER)', 320, metaY);

      doc.fillColor(darkColor)
         .fontSize(9.5)
         .font('Helvetica-Bold')
         .text('Name: ', 320, metaY + 18, { continued: true })
         .font('Helvetica')
         .text(invoice.customer_name || 'Anonymous Guest')
         .font('Helvetica-Bold')
         .text('WhatsApp Contact: ', 320, metaY + 32, { continued: true })
         .font('Helvetica')
         .text(invoice.mobile_number ? `+91 ${invoice.mobile_number}` : 'Not Linked');

      if (invoice.points_earned > 0) {
        doc.font('Helvetica-Bold')
           .text('Loyalty Points Earned: ', 320, metaY + 46, { continued: true })
           .fillColor(secondaryColor)
           .text(`${invoice.points_earned} pts`);
      }

      // Line separator below Metadata
      doc.moveTo(50, 195)
         .lineTo(doc.page.width - 50, 195)
         .strokeColor(borderColor)
         .stroke();

      // ==========================================
      // ITEMS TABLE
      // ==========================================
      const tableTop = 215;
      
      // Table Header Row Background
      doc.rect(50, tableTop, doc.page.width - 100, 20)
         .fill(lightColor);

      // Table Header Row Text
      doc.fillColor(darkColor)
         .fontSize(9)
         .font('Helvetica-Bold');
      
      doc.text('DESCRIPTION / SKU', 60, tableTop + 6);
      doc.text('QTY', 280, tableTop + 6, { width: 40, align: 'center' });
      doc.text('UNIT PRICE', 330, tableTop + 6, { width: 70, align: 'right' });
      doc.text('GST', 410, tableTop + 6, { width: 50, align: 'right' });
      doc.text('TOTAL (INR)', 470, tableTop + 6, { width: 70, align: 'right' });

      // Table Rows
      let currentY = tableTop + 20;
      doc.font('Helvetica').fontSize(9.5);

      items.forEach((item, index) => {
        // Draw alternate background
        if (index % 2 === 1) {
          doc.rect(50, currentY, doc.page.width - 100, 24)
             .fill('#fafafa');
        }

        doc.fillColor(darkColor);
        
        // Item Name & SKU
        doc.font('Helvetica-Bold')
           .text(item.name || 'Product Details', 60, currentY + 6, { width: 210, height: 12, ellipsis: true });
        
        const skuStr = item.sku ? `SKU: ${item.sku}` : '';
        doc.font('Helvetica')
           .fillColor(textMuted)
           .fontSize(8)
           .text(skuStr, 60, currentY + 16);

        // Quantity
        const qtyFormatted = parseFloat(item.quantity).toFixed(item.unit === 'kg' ? 2 : 0);
        const qtyStr = `${qtyFormatted} ${item.unit || 'pc'}`;
        doc.fillColor(darkColor)
           .fontSize(9.5)
           .text(qtyStr, 280, currentY + 6, { width: 40, align: 'center' });

        // Unit Price
        const unitPriceStr = `₹${parseFloat(item.unit_price).toFixed(2)}`;
        doc.text(unitPriceStr, 330, currentY + 6, { width: 70, align: 'right' });

        // GST Rate
        const gstRateFormatted = item.gst_rate !== undefined ? `${parseFloat(item.gst_rate)}%` : '18%';
        doc.text(gstRateFormatted, 410, currentY + 6, { width: 50, align: 'right' });

        // Subtotal
        const subtotalStr = `₹${parseFloat(item.subtotal).toFixed(2)}`;
        doc.font('Helvetica-Bold')
           .text(subtotalStr, 470, currentY + 6, { width: 70, align: 'right' });

        // Row Separator Line
        doc.moveTo(50, currentY + 24)
           .lineTo(doc.page.width - 50, currentY + 24)
           .strokeColor(borderColor)
           .lineWidth(0.5)
           .stroke();

        currentY += 24;
      });

      // ==========================================
      // SUMMARY BLOCK
      // ==========================================
      currentY += 15;
      
      const summaryX = 320;
      doc.fontSize(10).fillColor(darkColor);

      // Subtotal Row
      doc.font('Helvetica-Bold').text('Gross Subtotal:', summaryX, currentY);
      doc.font('Helvetica').text(`₹${parseFloat(invoice.subtotal).toFixed(2)}`, 450, currentY, { width: 90, align: 'right' });
      currentY += 16;

      // Discount Row (if any)
      if (parseFloat(invoice.discount) > 0) {
        doc.font('Helvetica-Bold').fillColor('#b91c1c').text('Discount:', summaryX, currentY);
        doc.font('Helvetica').text(`-₹${parseFloat(invoice.discount).toFixed(2)}`, 450, currentY, { width: 90, align: 'right' });
        currentY += 16;
      }

      // GST Row
      doc.font('Helvetica-Bold').fillColor(darkColor).text('Tax (GST):', summaryX, currentY);
      doc.font('Helvetica').text(`₹${parseFloat(invoice.tax).toFixed(2)}`, 450, currentY, { width: 90, align: 'right' });
      currentY += 20;

      // Double Line separator before grand total
      doc.moveTo(summaryX, currentY)
         .lineTo(doc.page.width - 50, currentY)
         .strokeColor(borderColor)
         .lineWidth(1)
         .stroke();
      currentY += 6;

      // Total Row (Accented box)
      doc.rect(summaryX - 10, currentY - 4, doc.page.width - summaryX - 40, 26)
         .fill(lightColor);
      
      doc.font('Helvetica-Bold')
         .fillColor(primaryColor)
         .fontSize(12)
         .text('Total Paid (INR):', summaryX, currentY + 4);
         
      doc.fontSize(12)
         .text(`₹${parseFloat(invoice.total).toFixed(2)}`, 450, currentY + 4, { width: 90, align: 'right' });

      currentY += 45;

      // ==========================================
      // FOOTER
      // ==========================================
      const footerY = Math.max(currentY, doc.page.height - 110);
      
      // Aesthetic dividing lines
      doc.moveTo(50, footerY)
         .lineTo(doc.page.width - 50, footerY)
         .strokeColor(primaryColor)
         .lineWidth(1.5)
         .stroke();

      doc.fillColor(darkColor)
         .fontSize(10)
         .font('Helvetica-Bold')
         .text('Thank you for shopping at Aura Supermarket!', 50, footerY + 12, { align: 'center' });

      doc.fillColor(textMuted)
         .fontSize(8)
         .font('Helvetica')
         .text('This is a computer-generated invoice and requires no physical signature.', 50, footerY + 28, { align: 'center' })
         .text('Powered by Aura Intelligent POS & Inventory Management System', 50, footerY + 38, { align: 'center' });

      doc.end();

      writeStream.on('finish', () => {
        console.log(`[PDF Generator] Successfully generated PDF at ${filePath}`);
        resolve();
      });

      writeStream.on('error', (err) => {
        console.error('[PDF Generator] Stream error:', err);
        reject(err);
      });
      
    } catch (err) {
      console.error('[PDF Generator] General generation error:', err);
      reject(err);
    }
  });
}

module.exports = { generateInvoicePDF };
