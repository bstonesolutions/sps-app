export function automaticReportChannels({
  scheduleCfg = {},
  hasPhone = false,
  hasEmail = false,
  textAllowed = true,
  emailAllowed = true,
  reportOptOut = false,
} = {}) {
  const enabled = !!scheduleCfg.schedulerOn && !!scheduleCfg.postVisitOn && !reportOptOut;
  return {
    text: enabled && !!hasPhone && !!textAllowed,
    email: enabled && !!hasEmail && !!emailAllowed,
  };
}

export function reportEmailUiResult({
  responseOk = false,
  sent = false,
  held = false,
  reason = "",
  error = "",
  recipient = "",
  photoCount = 0,
  testModeOn = false,
  liveClient = false,
} = {}) {
  if (held) {
    return {
      ok: false,
      sent: false,
      held: true,
      text: `Test Mode — report NOT sent.${reason ? ` (${reason})` : ""}`,
    };
  }

  if (!responseOk || !sent) {
    return {
      ok: false,
      sent: false,
      held: false,
      text: error || "Email failed to send.",
    };
  }

  if (testModeOn && !liveClient) {
    return {
      ok: true,
      sent: true,
      held: false,
      text: "Test Mode — report accepted for delivery to your test email, tagged [TEST].",
    };
  }

  return {
    ok: true,
    sent: true,
    held: false,
    text: `Report accepted for delivery to ${recipient}${photoCount ? ` with ${photoCount} photo${photoCount === 1 ? "" : "s"}` : ""}.`,
  };
}
