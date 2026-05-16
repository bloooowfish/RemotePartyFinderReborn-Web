function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function nowSeconds() {
    return Math.floor(Date.now() / 1000);
}

function applySnapshotExpiryTimestamps(snapshot, receivedAtSeconds = nowSeconds()) {
    if (!Array.isArray(snapshot?.listings)) return;

    for (const container of snapshot.listings) {
        const existing = Number(container.expires_at_timestamp);
        if (Number.isFinite(existing)) continue;

        const timeLeft = Number(container.time_left_seconds);
        if (!Number.isFinite(timeLeft)) continue;

        container.expires_at_timestamp = receivedAtSeconds + Math.max(0, timeLeft);
    }
}

function secondsUntilListingExpiry(container, currentSeconds = nowSeconds()) {
    const expiresAt = Number(container?.expires_at_timestamp);
    if (Number.isFinite(expiresAt)) {
        return Math.max(0, Math.ceil(expiresAt - currentSeconds));
    }

    const timeLeft = Number(container?.time_left_seconds);
    return Number.isFinite(timeLeft) ? Math.max(0, Math.ceil(timeLeft)) : 0;
}

function listingIsExpired(container, currentSeconds) {
    const expiresAt = Number(container?.expires_at_timestamp);
    if (Number.isFinite(expiresAt)) {
        return expiresAt <= currentSeconds;
    }

    const timeLeft = Number(container?.time_left_seconds);
    return Number.isFinite(timeLeft) && timeLeft <= 0;
}

function pruneExpiredListings(snapshot, currentSeconds = nowSeconds()) {
    if (!Array.isArray(snapshot?.listings)) return false;

    const active = snapshot.listings.filter((container) => !listingIsExpired(container, currentSeconds));
    if (active.length === snapshot.listings.length) return false;

    snapshot.listings = active;
    return true;
}

module.exports = {
    applySnapshotExpiryTimestamps,
    escapeHtml,
    nowSeconds,
    pruneExpiredListings,
    secondsUntilListingExpiry,
};
