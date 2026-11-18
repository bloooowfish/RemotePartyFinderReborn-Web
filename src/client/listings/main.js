(function () {
    const {
        applySnapshotExpiryTimestamps,
        escapeHtml,
        nowSeconds,
        pruneExpiredListings,
        secondsUntilListingExpiry,
    } = require('./utils');
    const { matchesListingFilters } = require('./filters');
    const { createListingsRenderer } = require('./renderer');
    const isBrowserBundle = typeof __RPF_BROWSER_BUNDLE__ !== 'undefined' && __RPF_BROWSER_BUNDLE__;

    const PAGE_SIZE = 50;
    const ELLIPSIS = 'ellipsis';
    const REVISION_POLL_INTERVAL_MS = 15000;
    const WS_SILENT_BACKSTOP_INTERVAL_MS = 45000;
    const SNAPSHOT_RESUME_CHECK_MS = REVISION_POLL_INTERVAL_MS;

    let stateWasNull = false;

    const state = {
        centre: 'All',
        roles: 0n,
        lang: null,
        highEnd: true,
        objectives: 0,
        conditions: 0,
        onePlayerPerJob: false,
        minItemLevel: 0,
        contentTypes: [],
        selectedContents: [],
        searchQuery: '',
        page: 1,
        pageSize: PAGE_SIZE,
        snapshot: null,
        filteredListings: [],
    };

    const liveUpdates = {
        socket: null,
        ws: null,
        retryTimer: null,
        refreshTimer: null,
        refreshTimerDelay: null,
        retryAttempt: 0,
        revision: 0,
        revisionEpoch: null,
        targetRevision: 0,
        targetEpoch: null,
        snapshotEtag: null,
        snapshotPayloadStamp: null,
        lastSnapshotAtMs: 0,
        lastWsEventAtMs: 0,
        lastRevisionPollAtMs: 0,
        refreshing: false,
        pendingRefresh: false,
        refreshFailureCount: 0,
        paused: false,
    };

    const EXTRA_TRANSLATIONS = {
        none: {
            en: 'None',
            ja: 'なし',
            de: 'Keine',
            fr: 'Aucun',
        },
        unknown: {
            en: 'Unknown',
            ja: '不明',
            de: 'Unbekannt',
            fr: 'Inconnu',
        },
        unknown_job: {
            en: 'Unknown job',
            ja: '不明なジョブ',
            de: 'Unbekannter Job',
            fr: 'Job inconnu',
        },
        min_il_short: {
            en: 'Min IL',
            ja: '下限IL',
            de: 'Min. GS',
            fr: 'NvObj min.',
        },
        listings_heading: {
            en: 'Party Finder Listings',
            ja: 'パーティ募集一覧',
            de: 'Gruppensuche',
            fr: 'Recherche de groupe',
        },
        reset_filters: {
            en: 'Reset Filters',
            ja: 'フィルターをリセット',
            de: 'Filter zurücksetzen',
            fr: 'Réinitialiser les filtres',
        },
        search_duties: {
            en: 'Search duties...',
            ja: 'コンテンツを検索...',
            de: 'Inhalte suchen...',
            fr: 'Rechercher une mission...',
        },
        members_count: {
            en: 'Members ({count})',
            ja: 'メンバー ({count})',
            de: 'Mitglieder ({count})',
            fr: 'Membres ({count})',
        },
        selected_count: {
            en: '{count} selected',
            ja: '{count} 件選択中',
            de: '{count} ausgewählt',
            fr: '{count} sélectionnés',
        },
        duty_number: {
            en: 'Duty #{id}',
            ja: 'コンテンツ #{id}',
            de: 'Inhalt #{id}',
            fr: 'Mission #{id}',
        },
        roles: {
            en: 'Roles',
            ja: 'ロール',
            de: 'Rollen',
            fr: 'Rôles',
        },
        tank: {
            en: 'Tank',
            ja: 'タンク',
            de: 'Verteidiger',
            fr: 'Tank',
        },
        healer: {
            en: 'Healer',
            ja: 'ヒーラー',
            de: 'Heiler',
            fr: 'Soigneur',
        },
        melee: {
            en: 'Melee',
            ja: '近接',
            de: 'Nahkampf',
            fr: 'Mêlée',
        },
        physical_ranged: {
            en: 'Physical Ranged',
            ja: '遠隔物理',
            de: 'Physischer Fernkampf',
            fr: 'Distant physique',
        },
        magical_ranged: {
            en: 'Magical Ranged',
            ja: '遠隔魔法',
            de: 'Magischer Fernkampf',
            fr: 'Distant magique',
        },
        limited_job: {
            en: 'Limited Job',
            ja: 'リミテッドジョブ',
            de: 'Limitierter Job',
            fr: 'Job limité',
        },
        no_log_data: {
            en: 'No log data',
            ja: 'ログデータなし',
            de: 'Keine Logdaten',
            fr: 'Aucune donnée de log',
        },
        creator: {
            en: 'Creator',
            ja: '募集主',
            de: 'Ersteller',
            fr: 'Créateur',
        },
        created_on: {
            en: 'Created on',
            ja: '作成ワールド',
            de: 'Erstellt auf',
            fr: 'Créé sur',
        },
        expires: {
            en: 'Expires',
            ja: '期限',
            de: 'Läuft ab',
            fr: 'Expire',
        },
        updated: {
            en: 'Updated',
            ja: '更新',
            de: 'Aktualisiert',
            fr: 'Mis à jour',
        },
    };

    const derived = {
        contentOptions: new Map(),
        dataCentreCounts: { all: {}, highEnd: {} },
        searchTextByListing: new WeakMap(),
    };

    let searchDebounceTimer = null;

    function addJsClass() {
        document.documentElement.classList.remove('no-js');
        document.documentElement.classList.add('js');
    }

    function translationEntry(key) {
        const generated = typeof TRANSLATIONS === 'undefined' ? {} : TRANSLATIONS;
        return generated[key] || EXTRA_TRANSLATIONS[key] || null;
    }

    function interpolateTranslation(text, values = {}) {
        return String(text).replace(/\{(\w+)\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match
        ));
    }

    function translate(key, fallback, values = {}) {
        const lang = state.lang || 'en';
        const entry = translationEntry(key);
        const text = entry?.[lang] || entry?.en || fallback || key;
        return interpolateTranslation(text, values);
    }

    function localizedValue(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value;

        const lang = state.lang || 'en';
        return value[lang] || value.en || value.ja || value.de || value.fr || '';
    }

    function listingData() {
        return typeof window !== 'undefined' ? (window.RPF_LISTING_DATA || {}) : {};
    }

    function lookupLocalized(mapName, key) {
        const map = listingData()[mapName] || {};
        return localizedValue(map[String(key)]);
    }

    function seStringText(value) {
        if (!Array.isArray(value)) {
            return localizedValue(value);
        }

        return value.map((payload) => {
            if (!payload || typeof payload !== 'object') return '';

            if (payload.type === 'text') {
                return payload.text || '';
            }

            if (payload.type === 'auto_translate') {
                return lookupLocalized('autoTranslate', `${payload.group}:${payload.key}`);
            }

            return '';
        }).join('');
    }

    function specialDutyName(names) {
        return localizedValue(names);
    }

    function listingDutyName(listing) {
        const dutyId = Number(listing?.duty_id || 0);
        const dutyType = Number(listing?.duty_type || 0);
        const category = Number(listing?.category || 0);

        if (dutyType === 0 && category === 512) {
            return lookupLocalized('territoryNames', dutyId) || specialDutyName({
                en: 'FATEs',
                ja: 'F.A.T.E.',
                de: 'FATEs',
                fr: 'ALÉA',
            });
        }

        if (dutyType === 0 && category === 2048) {
            return specialDutyName({
                en: 'The Hunt',
                ja: 'モブハント',
                de: 'Hohe Jagd',
                fr: 'Contrats de chasse',
            });
        }

        if (category === 0 && dutyId === 0) {
            return specialDutyName({
                en: 'None',
                ja: '設定なし',
                de: 'Nicht festgelegt',
                fr: 'Non spécifiée',
            });
        }

        if (dutyType === 0 && category === 8192) {
            const deepDungeonNames = {
                1: {
                    en: 'The Palace of the Dead',
                    ja: '死者の宮殿',
                    de: 'Palast der Toten',
                    fr: 'Palais des morts',
                },
                2: {
                    en: 'Heaven-on-High',
                    ja: 'アメノミハシラ',
                    de: 'Himmelssäule',
                    fr: 'Pilier des Cieux',
                },
                3: {
                    en: 'Eureka Orthos',
                    ja: 'オルト・エウレカ',
                    de: 'Eureka Orthos',
                    fr: 'Eurêka Orthos',
                },
                4: {
                    en: "Pilgrim's Traverse",
                    ja: 'ピルグリム・トラバース',
                    de: 'Pilgers Pfad',
                    fr: 'Sanctuaire des pèlerins',
                },
            };
            const name = specialDutyName(deepDungeonNames[dutyId]);
            if (name) return name;
        }

        if (dutyType === 2) {
            const name = lookupLocalized('duties', dutyId);
            if (name) return name;
        }

        if (dutyType === 1) {
            const name = lookupLocalized('roulettes', dutyId);
            if (name) return name;
        }

        if (category === 256 && dutyId === 11) {
            return specialDutyName({
                en: 'GATEs',
                ja: 'G.A.T.E.',
                de: 'GATEs',
                fr: 'JACTA',
            });
        }

        if (category === 256 && dutyId >= 12 && dutyId <= 19) {
            let row = 0;
            if (dutyId === 12 || dutyId === 16) {
                row = 21 + (dutyId - 12);
            } else if (dutyId >= 13 && dutyId <= 15) {
                row = 18 + (dutyId - 13);
            } else if (dutyId >= 17 && dutyId <= 19) {
                row = 22 + (dutyId - 17);
            }

            const name = lookupLocalized('roulettes', row);
            if (name) return name;
        }

        if (category === 256 && dutyId >= 20 && dutyId <= 26) {
            const rows = {
                20: 195,
                21: 756,
                22: 199,
                23: 645,
                24: 650,
                25: 768,
                26: 769,
            };
            const name = lookupLocalized('duties', rows[dutyId]);
            if (name) return name;
        }

        if (category === 1024) {
            const name = lookupLocalized('treasureMaps', dutyId);
            if (name) return name;
        }

        return lookupLocalized('duties', dutyId)
            || lookupLocalized('roulettes', dutyId)
            || translate('duty_number', 'Duty #{id}', { id: dutyId });
    }

    const listingsRenderer = createListingsRenderer({
        escapeHtml,
        translate,
        seStringText,
        listingDutyName,
    });
    const {
        renderDescription,
        renderListingCard,
        renderPhaseProgress,
        renderProgressTags,
    } = listingsRenderer;

    function getListings() {
        return Array.isArray(state.snapshot?.listings) ? state.snapshot.listings : [];
    }

    function incrementCount(counts, centre) {
        const key = centre || '';
        counts[key] = (counts[key] || 0) + 1;
    }

    function buildListingSearchText(listing) {
        return [
            listingDutyName(listing),
            seStringText(listing.creator_name),
            seStringText(listing.description),
            listing.data_centre || '',
            listing.created_world?.name || '',
            listing.home_world?.name || '',
        ]
            .join(' ')
            .toLocaleLowerCase();
    }

    function rebuildSnapshotDerivedData() {
        const options = new Map();
        const counts = { all: {}, highEnd: {} };
        const searchTextByListing = new WeakMap();

        for (const container of getListings()) {
            const listing = container.listing || {};
            const dutyId = Number(listing.duty_id);
            if (Number.isFinite(dutyId) && !options.has(dutyId)) {
                options.set(dutyId, listingDutyName(listing));
            }

            const centre = listing.data_centre || '';
            incrementCount(counts.all, centre);
            if (listing.high_end) {
                incrementCount(counts.highEnd, centre);
            }

            searchTextByListing.set(listing, buildListingSearchText(listing));
        }

        derived.contentOptions = new Map(
            [...options.entries()].sort((a, b) => a[1].localeCompare(b[1])),
        );
        derived.dataCentreCounts = counts;
        derived.searchTextByListing = searchTextByListing;
    }

    function normalizeSavedState(saved) {
        state.highEnd = true;

        if (!saved || typeof saved !== 'object') {
            stateWasNull = true;
            return;
        }

        if (typeof saved.centre === 'string') {
            state.centre = saved.centre;
        }

        if (saved.roles !== undefined) {
            try {
                state.roles = BigInt(saved.roles);
            } catch (_) {
                state.roles = 0n;
            }
        }

        if (typeof saved.lang === 'string') {
            state.lang = saved.lang;
        }

        if (typeof saved.objectives === 'number') {
            state.objectives = saved.objectives;
        }

        if (typeof saved.conditions === 'number') {
            state.conditions = saved.conditions;
        }

        if (typeof saved.onePlayerPerJob === 'boolean') {
            state.onePlayerPerJob = saved.onePlayerPerJob;
        }

        if (typeof saved.minItemLevel === 'number') {
            state.minItemLevel = saved.minItemLevel;
        }

        if (Array.isArray(saved.contentTypes)) {
            state.contentTypes = saved.contentTypes
                .map((value) => Number(value))
                .filter(Number.isFinite);
        }

        if (Array.isArray(saved.selectedContents)) {
            state.selectedContents = saved.selectedContents
                .map((value) => Number(value))
                .filter(Number.isFinite);
        }

        if (typeof saved.searchQuery === 'string') {
            state.searchQuery = saved.searchQuery;
        }
    }

    function persistState() {
        detectLanguage();

        const copy = {
            centre: state.centre,
            roles: state.roles.toString(),
            lang: state.lang,
            objectives: state.objectives,
            conditions: state.conditions,
            onePlayerPerJob: state.onePlayerPerJob,
            minItemLevel: state.minItemLevel,
            contentTypes: state.contentTypes,
            selectedContents: state.selectedContents,
            searchQuery: state.searchQuery,
        };

        localStorage.setItem('state', JSON.stringify(copy));
    }

    function saveLoadState() {
        const saved = localStorage.getItem('state');
        if (saved !== null) {
            try {
                normalizeSavedState(JSON.parse(saved));
            } catch (_) {
                stateWasNull = true;
            }
        } else {
            stateWasNull = true;
        }

        window.addEventListener('pagehide', persistState);
    }

    function detectLanguage() {
        const language = document.getElementById('language');
        const cookieMatch = document.cookie.match(/(?:^|; )lang=([^;]*)/);

        if (cookieMatch) {
            state.lang = decodeURIComponent(cookieMatch[1]);
        } else if (language && language.dataset.accept) {
            state.lang = language.dataset.accept;
        } else if (state.lang === null) {
            state.lang = 'en';
        }
    }

    function reflectState() {
        detectLanguage();

        const dataCentre = document.getElementById('data-centre-filter');
        if (dataCentre) {
            dataCentre.value = state.centre;
        }

        const searchInput = document.querySelector('#container .search');
        if (searchInput) {
            searchInput.value = state.searchQuery;
        }

        const roleFilterInputs = document
            .getElementById('role-filter')
            ?.getElementsByTagName('input') || [];
        let newRolesState = 0n;
        for (const input of roleFilterInputs) {
            const value = BigInt(input.value);
            const checked = !stateWasNull && (state.roles & value) !== 0n;
            input.checked = checked;
            if (checked) {
                newRolesState |= value;
            }
        }
        state.roles = newRolesState;

        const objectiveInputs = document
            .getElementById('objective-filter')
            ?.getElementsByTagName('input') || [];
        for (const input of objectiveInputs) {
            const value = Number(input.value);
            input.checked = (state.objectives & value) !== 0;
        }

        const conditionInputs = document
            .getElementById('condition-filter')
            ?.getElementsByTagName('input') || [];
        for (const input of conditionInputs) {
            const value = Number(input.value);
            input.checked = value === 32
                ? state.onePlayerPerJob
                : (state.conditions & value) !== 0;
        }

        const contentTypeInputs = document
            .getElementById('content-type-filter')
            ?.getElementsByTagName('input') || [];
        for (const input of contentTypeInputs) {
            const value = Number(input.value);
            input.checked = state.contentTypes.includes(value);
        }

        const minILInput = document.getElementById('min-il-filter');
        if (minILInput) {
            minILInput.value = state.minItemLevel || 0;
        }

        updateFilterControlsUi();
        persistState();
    }

    function countActiveAdvancedFilters() {
        let count = 0;
        let rolesBits = state.roles;
        while (rolesBits > 0n) {
            if ((rolesBits & 1n) !== 0n) count += 1;
            rolesBits >>= 1n;
        }
        for (const bit of [2, 4, 8]) {
            if ((state.objectives & bit) !== 0) count += 1;
            if ((state.conditions & bit) !== 0) count += 1;
        }
        if (state.onePlayerPerJob) count += 1;
        if (Number(state.minItemLevel) > 0) count += 1;
        count += state.contentTypes.length;
        count += state.selectedContents.length;
        return count;
    }

    function hasActiveAdvancedFilters() {
        return countActiveAdvancedFilters() > 0;
    }

    function setAdvancedFiltersExpanded(expanded) {
        const panel = document.getElementById('advanced-filters-panel');
        const toggle = document.getElementById('advanced-filters-toggle');
        if (panel) {
            panel.classList.toggle('collapsed', !expanded);
        }
        if (toggle) {
            toggle.setAttribute('aria-expanded', String(Boolean(expanded)));
        }
    }

    function updateFilterControlsUi() {
        const activeCount = countActiveAdvancedFilters();
        const badge = document.getElementById('active-filters-badge');
        if (badge) {
            badge.hidden = activeCount === 0;
            badge.textContent = String(activeCount);
        }

        const hasAnyFilter = activeCount > 0
            || Boolean(state.searchQuery)
            || state.centre !== 'All';
        const resetBtn = document.getElementById('reset-filters-btn');
        if (resetBtn) {
            resetBtn.hidden = !hasAnyFilter;
        }

        const roleGroups = document.querySelectorAll('#role-filter .role-group');
        for (const group of roleGroups) {
            const btn = group.querySelector('.role-group-toggle');
            if (!btn) continue;
            const inputs = [...group.querySelectorAll('input[type="checkbox"]')];
            const checkedCount = inputs.filter((input) => input.checked).length;
            const allChecked = inputs.length > 0 && checkedCount === inputs.length;
            const someChecked = checkedCount > 0 && !allChecked;
            btn.setAttribute('aria-pressed', String(allChecked));
            btn.classList.toggle('active', allChecked);
            btn.classList.toggle('partial', someChecked);
        }
    }

    function applyTranslations() {
        document.querySelectorAll('[data-i18n]').forEach((elem) => {
            const key = elem.dataset.i18n;
            elem.textContent = translate(key, elem.textContent);
        });

        const searchInput = document.querySelector('#container .search');
        if (searchInput) {
            searchInput.placeholder = translate('search', 'Search...');
        }

        const dutySearchInput = document.getElementById('content-select-search');
        if (dutySearchInput) {
            dutySearchInput.placeholder = translate('search_duties', 'Search duties...');
        }
    }

    function formatRelativeTime(seconds, lang) {
        const absSeconds = Math.abs(seconds);
        const isFuture = seconds > 0;

        if (absSeconds < 60) {
            return TRANSLATIONS.time_now[lang] || 'now';
        }

        let value;
        let unitKey;
        if (absSeconds < 3600) {
            value = Math.floor(absSeconds / 60);
            unitKey = value === 1 ? 'time_minute' : 'time_minutes';
        } else {
            value = Math.floor(absSeconds / 3600);
            unitKey = value === 1 ? 'time_hour' : 'time_hours';
        }

        const unit = TRANSLATIONS[unitKey]?.[lang] || unitKey.split('_')[1];

        if (lang === 'ja') {
            const suffix = isFuture ? TRANSLATIONS.time_in[lang] : TRANSLATIONS.time_ago[lang];
            return `${value}${unit}${suffix}`;
        }

        if (lang === 'de') {
            return isFuture
                ? `${TRANSLATIONS.time_in[lang]} ${value} ${unit}`
                : `${TRANSLATIONS.time_ago[lang]} ${value} ${unit}`;
        }

        return isFuture
            ? `${TRANSLATIONS.time_in[lang] || 'in'} ${value} ${unit}`
            : `${value} ${unit} ${TRANSLATIONS.time_ago[lang] || 'ago'}`;
    }

    function formatAbsoluteTime(timestamp, lang) {
        const date = new Date(timestamp * 1000);
        const locale = lang === 'ja' ? 'ja-JP'
            : lang === 'de' ? 'de-DE'
                : lang === 'fr' ? 'fr-FR'
                    : 'en-US';
        return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    }

    function updateTimeDisplays() {
        const lang = state.lang || 'en';
        const now = nowSeconds();

        if (pruneExpiredListings(state.snapshot, now)) {
            rebuildSnapshotDerivedData();
            applyFiltersAndRender();
            return;
        }

        document.querySelectorAll('.item.expires').forEach((elem) => {
            const expiresIn = elem.dataset.expiresAt
                ? secondsUntilListingExpiry({ expires_at_timestamp: elem.dataset.expiresAt }, now)
                : secondsUntilListingExpiry({ time_left_seconds: elem.dataset.expiresIn }, now);
            const textSpan = elem.querySelector('.text');
            if (!textSpan || Number.isNaN(expiresIn)) return;

            textSpan.textContent = formatRelativeTime(expiresIn, lang);
            const expiresAt = Number(elem.dataset.expiresAt) || now + expiresIn;
            elem.title = `${translate('expires_at', 'Expires at')}: ${formatAbsoluteTime(expiresAt, lang)}`;
        });

        document.querySelectorAll('.item.updated[data-updated-at]').forEach((elem) => {
            const updatedAt = Number(elem.dataset.updatedAt);
            const textSpan = elem.querySelector('.text');
            if (!textSpan || Number.isNaN(updatedAt)) return;

            const secondsAgo = now - updatedAt;
            textSpan.textContent = formatRelativeTime(-secondsAgo, lang);
            elem.title = `${translate('updated_at', 'Updated at')}: ${formatAbsoluteTime(updatedAt, lang)}`;
        });
    }

    function listingOptionMap() {
        return derived.contentOptions;
    }

    function getSelectedContentLabel(dutyId) {
        const options = listingOptionMap();
        return options.get(dutyId) || translate('duty_number', 'Duty #{id}', { id: dutyId });
    }

    function selectedCountLabel(count) {
        return translate('selected_count', '{count} selected', { count });
    }

    function updateDataCentreCounts() {
        const select = document.getElementById('data-centre-filter');
        if (!select) return;

        const counts = derived.dataCentreCounts.highEnd;

        for (const opt of select.options) {
            const centre = opt.value;
            if (!opt.dataset.label) {
                opt.dataset.label = opt.textContent.replace(/\s+\(\d+\)$/, '');
            }

            let count = counts[centre] || 0;
            if (centre === 'All') {
                count = Object.values(counts).reduce((sum, value) => sum + value, 0);
            }

            opt.textContent = `${opt.dataset.label} (${count})`;
        }
    }

    function listingSearchText(listing) {
        return derived.searchTextByListing.get(listing) || buildListingSearchText(listing);
    }

    function listingMatchesFilters(container) {
        return matchesListingFilters(container, state, listingSearchText(container.listing));
    }

    function paginationModel(totalPages, currentPage) {
        if (totalPages <= 7) {
            return Array.from({ length: totalPages }, (_, index) => index + 1);
        }

        const pages = [1];
        const start = Math.max(2, currentPage - 1);
        const end = Math.min(totalPages - 1, currentPage + 1);

        if (start > 2) {
            pages.push(ELLIPSIS);
        }

        for (let page = start; page <= end; page += 1) {
            pages.push(page);
        }

        if (end < totalPages - 1) {
            pages.push(ELLIPSIS);
        }

        pages.push(totalPages);
        return pages;
    }

    function renderPagination() {
        const pagination = document.querySelector('.pagination');
        const prev = document.querySelector('.page-btn.prev');
        const next = document.querySelector('.page-btn.next');
        if (!pagination || !prev || !next) return;

        const controls = pagination.closest('.pagination-controls');
        const totalPages = Math.max(1, Math.ceil(state.filteredListings.length / state.pageSize));
        const currentPage = Math.min(state.page, totalPages);
        state.page = currentPage;

        if (controls) {
            controls.hidden = totalPages <= 1;
            controls.style.display = totalPages <= 1 ? 'none' : '';
        }

        prev.classList.toggle('disabled', currentPage <= 1);
        next.classList.toggle('disabled', currentPage >= totalPages);

        const items = paginationModel(totalPages, currentPage)
            .map((page) => {
                if (page === ELLIPSIS) {
                    return '<li class="disabled"><a href="#listings" tabindex="-1" aria-disabled="true">...</a></li>';
                }

                const active = page === currentPage ? ' class="active"' : '';
                return `<li${active}><a href="#listings" data-page="${page}">${page}</a></li>`;
            })
            .join('');

        pagination.innerHTML = totalPages > 1 ? items : '';
    }

    function renderSelectedTags() {
        const selectedEl = document.getElementById('selected-contents');
        const trigger = document.getElementById('content-select-trigger');
        if (!selectedEl || !trigger) return;

        selectedEl.innerHTML = '';
        for (const dutyId of state.selectedContents) {
            const label = getSelectedContentLabel(dutyId);
            const tag = document.createElement('span');
            tag.className = 'selected-content-tag';
            tag.innerHTML = `${escapeHtml(label)}<span class="remove-btn">✕</span>`;
            tag.querySelector('.remove-btn').addEventListener('click', () => {
                state.selectedContents = state.selectedContents.filter((value) => value !== dutyId);
                state.page = 1;
                renderSelectedTags();
                renderContentSelectOptions();
                applyFiltersAndRender();
            });
            selectedEl.appendChild(tag);
        }

        const triggerText = trigger.querySelector('span');
        if (!triggerText) return;
        if (state.selectedContents.length > 0) {
            triggerText.textContent = selectedCountLabel(state.selectedContents.length);
        } else {
            triggerText.textContent = translate('select_content', 'Select Content...');
        }
    }

    function filterContentSelectItems() {
        const listEl = document.getElementById('content-select-list');
        const searchEl = document.getElementById('content-select-search');
        if (!listEl) return;

        const query = (searchEl?.value || '').trim().toLowerCase();
        for (const item of listEl.querySelectorAll('.content-select-item')) {
            const labelText = item.textContent.trim().toLowerCase();
            item.classList.toggle('hidden', Boolean(query) && !labelText.includes(query));
        }
    }

    function renderContentSelectOptions() {
        const listEl = document.getElementById('content-select-list');
        if (!listEl) return;

        const options = listingOptionMap();
        listEl.innerHTML = '';

        for (const [dutyId, label] of options.entries()) {
            const item = document.createElement('label');
            item.className = 'content-select-item';
            item.innerHTML = `
                <input type="checkbox" value="${dutyId}" ${state.selectedContents.includes(dutyId) ? 'checked' : ''}>
                <span>${escapeHtml(label)}</span>
            `;
            listEl.appendChild(item);
        }

        filterContentSelectItems();
    }

    function updateEmptyStates(totalListings, filteredListings) {
        const bootstrapStatus = document.getElementById('listings-bootstrap-status');
        const noListings = document.getElementById('server-no-listings');
        const noFilterResults = document.getElementById('filter-no-listings');

        if (bootstrapStatus) {
            bootstrapStatus.style.display = 'none';
        }

        if (noListings) {
            noListings.style.display = totalListings === 0 ? 'block' : 'none';
        }

        if (noFilterResults) {
            noFilterResults.style.display = totalListings > 0 && filteredListings === 0 ? 'block' : 'none';
        }
    }

    function setServerUnavailable(unavailable) {
        const container = document.getElementById('container');
        if (!container) return;

        container.classList.toggle('server-unavailable', unavailable);
    }

    function setBootstrapStatus(key, fallback, options = {}) {
        if (state.snapshot !== null && !options.force) return;

        const bootstrapStatus = document.getElementById('listings-bootstrap-status');
        if (!bootstrapStatus) return;

        bootstrapStatus.dataset.i18n = key;
        bootstrapStatus.textContent = translate(key, fallback);
        bootstrapStatus.style.display = 'block';
    }

    function hashSignatureInto(hash, value) {
        const text = String(value ?? '');
        let next = hash;
        for (let i = 0; i < text.length; i += 1) {
            next ^= text.charCodeAt(i);
            next = Math.imul(next, 0x01000193);
        }
        next ^= 0x1f;
        return Math.imul(next, 0x01000193);
    }

    function parseRenderMarker(parse) {
        if (!parse) return '0';
        return [
            parse.hidden ? 1 : 0,
            parse.originally_hidden ? 1 : 0,
            parse.has_secondary ? 1 : 0,
            parse.estimated ? 1 : 0,
            parse.primary_percentile ?? '',
            parse.primary_color_class ?? '',
            parse.secondary_percentile ?? '',
            parse.secondary_color_class ?? '',
        ].join(':');
    }

    function progressRenderDigest(progress) {
        if (!progress) return '0';
        let hash = 0x811c9dc5;
        hash = hashSignatureInto(hash, progress.final_clear_count ?? '');
        hash = hashSignatureInto(hash, progress.final_boss_percentage ?? '');
        hash = hashSignatureInto(hash, progress.final_boss_phase ?? '');
        const phases = Array.isArray(progress.phase_progress) ? progress.phase_progress : [];
        hash = hashSignatureInto(hash, phases.length);
        for (let i = 0; i < phases.length; i += 1) {
            const phase = phases[i];
            hash = hashSignatureInto(hash, phase?.phase_key ?? '');
            hash = hashSignatureInto(hash, phase?.phase_name ?? '');
            hash = hashSignatureInto(hash, phase?.order ?? '');
            hash = hashSignatureInto(hash, phase?.boss_percentage ?? '');
            hash = hashSignatureInto(hash, phase?.display_text ?? '');
            hash = hashSignatureInto(hash, phase?.source ?? '');
        }
        return (hash >>> 0).toString(36);
    }

    function slotsRenderDigest(displaySlots) {
        const slots = Array.isArray(displaySlots) ? displaySlots : [];
        let hash = 0x811c9dc5;
        hash = hashSignatureInto(hash, slots.length);
        for (let i = 0; i < slots.length; i += 1) {
            const slot = slots[i];
            hash = hashSignatureInto(hash, slot?.filled ? 1 : 0);
            hash = hashSignatureInto(hash, slot?.icon_code ?? '');
            hash = hashSignatureInto(hash, slot?.role_class ?? '');
            hash = hashSignatureInto(hash, slot?.title ?? '');
        }
        return (hash >>> 0).toString(36);
    }

    function membersRenderDigest(members) {
        const list = Array.isArray(members) ? members : [];
        let hash = 0x811c9dc5;
        hash = hashSignatureInto(hash, list.length);
        for (let i = 0; i < list.length; i += 1) {
            const member = list[i];
            hash = hashSignatureInto(hash, member?.name ?? '');
            hash = hashSignatureInto(hash, member?.home_world?.name ?? '');
            hash = hashSignatureInto(hash, member?.job_id ?? '');
            hash = hashSignatureInto(hash, member?.job_code ?? '');
            hash = hashSignatureInto(hash, member?.role_class ?? '');
            hash = hashSignatureInto(hash, member?.party_index ?? '');
            hash = hashSignatureInto(hash, member?.slot_index ?? '');
            hash = hashSignatureInto(hash, member?.fflogs_character_url ?? '');
            hash = hashSignatureInto(hash, parseRenderMarker(member?.parse));
            hash = hashSignatureInto(hash, progressRenderDigest(member?.progress));
        }
        return `${list.length}:${(hash >>> 0).toString(36)}`;
    }

    function descriptionRenderDigest(listing) {
        let hash = 0x811c9dc5;
        hash = hashSignatureInto(hash, seStringText(listing.description));
        hash = hashSignatureInto(hash, listing.description_badge_class ?? '');
        const badges = Array.isArray(listing.description_badges) ? listing.description_badges : [];
        hash = hashSignatureInto(hash, badges.length);
        for (let i = 0; i < badges.length; i += 1) {
            hash = hashSignatureInto(hash, badges[i] ?? '');
        }
        return (hash >>> 0).toString(36);
    }

    function listingRenderSignature(container) {
        const listing = container?.listing || {};
        return [
            listing.id ?? '',
            listing.duty_id ?? '',
            listing.duty_type ?? '',
            listing.category ?? '',
            listing.cross_world ? 1 : 0,
            listing.data_centre ?? '',
            listing.min_item_level ?? 0,
            listing.num_parties ?? 0,
            listing.slots_available ?? listing.slot_count ?? 0,
            listing.slots_filled_count ?? 0,
            listing.high_end ? 1 : 0,
            listing.is_alliance_view ? 1 : 0,
            listing.objective_bits ?? 0,
            listing.conditions_bits ?? 0,
            listing.search_area_bits ?? 0,
            listing.content_kind ?? 0,
            listing.joinable_roles ?? 0,
            state.lang || 'en',
            seStringText(listing.creator_name),
            listing.home_world?.name ?? '',
            listing.created_world?.name ?? '',
            descriptionRenderDigest(listing),
            slotsRenderDigest(listing.display_slots),
            parseRenderMarker(listing.leader_parse),
            membersRenderDigest(listing.members),
        ].join('|');
    }

    function renderListingsPage() {
        const listingsEl = document.getElementById('listings');
        if (!listingsEl) return;

        const start = (state.page - 1) * state.pageSize;
        const end = start + state.pageSize;
        const pageItems = state.filteredListings.slice(start, end);
        const existingByKey = new Map(
            [...listingsEl.children]
                .filter((element) => element.dataset.listingKey)
                .map((element) => [element.dataset.listingKey, element]),
        );
        const fallbackKeyCounts = new Map();
        const cards = pageItems.map((container) => {
            const listingId = container.listing?.id;
            const fallbackKey = JSON.stringify([
                container.listing?.creator_name,
                container.listing?.home_world?.name,
                container.listing?.created_world?.name,
                container.listing?.duty_id,
                container.listing?.duty_type,
                container.listing?.category,
                container.listing?.description,
            ]);
            const fallbackOccurrence = fallbackKeyCounts.get(fallbackKey) || 0;
            fallbackKeyCounts.set(fallbackKey, fallbackOccurrence + 1);
            const listingKey = listingId === null || listingId === undefined
                ? `fallback:${fallbackKey}:${fallbackOccurrence}`
                : String(listingId);
            const existing = existingByKey.get(listingKey);
            const signature = listingRenderSignature(container);

            if (existing && existing.dataset.renderSignature === signature) {
                updateListingCardTimes(existing, container);
                existingByKey.delete(listingKey);
                return existing;
            }

            const template = document.createElement('template');
            template.innerHTML = renderListingCard(container).trim();
            const card = template.content.firstElementChild;
            if (!card) return null;

            card.dataset.listingKey = listingKey;
            card.dataset.renderSignature = signature;
            if (existing) {
                preserveExternalSvgNodes(existing, card);
                existingByKey.delete(listingKey);
            }
            return card;
        }).filter(Boolean);

        for (let index = 0; index < cards.length; index++) {
            const card = cards[index];
            const current = listingsEl.children[index] || null;
            if (current !== card) {
                listingsEl.insertBefore(card, current);
            }
        }
        while (listingsEl.children.length > cards.length) {
            listingsEl.lastElementChild.remove();
        }
        updateEmptyStates(getListings().length, state.filteredListings.length);
        renderPagination();
        updateDataCentreCounts();
        applyTranslations();
        updateTimeDisplays();
    }

    function updateListingCardTimes(card, container) {
        const expires = card.querySelector('.expires');
        if (expires) {
            expires.dataset.expiresIn = String(container.time_left_seconds || 0);
            const expiresAt = Number(container.expires_at_timestamp);
            if (Number.isFinite(expiresAt)) {
                expires.dataset.expiresAt = String(expiresAt);
            } else {
                delete expires.dataset.expiresAt;
            }
        }

        const updated = card.querySelector('.updated');
        if (updated) {
            updated.dataset.updatedAt = String(container.updated_at_timestamp || 0);
        }
    }

    function preserveExternalSvgNodes(previousCard, nextCard) {
        const iconKey = (svg) => {
            const href = svg.querySelector('use')?.getAttribute('href');
            if (!href) return null;

            const memberRow = svg.closest('.member-row');
            if (memberRow) {
                return `member:${memberRow.dataset.partyIndex}:${memberRow.dataset.slotIndex}:${href}`;
            }

            const slot = svg.closest('.party-slots .slot');
            if (slot) {
                return `slot:${slot.dataset.slotIndex}:${href}`;
            }

            const metaItem = svg.closest('.meta .item');
            if (metaItem) {
                return `meta:${[...metaItem.classList].sort().join('.')}:${href}`;
            }

            return null;
        };

        const previousIcons = new Map();
        for (const svg of previousCard.querySelectorAll('svg')) {
            const key = iconKey(svg);
            if (key) previousIcons.set(key, svg);
        }

        for (const svg of nextCard.querySelectorAll('svg')) {
            const key = iconKey(svg);
            const previous = key ? previousIcons.get(key) : null;
            if (previous) svg.replaceWith(previous);
        }
    }

    function applyFiltersAndRender() {
        state.filteredListings = getListings().filter(listingMatchesFilters);
        const totalPages = Math.max(1, Math.ceil(state.filteredListings.length / state.pageSize));
        state.page = Math.min(Math.max(1, state.page), totalPages);
        updateFilterControlsUi();
        renderListingsPage();
    }

    function normalizeRevisionEpoch(value) {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : null;
    }

    function computeSnapshotPayloadStamp(snapshot) {
        const listings = Array.isArray(snapshot?.listings) ? snapshot.listings : [];
        const first = listings[0]?.listing;
        const last = listings.length > 0 ? listings[listings.length - 1]?.listing : null;
        return `${snapshot?.revision ?? ''}|${listings.length}|${first?.id ?? ''}|${last?.id ?? ''}`;
    }

    function isTargetAheadOfLoaded() {
        if (liveUpdates.targetEpoch) {
            if (!liveUpdates.revisionEpoch || liveUpdates.targetEpoch > liveUpdates.revisionEpoch) {
                return true;
            }
            if (liveUpdates.targetEpoch < liveUpdates.revisionEpoch) {
                return false;
            }
        }
        return Number(liveUpdates.targetRevision || 0) > Number(liveUpdates.revision || 0);
    }

    function shouldAcceptRevisionTarget(nextRevision, nextEpoch) {
        const revision = Number(nextRevision);
        if (!Number.isFinite(revision) || revision < 0) return false;
        const epoch = normalizeRevisionEpoch(nextEpoch);
        if (epoch) {
            if (!liveUpdates.targetEpoch || epoch > liveUpdates.targetEpoch) {
                return true;
            }
            if (epoch < liveUpdates.targetEpoch) {
                return false;
            }
            return revision > Number(liveUpdates.targetRevision || 0);
        }
        if (liveUpdates.targetEpoch) {
            return false;
        }
        return revision > Number(liveUpdates.targetRevision || 0);
    }

    function setSnapshot(snapshot, preservePage, meta = {}) {
        applySnapshotExpiryTimestamps(snapshot);
        state.snapshot = snapshot;
        rebuildSnapshotDerivedData();

        const prevLoadedRevision = Number(liveUpdates.revision || 0);
        const prevLoadedEpoch = liveUpdates.revisionEpoch || null;
        const prevEtag = liveUpdates.snapshotEtag || null;
        const prevPayloadStamp = liveUpdates.snapshotPayloadStamp || null;

        const snapRevision = typeof snapshot?.revision === 'number' && Number.isFinite(snapshot.revision)
            ? snapshot.revision
            : null;
        const snapEpoch = normalizeRevisionEpoch(snapshot?.revision_epoch ?? snapshot?.epoch);
        const nextEtag = normalizeRevisionEpoch(meta.responseEtag);
        const nextPayloadStamp = computeSnapshotPayloadStamp(snapshot);
        const etagChanged = Boolean(prevEtag && nextEtag && prevEtag !== nextEtag);
        const payloadChanged = Boolean(prevPayloadStamp && prevPayloadStamp !== nextPayloadStamp);

        if (nextEtag) {
            liveUpdates.snapshotEtag = nextEtag;
        }
        liveUpdates.snapshotPayloadStamp = nextPayloadStamp;
        liveUpdates.lastSnapshotAtMs = Date.now();
        liveUpdates.refreshFailureCount = 0;

        if (snapRevision !== null) {
            liveUpdates.revision = snapRevision;
            liveUpdates.revisionEpoch = snapEpoch;

            const targetChangedMidFlight = meta.startedTargetRevision !== undefined
                && (
                    liveUpdates.targetEpoch !== (meta.startedTargetEpoch ?? null)
                    || liveUpdates.targetRevision !== meta.startedTargetRevision
                );

            if (snapEpoch) {
                if (!liveUpdates.targetEpoch || snapEpoch > liveUpdates.targetEpoch) {
                    liveUpdates.targetEpoch = snapEpoch;
                    liveUpdates.targetRevision = snapRevision;
                } else if (snapEpoch === liveUpdates.targetEpoch) {
                    if (!targetChangedMidFlight || snapRevision > Number(liveUpdates.targetRevision || 0)) {
                        liveUpdates.targetRevision = snapRevision;
                    }
                } else if (!targetChangedMidFlight && prevLoadedEpoch && snapEpoch !== prevLoadedEpoch && etagChanged) {
                    liveUpdates.targetEpoch = snapEpoch;
                    liveUpdates.targetRevision = snapRevision;
                }
            } else {
                const isEpochlessReset = prevLoadedRevision > 0
                    && snapRevision < prevLoadedRevision
                    && (etagChanged || payloadChanged || !targetChangedMidFlight);
                if (isEpochlessReset || !targetChangedMidFlight) {
                    liveUpdates.targetEpoch = null;
                    liveUpdates.targetRevision = snapRevision;
                } else if (snapRevision > Number(liveUpdates.targetRevision || 0)) {
                    liveUpdates.targetRevision = snapRevision;
                }
            }
        }

        if (!preservePage) {
            state.page = 1;
        }
        renderContentSelectOptions();
        renderSelectedTags();
        applyFiltersAndRender();
    }

    function computeBackoffDelayMs(attempt, baseMs = 1000, maxMs = 30000) {
        const exponential = Math.min(maxMs, baseMs * (2 ** attempt));
        const jitterFactor = 0.75 + (Math.random() * 0.5);
        return Math.max(250, Math.round(exponential * jitterFactor));
    }

    function scheduleSnapshotRetry() {
        const retryDelay = computeBackoffDelayMs(liveUpdates.refreshFailureCount);
        liveUpdates.refreshFailureCount = Math.min(liveUpdates.refreshFailureCount + 1, 5);
        scheduleListingsRefresh(retryDelay);
    }

    async function fetchSnapshot(preservePage = true) {
        if (liveUpdates.refreshing) {
            liveUpdates.pendingRefresh = true;
            return;
        }

        liveUpdates.refreshing = true;
        let shouldRetry = false;
        const startedTargetEpoch = liveUpdates.targetEpoch;
        const startedTargetRevision = liveUpdates.targetRevision;
        try {
            setBootstrapStatus('loading_listings', 'Loading listings...');
            const response = await fetch('/api/listings/snapshot', {
                cache: 'no-cache',
                credentials: 'same-origin',
            });
            if (!response.ok) {
                if (response.status === 503) {
                    setServerUnavailable(true);
                    setBootstrapStatus(
                        'service_unavailable',
                        'The Remote Party Finder Reborn server is temporarily unavailable. Please try again later.',
                        { force: true },
                    );
                } else {
                    setServerUnavailable(false);
                    setBootstrapStatus('listings_refresh_failed', 'Unable to load listings. Retrying...');
                }
                shouldRetry = true;
                return;
            }

            const responseEtag = typeof response.headers?.get === 'function'
                ? response.headers.get('etag')
                : null;
            const snapshot = await response.json();
            setServerUnavailable(false);
            setSnapshot(snapshot, preservePage, {
                startedTargetEpoch,
                startedTargetRevision,
                responseEtag,
            });
            shouldRetry = isTargetAheadOfLoaded();
        } catch (error) {
            console.debug('live listings refresh failed', error);
            setBootstrapStatus('listings_refresh_failed', 'Unable to load listings. Retrying...');
            shouldRetry = true;
        } finally {
            liveUpdates.refreshing = false;
            if (document.visibilityState !== 'hidden') {
                if (liveUpdates.pendingRefresh) {
                    liveUpdates.pendingRefresh = false;
                    scheduleListingsRefresh(500);
                } else if (shouldRetry) {
                    scheduleSnapshotRetry();
                }
            }
        }
    }

    async function pollListingsRevision() {
        if (document.visibilityState === 'hidden') return;
        liveUpdates.lastRevisionPollAtMs = Date.now();

        try {
            const response = await fetch('/api/listings/revision', {
                cache: 'no-store',
                credentials: 'same-origin',
            });
            if (!response.ok) return;

            const body = await response.json();
            if (body?.revision === null || body?.revision === undefined) return;
            const revision = Number(body.revision);
            const epoch = normalizeRevisionEpoch(body?.revision_epoch ?? body?.epoch);
            if (!shouldAcceptRevisionTarget(revision, epoch)) return;

            liveUpdates.targetRevision = revision;
            if (epoch) {
                liveUpdates.targetEpoch = epoch;
            }
            scheduleListingsRefresh(0);
        } catch (error) {
            console.debug('live listings revision poll failed', error);
        }
    }

    function isLiveSocketOpen() {
        const activeSocket = liveUpdates.ws || liveUpdates.socket;
        const openState = typeof WebSocket !== 'undefined' ? WebSocket.OPEN : 1;
        return Boolean(activeSocket && activeSocket.readyState === openState);
    }

    function shouldRunRevisionPoll(nowMs = Date.now()) {
        if (document.visibilityState === 'hidden') return false;
        if (!isLiveSocketOpen()) return true;
        const lastActivity = Math.max(
            Number(liveUpdates.lastWsEventAtMs || 0),
            Number(liveUpdates.lastRevisionPollAtMs || 0),
        );
        if (lastActivity <= 0) return true;
        return (nowMs - lastActivity) >= WS_SILENT_BACKSTOP_INTERVAL_MS;
    }

    function scheduleLiveSnapshotFetch() {
        const delay = 150 + Math.floor(Math.random() * 450);
        scheduleListingsRefresh(delay);
    }

    function scheduleListingsRefresh(delay = 500) {
        if (document.visibilityState === 'hidden') {
            liveUpdates.pendingRefresh = true;
            return;
        }

        if (liveUpdates.refreshTimer !== null) {
            if (liveUpdates.refreshTimerDelay !== null && delay >= liveUpdates.refreshTimerDelay) {
                return;
            }
            window.clearTimeout(liveUpdates.refreshTimer);
        }

        liveUpdates.refreshTimerDelay = delay;
        liveUpdates.refreshTimer = window.setTimeout(() => {
            liveUpdates.refreshTimer = null;
            liveUpdates.refreshTimerDelay = null;
            fetchSnapshot(true);
        }, delay);
    }

    function scheduleLiveReconnect() {
        if (liveUpdates.paused) return;
        window.clearTimeout(liveUpdates.retryTimer);
        const retryDelay = computeBackoffDelayMs(liveUpdates.retryAttempt);
        liveUpdates.retryAttempt = Math.min(liveUpdates.retryAttempt + 1, 5);
        liveUpdates.retryTimer = window.setTimeout(connectLiveUpdates, retryDelay);
    }

    function connectLiveUpdates() {
        if (!('WebSocket' in window)) return;
        if (liveUpdates.paused || document.visibilityState === 'hidden') return;
        const currentSocket = liveUpdates.ws || liveUpdates.socket;
        if (currentSocket && currentSocket.readyState <= WebSocket.OPEN) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
        liveUpdates.socket = socket;
        liveUpdates.ws = socket;
        liveUpdates.lastWsEventAtMs = Date.now();

        socket.addEventListener('open', () => {
            liveUpdates.retryAttempt = 0;
            liveUpdates.lastWsEventAtMs = Date.now();
            socket.send(JSON.stringify({ type: 'subscribe', channel: 'listing_changes' }));
        });

        socket.addEventListener('message', (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'listings_revision_changed') {
                    liveUpdates.lastWsEventAtMs = Date.now();
                    const epoch = normalizeRevisionEpoch(message?.revision_epoch ?? message?.epoch);
                    if (message.revision !== undefined && message.revision !== null) {
                        const revision = Number(message.revision);
                        if (!shouldAcceptRevisionTarget(revision, epoch)) return;
                        liveUpdates.targetRevision = revision;
                        if (epoch) {
                            liveUpdates.targetEpoch = epoch;
                        }
                    } else if (epoch && (!liveUpdates.targetEpoch || epoch > liveUpdates.targetEpoch)) {
                        liveUpdates.targetEpoch = epoch;
                    } else {
                        return;
                    }
                    scheduleLiveSnapshotFetch();
                }
            } catch (error) {
                console.debug('ignored live listings message', error);
            }
        });

        socket.addEventListener('close', () => {
            if (liveUpdates.socket === socket || liveUpdates.ws === socket) {
                liveUpdates.socket = null;
                liveUpdates.ws = null;
                if (!liveUpdates.paused) {
                    scheduleLiveReconnect();
                }
            }
        });

        socket.addEventListener('error', () => {
            socket.close();
        });
    }

    function setUpSearch() {
        const searchInput = document.querySelector('#container .search');
        if (!searchInput) return;
        searchInput.addEventListener('input', (event) => {
            state.searchQuery = event.target.value.trim();
            state.page = 1;
            if (searchDebounceTimer !== null) {
                window.clearTimeout(searchDebounceTimer);
            }
            searchDebounceTimer = window.setTimeout(() => {
                searchDebounceTimer = null;
                applyFiltersAndRender();
            }, 150);
        });
    }

    function setUpDataCentreFilter() {
        const select = document.getElementById('data-centre-filter');
        if (!select) return;
        select.addEventListener('change', () => {
            state.centre = select.value;
            state.page = 1;
            applyFiltersAndRender();
        });
    }

    function setUpRoleFilter() {
        const filter = document.getElementById('role-filter');
        if (!filter) return;
        filter.addEventListener('change', (event) => {
            if (event.target.tagName !== 'INPUT') return;
            const value = BigInt(event.target.value);
            if (event.target.checked) {
                state.roles |= value;
            } else {
                state.roles &= ~value;
            }
            state.page = 1;
            applyFiltersAndRender();
        });

        filter.addEventListener('click', (event) => {
            const toggleBtn = event.target.closest('.role-group-toggle');
            if (!toggleBtn) return;
            const group = toggleBtn.closest('.role-group');
            if (!group) return;
            const inputs = [...group.querySelectorAll('input[type="checkbox"]')];
            if (inputs.length === 0) return;

            const shouldCheck = !inputs.every((input) => input.checked);
            for (const input of inputs) {
                input.checked = shouldCheck;
                const value = BigInt(input.value);
                if (shouldCheck) {
                    state.roles |= value;
                } else {
                    state.roles &= ~value;
                }
            }
            state.page = 1;
            applyFiltersAndRender();
        });
    }

    function setUpAdvancedFilters() {
        const toggleBtn = document.getElementById('advanced-filters-toggle');
        const panel = document.getElementById('advanced-filters-panel');
        if (toggleBtn && panel) {
            toggleBtn.addEventListener('click', () => {
                setAdvancedFiltersExpanded(panel.classList.contains('collapsed'));
            });
        }

        const resetBtn = document.getElementById('reset-filters-btn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                if (searchDebounceTimer !== null) {
                    window.clearTimeout(searchDebounceTimer);
                    searchDebounceTimer = null;
                }
                state.searchQuery = '';
                state.centre = 'All';
                state.roles = 0n;
                state.objectives = 0;
                state.conditions = 0;
                state.onePlayerPerJob = false;
                state.minItemLevel = 0;
                state.contentTypes = [];
                state.selectedContents = [];
                state.page = 1;
                stateWasNull = true;
                reflectState();
                stateWasNull = false;
                renderSelectedTags();
                renderContentSelectOptions();
                applyFiltersAndRender();
            });
        }

        const minILFilter = document.getElementById('min-il-filter');
        if (minILFilter) {
            minILFilter.addEventListener('input', (event) => {
                let value = Number(event.target.value);
                if (!Number.isFinite(value) || value < 0) value = 0;
                state.minItemLevel = value;
                state.page = 1;
                applyFiltersAndRender();
            });
        }

        const objectiveFilter = document.getElementById('objective-filter');
        if (objectiveFilter) {
            objectiveFilter.addEventListener('change', (event) => {
                if (event.target.tagName !== 'INPUT') return;
                const value = Number(event.target.value);
                if (event.target.checked) {
                    state.objectives |= value;
                } else {
                    state.objectives &= ~value;
                }
                state.page = 1;
                applyFiltersAndRender();
            });
        }

        const conditionFilter = document.getElementById('condition-filter');
        if (conditionFilter) {
            conditionFilter.addEventListener('change', (event) => {
                if (event.target.tagName !== 'INPUT') return;
                const value = Number(event.target.value);
                if (value === 32) {
                    state.onePlayerPerJob = event.target.checked;
                } else if (event.target.checked) {
                    state.conditions |= value;
                } else {
                    state.conditions &= ~value;
                }
                state.page = 1;
                applyFiltersAndRender();
            });
        }

        const contentTypeFilter = document.getElementById('content-type-filter');
        if (contentTypeFilter) {
            contentTypeFilter.addEventListener('change', (event) => {
                if (event.target.tagName !== 'INPUT') return;
                const value = Number(event.target.value);
                if (event.target.checked) {
                    if (!state.contentTypes.includes(value)) {
                        state.contentTypes.push(value);
                    }
                } else {
                    state.contentTypes = state.contentTypes.filter((entry) => entry !== value);
                }
                state.page = 1;
                applyFiltersAndRender();
            });
        }
    }

    function setUpContentSelect() {
        const trigger = document.getElementById('content-select-trigger');
        const container = trigger?.closest('.content-select-container');
        const dropdown = document.getElementById('content-select-dropdown');
        const listEl = document.getElementById('content-select-list');
        const searchEl = document.getElementById('content-select-search');
        if (!trigger || !container || !dropdown || !listEl) return;

        trigger.addEventListener('click', () => {
            const isOpen = container.classList.toggle('open');
            trigger.setAttribute('aria-expanded', String(isOpen));
            if (isOpen) {
                renderContentSelectOptions();
                if (searchEl) {
                    searchEl.focus();
                }
            }
        });

        if (searchEl) {
            searchEl.addEventListener('input', filterContentSelectItems);
            searchEl.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    container.classList.remove('open');
                    trigger.setAttribute('aria-expanded', 'false');
                    trigger.focus();
                }
            });
        }

        document.addEventListener('click', (event) => {
            if (!container.contains(event.target)) {
                container.classList.remove('open');
                trigger.setAttribute('aria-expanded', 'false');
            }
        });

        listEl.addEventListener('change', (event) => {
            if (event.target.type !== 'checkbox') return;
            const dutyId = Number(event.target.value);
            if (!Number.isFinite(dutyId)) return;

            if (event.target.checked) {
                if (!state.selectedContents.includes(dutyId)) {
                    state.selectedContents.push(dutyId);
                }
            } else {
                state.selectedContents = state.selectedContents.filter((value) => value !== dutyId);
            }

            state.page = 1;
            renderSelectedTags();
            applyFiltersAndRender();
        });
    }

    function scrollToListingsTop() {
        const listingsEl = document.getElementById('listings');
        if (listingsEl && typeof listingsEl.scrollIntoView === 'function') {
            listingsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } else {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        }
    }

    function setUpPaginationControls() {
        const pagination = document.querySelector('.pagination');
        const prev = document.querySelector('.page-btn.prev');
        const next = document.querySelector('.page-btn.next');
        if (!pagination || !prev || !next) return;

        pagination.addEventListener('click', (event) => {
            const pageLink = event.target.closest('a[data-page]');
            if (!pageLink) return;
            event.preventDefault();
            const page = Number(pageLink.dataset.page);
            if (!Number.isFinite(page)) return;
            state.page = page;
            renderListingsPage();
            scrollToListingsTop();
        });

        prev.addEventListener('click', (event) => {
            event.preventDefault();
            if (state.page <= 1) return;
            state.page -= 1;
            renderListingsPage();
            scrollToListingsTop();
        });

        next.addEventListener('click', (event) => {
            event.preventDefault();
            const totalPages = Math.max(1, Math.ceil(state.filteredListings.length / state.pageSize));
            if (state.page >= totalPages) return;
            state.page += 1;
            renderListingsPage();
            scrollToListingsTop();
        });
    }

    function setupScrollToTop() {
        const btn = document.getElementById('scroll-to-top');
        if (!btn) return;

        window.addEventListener('scroll', () => {
            if (window.scrollY > 300) {
                btn.classList.add('visible');
            } else {
                btn.classList.remove('visible');
            }
        });

        btn.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
        });
    }

    function handleVisibilityChange() {
        if (document.visibilityState === 'hidden') {
            liveUpdates.paused = true;
            if (liveUpdates.refreshTimer !== null) {
                window.clearTimeout(liveUpdates.refreshTimer);
                liveUpdates.refreshTimer = null;
                liveUpdates.refreshTimerDelay = null;
                liveUpdates.pendingRefresh = true;
            }
            window.clearTimeout(liveUpdates.retryTimer);
            const activeSocket = liveUpdates.ws || liveUpdates.socket;
            if (activeSocket) {
                liveUpdates.socket = null;
                liveUpdates.ws = null;
                activeSocket.close();
            }
            return;
        }

        liveUpdates.paused = false;
        connectLiveUpdates();

        if (liveUpdates.pendingRefresh || !state.snapshot || isTargetAheadOfLoaded()) {
            liveUpdates.pendingRefresh = false;
            scheduleListingsRefresh(250);
            return;
        }

        const snapshotAgeMs = Date.now() - Number(liveUpdates.lastSnapshotAtMs || 0);
        if (!('WebSocket' in window) || snapshotAgeMs >= SNAPSHOT_RESUME_CHECK_MS) {
            pollListingsRevision();
        }
    }

    if (typeof module !== 'undefined' && module.exports && !isBrowserBundle) {
        module.exports.__test__ = {
            applySnapshotExpiryTimestamps,
            connectLiveUpdates,
            fetchSnapshot,
            handleVisibilityChange,
            isLiveSocketOpen,
            isTargetAheadOfLoaded,
            listingDutyName,
            listingMatchesFilters,
            listingRenderSignature,
            renderListingsPage,
            renderPhaseProgress,
            renderDescription,
            renderListingCard,
            renderProgressTags,
            normalizeSavedState,
            pollListingsRevision,
            pruneExpiredListings,
            scheduleLiveReconnect,
            scheduleLiveSnapshotFetch,
            scheduleListingsRefresh,
            scheduleSnapshotRetry,
            secondsUntilListingExpiry,
            selectedCountLabel,
            setSnapshot,
            shouldRunRevisionPoll,
            state,
            updateTimeDisplays,
            liveUpdates,
        };
        return;
    }

    document.addEventListener('visibilitychange', handleVisibilityChange);

    async function initialize() {
        addJsClass();
        saveLoadState();
        reflectState();
        setAdvancedFiltersExpanded(hasActiveAdvancedFilters());
        applyTranslations();
        renderSelectedTags();

        setUpSearch();
        setUpDataCentreFilter();
        setUpRoleFilter();
        setUpAdvancedFilters();
        setUpContentSelect();
        setUpPaginationControls();
        setupScrollToTop();

        await fetchSnapshot(false);
        connectLiveUpdates();
        setInterval(() => {
            if (!shouldRunRevisionPoll()) return;
            pollListingsRevision();
        }, REVISION_POLL_INTERVAL_MS);
        setInterval(updateTimeDisplays, 1000);
    }

    initialize();
})();
