// api/quickbooks/sync.js
export default async function handler(req, res) {
  // Read tokens passed as query params from the frontend
  const { access_token, realm_id } = req.query;

  if (!access_token || !realm_id) {
    return res.status(401).json({ error: 'Not connected to QuickBooks' });
  }

  const base = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;
  const headers = {
    'Authorization': `Bearer ${access_token}`,
    'Accept':        'application/json',
  };

  try {
    const invoiceQuery = encodeURIComponent(
      "SELECT * FROM Invoice ORDER BY MetaData.LastUpdatedTime DESC MAXRESULTS 1000"
    );
    const customerQuery = encodeURIComponent(
      "SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000"
    );

    const [invoiceRes, customerRes] = await Promise.all([
      fetch(`${base}/query?query=${invoiceQuery}&minorversion=65`, { headers }),
      fetch(`${base}/query?query=${customerQuery}&minorversion=65`, { headers }),
    ]);

    if (invoiceRes.status === 401) {
      return res.status(401).json({ error: 'Token expired', action: 'reconnect' });
    }
    if (!invoiceRes.ok || !customerRes.ok) {
      throw new Error('QB API error ' + invoiceRes.status);
    }

    const invoiceData  = await invoiceRes.json();
    const customerData = await customerRes.json();

    const invoices  = invoiceData?.QueryResponse?.Invoice   || [];
    const customers = customerData?.QueryResponse?.Customer || [];

    const mappedInvoices = invoices.map(inv => ({
      qbId:         inv.Id,
      number:       inv.DocNumber || inv.Id,
      clientName:   inv.CustomerRef?.name  || '',
      qbCustomerId: inv.CustomerRef?.value || '',
      date:         inv.TxnDate,
      dueDate:      inv.DueDate,
      total:        inv.TotalAmt,
      balance:      inv.Balance,
      status:       (inv.Balance <= 0 || inv.PaymentStatus === 'PAID') ? 'Paid'
                    : inv.status === 'VOIDED' ? 'Draft'
                    : (inv.DueDate && new Date(inv.DueDate) < new Date()) ? 'Overdue'
                    : 'Sent',
      paidDate:     inv.Balance <= 0 ? (inv.MetaData?.LastUpdatedTime?.split('T')[0] || null) : null,
      lines: (inv.Line || [])
        .filter(l => l.DetailType === 'SalesItemLineDetail')
        .map(l => ({
          description: l.Description || l.SalesItemLineDetail?.ItemRef?.name || 'Service',
          qty:         l.SalesItemLineDetail?.Qty       || 1,
          rate:        l.SalesItemLineDetail?.UnitPrice || 0,
          amount:      l.Amount || 0,
        })),
    }));

    const mappedCustomers = customers.map(c => ({
      qbId:    c.Id,
      name:    c.DisplayName || c.FullyQualifiedName,
      email:   c.PrimaryEmailAddr?.Address          || '',
      phone:   c.PrimaryPhone?.FreeFormNumber        || '',
      address: c.BillAddr
        ? [c.BillAddr.Line1, c.BillAddr.City, c.BillAddr.CountrySubDivisionCode]
            .filter(Boolean).join(', ')
        : '',
      balance: c.Balance || 0,
    }));

    res.status(200).json({
      invoices:  mappedInvoices,
      customers: mappedCustomers,
      realmId:   realm_id,
    });

  } catch (err) {
    console.error('QB sync error:', err);
    res.status(500).json({ error: 'Failed to fetch from QuickBooks: ' + err.message });
  }
}
