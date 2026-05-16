function roleFilterValue(joinableRoles) {
    try {
        return BigInt(joinableRoles || 0);
    } catch (_) {
        return 0n;
    }
}

function matchesListingFilters(container, filters, searchText = '') {
    const listing = container.listing;

    if (filters.centre !== 'All' && filters.centre !== (listing.data_centre || '')) {
        return false;
    }

    if (Number(listing.num_parties) === 1 && filters.roles !== 0n) {
        if ((filters.roles & roleFilterValue(listing.joinable_roles)) === 0n) {
            return false;
        }
    }

    if (!listing.high_end) {
        return false;
    }

    if (filters.objectives !== 0 && ((Number(listing.objective_bits) || 0) & filters.objectives) === 0) {
        return false;
    }

    if (filters.conditions !== 0 && ((Number(listing.conditions_bits) || 0) & filters.conditions) === 0) {
        return false;
    }

    if (filters.onePlayerPerJob && ((Number(listing.search_area_bits) || 0) & 32) === 0) {
        return false;
    }

    if (filters.minItemLevel > 0 && Number(listing.min_item_level || 0) < filters.minItemLevel) {
        return false;
    }

    if (filters.contentTypes.length > 0 && !filters.contentTypes.includes(Number(listing.content_kind || 0))) {
        return false;
    }

    if (filters.selectedContents.length > 0 && !filters.selectedContents.includes(Number(listing.duty_id || 0))) {
        return false;
    }

    if (filters.searchQuery) {
        const query = filters.searchQuery.toLocaleLowerCase();
        if (!searchText.includes(query)) {
            return false;
        }
    }

    return true;
}

module.exports = {
    matchesListingFilters,
    roleFilterValue,
};
