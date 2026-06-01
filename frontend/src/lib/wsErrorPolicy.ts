export function shouldPublishGlobalWsError(message: Record<string, unknown>, hasPendingCommand: boolean) {
  const requestId = String(message.request_id ?? "").trim();
  if (requestId) return false;
  return !hasPendingCommand;
}
