function createListingsRenderer(dependencies) {
    const {
        escapeHtml,
        translate,
        seStringText,
        listingDutyName,
    } = dependencies;

    function renderBadgeLabel(key) {
        return `[<span data-i18n="${escapeHtml(key)}">${escapeHtml(translate(key, key))}</span>]`;
    }

    function renderDescription(listing) {
        const description = seStringText(listing.description).trim();
        if (description.length === 0) {
            return `<div class="description"><em>${escapeHtml(translate('none', 'None'))}</em></div>`;
        }

        const badges = Array.isArray(listing.description_badges)
            ? listing.description_badges.map(renderBadgeLabel).join('')
            : '';
        const flags = badges.length > 0
            ? `<div class="flags ${escapeHtml(listing.description_badge_class || '')}">${badges}</div>`
            : '';

        return `<div class="description">${flags}<div class="desc-text">${escapeHtml(description)}</div></div>`;
    }

    function renderDisplaySlots(listing) {
        const slots = Array.isArray(listing.display_slots) ? listing.display_slots : [];
        return slots.map((slot) => {
            const filled = slot.filled ? ' filled' : '';
            const roleClass = slot.role_class ? ` ${escapeHtml(slot.role_class)}` : '';
            const title = escapeHtml(slot.title || '');
            const icon = slot.filled && slot.icon_code
                ? `<svg viewBox="0 0 84 84" aria-hidden="true"><use href="/assets/job-icons.svg#${escapeHtml(slot.icon_code)}"></use></svg>`
                : '';

            return `<div class="slot${filled}${roleClass}" title="${title}">${icon}</div>`;
        }).join('');
    }

    function renderParseValue(percentile, colorClass, presentTitle, emptyTitle) {
        if (percentile === null || percentile === undefined) {
            return `<span class="parse parse-none" title="${escapeHtml(emptyTitle)}">--</span>`;
        }

        return `<span class="parse ${escapeHtml(colorClass || 'parse-none')}" title="${escapeHtml(`${presentTitle}: ${percentile}`)}">${escapeHtml(percentile)}</span>`;
    }

    function renderParseBlock(parse) {
        if (!parse) {
            return `<span class="parse parse-none" title="${escapeHtml(translate('no_log_data', 'No log data'))}">--</span>`;
        }

        if (parse.hidden) {
            const hiddenTitle = escapeHtml(translate('fflogs_hidden', 'FFLogs: Hidden'));
            if (parse.has_secondary) {
                return `<div class="parse-dual parse-dual-hidden" title="${hiddenTitle}"><span class="parse parse-hidden">${escapeHtml(translate('fflogs_hidden_badge', 'HID'))}</span></div>`;
            }
            return `<span class="parse parse-hidden" title="${hiddenTitle}">${escapeHtml(translate('fflogs_hidden_badge', 'HID'))}</span>`;
        }

        if (parse.has_secondary) {
            return `<div class="parse-dual">${renderParseValue(parse.primary_percentile, parse.primary_color_class, 'P1 Best', 'P1: No data')}${renderParseValue(parse.secondary_percentile, parse.secondary_color_class, 'P2 Best', 'P2: No data')}</div>`;
        }

        return renderParseValue(parse.primary_percentile, parse.primary_color_class, 'Best Parse', 'No log data');
    }

    function hiddenRailTagLabel(parse) {
        return parse?.originally_hidden
            ? translate('fflogs_hidden_badge', 'HID')
            : '';
    }

    function hiddenRailTagTitle(parse) {
        return parse?.originally_hidden
            ? translate('fflogs_originally_hidden_player', 'FFLogs: Originally hidden player')
            : translate('fflogs_hidden', 'FFLogs: Hidden');
    }

    function renderParseRailTag(parse) {
        const label = hiddenRailTagLabel(parse);
        if (!label) return '';
        return `<span class="tag tag-hidden" title="${escapeHtml(hiddenRailTagTitle(parse))}">${escapeHtml(label)}</span>`;
    }

    function renderEstimatedTag(parse) {
        return parse?.estimated
            ? '<span class="est" title="Estimated match (may be wrong)">?</span>'
            : '';
    }

    function isKnownMemberName(name) {
        const trimmed = String(name || '').trim();
        return trimmed.length > 0
            && trimmed.toLowerCase() !== 'unknown member'
            && trimmed.toLowerCase() !== 'party leader';
    }

    function hasKnownMemberIdentity(member) {
        const world = String(member?.home_world?.name || '').trim();
        return isKnownMemberName(member?.name)
            && world.length > 0
            && world.toLowerCase() !== 'unknown';
    }

    function parseDisplayablePhaseProgress(phase) {
        const label = String(phase?.display_text || '').trim();
        const match = /^P(\d+)\s+(\d+(?:\.\d+)?)%/i.exec(label);
        if (!match) return null;

        const order = Number(match[1]);
        const bossPercentage = Number(match[2]);
        if (!Number.isFinite(order) || !Number.isFinite(bossPercentage) || bossPercentage <= 0) {
            return null;
        }

        return { order, bossPercentage };
    }

    function selectDisplayablePhaseProgress(progress) {
        const phases = Array.isArray(progress?.phase_progress) ? progress.phase_progress : [];
        return phases
            .map((phase) => ({ phase, rank: parseDisplayablePhaseProgress(phase) }))
            .filter((candidate) => candidate.phase && candidate.rank)
            .reduce((best, phase) => {
                if (!best) return phase;
                if (phase.rank.order > best.rank.order) return phase;
                if (phase.rank.order < best.rank.order) return best;
                return phase.rank.bossPercentage < best.rank.bossPercentage ? phase : best;
            }, null)?.phase;
    }

    function renderPhaseProgress(progress) {
        const farthest = selectDisplayablePhaseProgress(progress);
        if (!farthest) return '';

        const label = farthest.display_text;
        return `<span class="tag tag-phase" title="${escapeHtml(label)}">${escapeHtml(label)}</span>`;
    }

    function hasVisibleParsePercentile(parse) {
        return parse
            && !parse.hidden
            && (parse.primary_percentile !== null && parse.primary_percentile !== undefined
                || parse.secondary_percentile !== null && parse.secondary_percentile !== undefined);
    }

    function memberParseForProgress(parse, progress) {
        if (!selectDisplayablePhaseProgress(progress) || !hasVisibleParsePercentile(parse)) {
            return parse;
        }

        return {
            ...parse,
            primary_percentile: null,
            primary_color_class: 'parse-none',
            secondary_percentile: null,
            secondary_color_class: 'parse-none',
            estimated: false,
        };
    }

    function renderProgressTags(progress) {
        const finalClearCount = Number(progress?.final_clear_count);
        if (Number.isFinite(finalClearCount) && finalClearCount > 0) {
            return `<span class="tag tag-clear" title="${escapeHtml(`Clears: ${finalClearCount}`)}">✅${escapeHtml(finalClearCount)}</span>`;
        }

        const phaseProgress = renderPhaseProgress(progress);
        if (phaseProgress) {
            return phaseProgress;
        }

        const finalBossPercentage = Number(progress?.final_boss_percentage);
        if (Number.isFinite(finalBossPercentage) && finalBossPercentage > 0) {
            const label = finalBossPercentage.toFixed(2);
            return `<span class="tag tag-boss" title="${escapeHtml(`Final Boss HP: ${label}%`)}">${escapeHtml(label)}%</span>`;
        }

        return '';
    }

    function renderMemberRow(member) {
        const unknownJobClass = member.job_id === 0 ? ' unknown-job' : '';
        const hasKnownIdentity = hasKnownMemberIdentity(member);
        const memberProgress = hasKnownIdentity ? member.progress : null;
        const memberParse = hasKnownIdentity ? memberParseForProgress(member.parse, memberProgress) : null;
        const memberTags = hasKnownIdentity
            ? `${renderParseRailTag(member.parse)}${renderProgressTags(memberProgress)}`
            : '';
        const jobIcon = member.job_code
            ? `<svg class="job-icon ${escapeHtml(member.role_class || '')}" viewBox="0 0 84 84" aria-hidden="true"><use href="/assets/job-icons.svg#${escapeHtml(member.job_code)}"></use></svg>`
            : `<span class="job-unknown" title="${escapeHtml(translate('unknown_job', 'Unknown job'))}">?</span>`;
        const fflogsLink = member.fflogs_character_url
            ? `<a class="fflogs-link" href="${escapeHtml(member.fflogs_character_url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(`Open FFLogs profile for ${member.name}`)}" title="Open FFLogs character profile">FF</a>`
            : '';

        return `
                <li class="member-row${unknownJobClass}" data-party-index="${escapeHtml(member.party_index)}" data-slot-index="${escapeHtml(member.slot_index)}">
                    <span class="member-job">${jobIcon}</span>
                    <div class="member-parse">${renderParseBlock(memberParse)}${renderEstimatedTag(memberParse)}</div>
                    <span class="member-info"><span class="member-name">${escapeHtml(member.name)}</span> <small class="member-world">@ ${escapeHtml(member.home_world?.name || translate('unknown', 'Unknown'))}</small></span>
                    <span class="member-tags">${memberTags}</span>
                    <span class="member-link-slot">${fflogsLink}</span>
                </li>`;
    }

    function membersHeader(count) {
        return `<div class="members-header">${escapeHtml(translate('members_count', 'Members ({count})', { count }))}</div>`;
    }

    function renderMembersSection(listing) {
        const members = Array.isArray(listing.members) ? listing.members : [];
        const header = membersHeader(members.length);

        if (members.length === 0) {
            return `<div class="members-list">${header}<p class="no-members"><em data-i18n="no_members">${escapeHtml(translate('no_members', 'No information available for other members'))}</em></p></div>`;
        }

        return `<div class="members-list">${header}<ul>${members.map(renderMemberRow).join('')}</ul></div>`;
    }

    function alliancePartyLabel(partyIndex) {
        const keys = ['alliance_a', 'alliance_b', 'alliance_c'];
        const key = keys[partyIndex];
        return key ? translate(key, `Alliance ${String.fromCharCode(65 + partyIndex)}`) : '';
    }

    function renderAllianceMembersSection(listing) {
        const members = Array.isArray(listing.members) ? listing.members : [];
        const header = membersHeader(members.length);

        if (members.length === 0) {
            return `<div class="members-list alliance">${header}<p class="no-members"><em data-i18n="no_members">${escapeHtml(translate('no_members', 'No information available for other members'))}</em></p></div>`;
        }

        const groups = new Map();
        members.forEach((member) => {
            const key = member.party_index ?? 0;
            if (!Number.isInteger(key) || key < 0 || key > 2) return;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(member);
        });

        const columns = Array.from(groups.entries())
            .sort((a, b) => a[0] - b[0])
            .map(([partyIndex, groupMembers]) => {
                const label = alliancePartyLabel(partyIndex) || `Alliance ${String.fromCharCode(65 + partyIndex)}`;
                return `<div class="alliance-column"><div class="alliance-heading">${escapeHtml(label)}</div><ul class="alliance-member-list">${groupMembers.map(renderMemberRow).join('')}</ul></div>`;
            })
            .join('');

        return `<div class="members-list alliance">${header}<div class="alliance-columns">${columns}</div></div>`;
    }

    function renderLeaderMeta(listing) {
        const parse = listing.leader_parse;
        return `${renderParseBlock(parse)}${renderParseRailTag(parse)}${renderEstimatedTag(parse)}`;
    }

    function renderListingCard(container) {
        const listing = container.listing;
        const expiresAt = Number(container.expires_at_timestamp);
        const expiresAtAttr = Number.isFinite(expiresAt)
            ? ` data-expires-at="${escapeHtml(expiresAt)}"`
            : '';
        const dutyClass = listing.cross_world ? ' cross' : ' local';
        const partyClass = listing.is_alliance_view ? ' party-alliance' : '';
        const partySlotsClass = listing.is_alliance_view ? ' party-slots-24' : '';
        const listingClass = listing.is_alliance_view ? ' listing listing-alliance-wide' : 'listing';
        const membersSection = listing.is_alliance_view
            ? renderAllianceMembersSection(listing)
            : renderMembersSection(listing);

        return `
                <div class="${listingClass}"
                    data-centre="${escapeHtml(listing.data_centre || '')}"
                    data-joinable-roles="${escapeHtml(listing.joinable_roles || 0)}"
                    data-num-parties="${escapeHtml(listing.num_parties || 0)}"
                    data-high-end="${escapeHtml(Boolean(listing.high_end))}"
                    data-objective="${escapeHtml(listing.objective_bits || 0)}"
                    data-conditions="${escapeHtml(listing.conditions_bits || 0)}"
                    data-search-area="${escapeHtml(listing.search_area_bits || 0)}"
                    data-min-item-level="${escapeHtml(listing.min_item_level || 0)}"
                    data-duty-id="${escapeHtml(listing.duty_id || 0)}"
                    data-content-kind="${escapeHtml(listing.content_kind || 0)}">
                    <div class="left">
                        <div class="duty${dutyClass}">${escapeHtml(listingDutyName(listing))}</div>
                        ${renderDescription(listing)}
                        <div class="party${partyClass}">
                            <div class="party-slots${partySlotsClass}">${renderDisplaySlots(listing)}</div>
                            <div class="total">${escapeHtml(listing.slots_filled_count || 0)}/${escapeHtml(listing.slot_count || 0)}</div>
                        </div>
                        ${!listing.is_alliance_view ? membersSection : ''}
                    </div>
                    <div class="middle">
                        <div class="stat">
                            <div class="name">${escapeHtml(translate('min_il_short', 'Min IL'))}</div>
                            <div class="value">${escapeHtml(listing.min_item_level || 0)}</div>
                        </div>
                    </div>
                    <div class="right meta">
                        <div class="item creator">
                            <span class="text">${escapeHtml(seStringText(listing.creator_name))} @ ${escapeHtml(listing.home_world?.name || translate('unknown', 'Unknown'))}</span>
                            ${renderLeaderMeta(listing)}
                            <span title="${escapeHtml(translate('creator', 'Creator'))}"><svg class="icon" viewBox="0 0 32 32" aria-hidden="true"><use href="/assets/icons.svg#user"></use></svg></span>
                        </div>
                        <div class="item world">
                            <span class="text">${escapeHtml(listing.created_world?.name || translate('unknown', 'Unknown'))}</span>
                            <span title="${escapeHtml(translate('created_on', 'Created on'))}"><svg class="icon" viewBox="0 0 32 32" aria-hidden="true"><use href="/assets/icons.svg#sphere"></use></svg></span>
                        </div>
                        <div class="item expires" data-expires-in="${escapeHtml(container.time_left_seconds || 0)}"${expiresAtAttr}>
                            <span class="text"></span>
                            <span title="${escapeHtml(translate('expires', 'Expires'))}"><svg class="icon" viewBox="0 0 32 32" aria-hidden="true"><use href="/assets/icons.svg#stopwatch"></use></svg></span>
                        </div>
                        <div class="item updated" data-updated-at="${escapeHtml(container.updated_at_timestamp || 0)}">
                            <span class="text"></span>
                            <span title="${escapeHtml(translate('updated', 'Updated'))}"><svg class="icon" viewBox="0 0 32 32" aria-hidden="true"><use href="/assets/icons.svg#clock"></use></svg></span>
                        </div>
                    </div>
                    ${listing.is_alliance_view ? membersSection : ''}
                </div>`;
    }

    return {
        renderDescription,
        renderListingCard,
        renderPhaseProgress,
        renderProgressTags,
    };
}

module.exports = {
    createListingsRenderer,
};
