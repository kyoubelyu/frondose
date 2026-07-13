export function isNearBottom(scrollAreaEl, thresholdPx) {
    const sc = scrollAreaEl;
    const distance = sc.scrollHeight - (sc.scrollTop + sc.clientHeight);
    return distance <= thresholdPx;
}
export function scrollToBottomIfPinned(scrollAreaEl, thresholdPx) {
    if (!isNearBottom(scrollAreaEl, thresholdPx))
        return;
    const sc = scrollAreaEl;
    sc.scrollTop = sc.scrollHeight - sc.clientHeight;
}
//# sourceMappingURL=scrolling.js.map