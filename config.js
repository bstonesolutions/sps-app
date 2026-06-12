// Production site URL. Used for every emailed / shared link (staff invites,
// client magic links, copied portal links) so they always point at the real
// site instead of window.location.origin, which can be localhost or a preview
// host depending on where the app was opened from.
export const PROD_URL = "https://sps-app-azure.vercel.app";
