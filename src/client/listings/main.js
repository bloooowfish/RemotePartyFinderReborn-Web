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
        retryTimer: null,
        refreshTimer: null,
        refreshTimerDelay: null,
        retryAttempt: 0,
        revision: 0,
        targetRevision: 0,
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
            ja: '平均IL',
            de: 'Min. GS',
            fr: 'NvObj min.',
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
        return window.RPF_LISTING_DATA || {};
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

        persistState();
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

        const totalPages = Math.max(1, Math.ceil(state.filteredListings.length / state.pageSize));
        const currentPage = Math.min(state.page, totalPages);
        state.page = currentPage;

        prev.classList.toggle('disabled', currentPage <= 1);
        next.classList.toggle('disabled', currentPage >= totalPages);

        const items = paginationModel(totalPages, currentPage)
            .map((page) => {
                if (page === ELLIPSIS) {
                    return '<li class="disabled"><a href="javascript:void(0)">...</a></li>';
                }

                const active = page === currentPage ? ' class="active"' : '';
                return `<li${active}><a href="javascript:void(0)" data-page="${page}">${page}</a></li>`;
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

    function renderListingsPage() {
        const listingsEl = document.getElementById('listings');
        if (!listingsEl) return;

        const start = (state.page - 1) * state.pageSize;
        const end = start + state.pageSize;
        const pageItems = state.filteredListings.slice(start, end);

        listingsEl.innerHTML = pageItems.map(renderListingCard).join('');
        updateEmptyStates(getListings().length, state.filteredListings.length);
        renderPagination();
        updateDataCentreCounts();
        applyTranslations();
        updateTimeDisplays();
    }

    function applyFiltersAndRender() {
        state.filteredListings = getListings().filter(listingMatchesFilters);
        const totalPages = Math.max(1, Math.ceil(state.filteredListings.length / state.pageSize));
        state.page = Math.min(Math.max(1, state.page), totalPages);
        renderListingsPage();
    }

    function setSnapshot(snapshot, preservePage) {
        applySnapshotExpiryTimestamps(snapshot);
        state.snapshot = snapshot;
        rebuildSnapshotDerivedData();
        if (typeof snapshot?.revision === 'number') {
            liveUpdates.revision = snapshot.revision;
            liveUpdates.targetRevision = snapshot.revision;
            liveUpdates.refreshFailureCount = 0;
        }
        if (!preservePage) {
            state.page = 1;
        }
        renderContentSelectOptions();
        renderSelectedTags();
        applyFiltersAndRender();
    }

    function scheduleSnapshotRetry() {
        const retryDelay = Math.min(30000, 1000 * (2 ** liveUpdates.refreshFailureCount));
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

            const snapshot = await response.json();
            setServerUnavailable(false);
            setSnapshot(snapshot, preservePage);
            shouldRetry = liveUpdates.targetRevision > liveUpdates.revision;
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

        try {
            const response = await fetch('/api/listings/revision', {
                cache: 'no-store',
                credentials: 'same-origin',
            });
            if (!response.ok) return;

            const body = await response.json();
            const revision = Number(body?.revision);
            if (!Number.isFinite(revision) || revision === liveUpdates.targetRevision) return;

            liveUpdates.targetRevision = revision;
            scheduleListingsRefresh(0);
        } catch (error) {
            console.debug('live listings revision poll failed', error);
        }
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
        const retryDelay = Math.min(30000, 1000 * (2 ** liveUpdates.retryAttempt));
        liveUpdates.retryAttempt = Math.min(liveUpdates.retryAttempt + 1, 5);
        liveUpdates.retryTimer = window.setTimeout(connectLiveUpdates, retryDelay);
    }

    function connectLiveUpdates() {
        if (!('WebSocket' in window)) return;
        if (liveUpdates.paused || document.visibilityState === 'hidden') return;
        if (liveUpdates.socket && liveUpdates.socket.readyState <= WebSocket.OPEN) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${window.location.host}/api/ws`);
        liveUpdates.socket = socket;

        socket.addEventListener('open', () => {
            liveUpdates.retryAttempt = 0;
            socket.send(JSON.stringify({ type: 'subscribe', channel: 'listing_changes' }));
        });

        socket.addEventListener('message', (event) => {
            try {
                const message = JSON.parse(event.data);
                if (message.type === 'listings_revision_changed') {
                    if (typeof message.revision === 'number') {
                        if (message.revision === liveUpdates.targetRevision) return;
                        liveUpdates.targetRevision = message.revision;
                    }
                    scheduleListingsRefresh();
                }
            } catch (error) {
                console.debug('ignored live listings message', error);
            }
        });

        socket.addEventListener('close', () => {
            if (liveUpdates.socket === socket) {
                liveUpdates.socket = null;
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
    }

    function setUpAdvancedFilters() {
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
        if (!trigger || !container || !dropdown || !listEl) return;

        trigger.addEventListener('click', () => {
            const isOpen = container.classList.toggle('open');
            if (isOpen) {
                renderContentSelectOptions();
            }
        });

        document.addEventListener('click', (event) => {
            if (!container.contains(event.target)) {
                container.classList.remove('open');
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

    function setUpPaginationControls() {
        const pagination = document.querySelector('.pagination');
        const prev = document.querySelector('.page-btn.prev');
        const next = document.querySelector('.page-btn.next');
        if (!pagination || !prev || !next) return;

        pagination.addEventListener('click', (event) => {
            const page = Number(event.target.dataset.page);
            if (!Number.isFinite(page)) return;
            state.page = page;
            renderListingsPage();
        });

        prev.addEventListener('click', (event) => {
            event.preventDefault();
            if (state.page <= 1) return;
            state.page -= 1;
            renderListingsPage();
        });

        next.addEventListener('click', (event) => {
            event.preventDefault();
            const totalPages = Math.max(1, Math.ceil(state.filteredListings.length / state.pageSize));
            if (state.page >= totalPages) return;
            state.page += 1;
            renderListingsPage();
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

    if (typeof module !== 'undefined' && module.exports && !isBrowserBundle) {
        module.exports.__test__ = {
            applySnapshotExpiryTimestamps,
            listingMatchesFilters,
            renderPhaseProgress,
            renderDescription,
            renderListingCard,
            renderProgressTags,
            normalizeSavedState,
            pruneExpiredListings,
            scheduleListingsRefresh,
            secondsUntilListingExpiry,
            selectedCountLabel,
            state,
            updateTimeDisplays,
            liveUpdates,
        };
        return;
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            liveUpdates.paused = true;
            if (liveUpdates.refreshTimer !== null) {
                window.clearTimeout(liveUpdates.refreshTimer);
                liveUpdates.refreshTimer = null;
                liveUpdates.refreshTimerDelay = null;
                liveUpdates.pendingRefresh = true;
            }
            window.clearTimeout(liveUpdates.retryTimer);
            if (liveUpdates.socket) {
                const socket = liveUpdates.socket;
                liveUpdates.socket = null;
                socket.close();
            }
            return;
        }

        liveUpdates.paused = false;
        connectLiveUpdates();
        pollListingsRevision();
        if (liveUpdates.pendingRefresh) {
            liveUpdates.pendingRefresh = false;
        }
        scheduleListingsRefresh(250);
    });

    async function initialize() {
        addJsClass();
        saveLoadState();
        reflectState();
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
        pollListingsRevision();
        setInterval(pollListingsRevision, REVISION_POLL_INTERVAL_MS);
        setInterval(updateTimeDisplays, 1000);
    }

    initialize();
})();
