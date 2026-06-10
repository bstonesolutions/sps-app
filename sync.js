// api/quickbooks/sync.js
// Fetches invoices + customers from QuickBooks and returns them as JSON
export default async function handler(req, res) {
  // Read tokens from cookies
  const cookies = Object.fromEntries(
    (req.headers.cookie || '').split(';').map(c => {
      const [k, ...v] = c.trim().split('=');
      return [k, v.join('=')];
    })
  );

  const accessToken = cookies.qb_access_token;
  const realmId     = cookies.qb_realm_id;

  if (!accessToken || !realmId) {
    return res.status(401).json({ error: 'Not connected to QuickBooks' });
  }

  const base = `https://quickbooks.api.intuit.com/v3/company/${realmId}`;
  const headers = {
    'Authorization': `Bearer ${accessToken}`,
    'Accept':        'application/json',
  };

  try {
    // Fetch invoices
    const invoiceQuery = encodeURIComponent(
      "SELECT * FROM Invoice ORDER BY MetaData.LastUpdatedTime DESC MAXRESULTS 1000"
    );
    const invoiceRes = await fetch(`${base}/query?query=${invoiceQuery}&minorversion=65`, { headers });

    // Fetch customers
    const customerQuery = encodeURIComponent(
      "SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000"
    );
    const customerRes = await fetch(`${base}/query?query=${customerQuery}&minorversion=65`, { headers });

    if (!invoiceRes.ok || !customerRes.ok) {
      // Try to refresh token if expired
      if (invoiceRes.status === 401) {
        return res.status(401).json({ error: 'Token expired', action: 'reconnect' });
      }
      throw new Error('QB API error');
    }

    const invoiceData  = await invoiceRes.json();
    const customerData = await customerRes.json();

    const invoices  = invoiceData?.QueryResponse?.Invoice  || [];
    const customers = customerData?.QueryResponse?.Customer || [];

    // Map QB invoices to SPS format
    const mapped = invoices.map(inv => ({
      qbId:        inv.Id,
      number:      inv.DocNumber || inv.Id,
      clientName:  inv.CustomerRef?.name || '',
      qbCustomerId: inv.CustomerRef?.value,
      date:        inv.TxnDate,
      dueDate:     inv.DueDate,
      total:       inv.TotalAmt,
      balance:     inv.Balance,
      status:      inv.Balance <= 0 ? 'Paid' : new Date(inv.DueDate) < new Date() ? 'Overdue' : 'Sent',
      lines:       (inv.Line || [])
        .filter(l => l.DetailType === 'SalesItemLineDetail')
        .map(l => ({
          description: l.Description || l.SalesItemLineDetail?.ItemRef?.name || 'Service',
          qty:         l.SalesItemLineDetail?.Qty || 1,
          rate:        l.SalesItemLineDetail?.UnitPrice || 0,
          amount:      l.Amount || 0,
        })),
    }));

    // Map QB customers to SPS format
    const mappedCustomers = customers.map(c => ({
      qbId:    c.Id,
      name:    c.DisplayName || c.FullyQualifiedName,
      email:   c.PrimaryEmailAddr?.Address || '',
      phone:   c.PrimaryPhone?.FreeFormNumber || '',
      address: c.BillAddr
        ? [c.BillAddr.Line1, c.BillAddr.City, c.BillAddr.CountrySubDivisionCode]
            .filter(Boolean).join(', ')
        : '',
      balance: c.Balance || 0,
    }));

    res.status(200).json({ invoices: mapped, customers: mappedCustomers, realmId });

  } catch (err) {
    console.error('QB sync error:', err);
    res.status(500).json({ error: 'Failed to fetch from QuickBooks' });
  }
}
