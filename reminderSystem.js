// One fail-closed switch for the Reminders workspace. Existing reminder setup stays
// saved while this is off; only an explicit boolean true may resume queues/sends.
export function reminderSystemEnabled(config) {
  return !!config && config.remindersMasterOn === true;
}
