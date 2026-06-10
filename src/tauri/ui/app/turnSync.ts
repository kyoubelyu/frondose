export async function waitForDoneSse(
  getCurrentTurnId: () => string | null,
  targetTurnId: string,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cur = getCurrentTurnId();
    if (cur === null || cur !== targetTurnId) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}
