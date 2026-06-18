// api/quickbooks/disconnect.js
// Clears the stored QuickBooks tokens server-side (the app's "Disconnect" button).
import { clearTokens, setCors } from "./qb-store.js";
import { requireUser } from "../_auth.js";

export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "Method not allowed" });
  const _u = await requireUser(req, res);
  if (!_u) return;
  try {
    await clearTokens();
    return res.status(200).json({ success: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
