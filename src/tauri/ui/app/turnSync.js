export async function waitForDoneSse(getCurrentTurnId, targetTurnId, timeoutMs = 3000, intervalMs = 50) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const cur = getCurrentTurnId();
        if (cur === null || cur !== targetTurnId)
            return true;
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
}
//# sourceMappingURL=turnSync.js.map