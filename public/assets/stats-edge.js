(function () {
    const copy = {
        loading: {
            en: {
                title: 'Loading statistics...',
                body: 'Fetching party finder activity data.',
            },
            ja: {
                title: '統計データを読み込み中...',
                body: 'パーティ募集の活動データを取得しています。',
            },
            de: {
                title: 'Statistiken werden geladen...',
                body: 'Aktivitätsdaten der Gruppensuche werden abgerufen.',
            },
            fr: {
                title: 'Chargement des statistiques...',
                body: 'Récupération des données d’activité de la recherche de groupe.',
            },
        },
        error: {
            en: {
                title: 'Stats are temporarily unavailable',
                body: 'The statistics service could not be reached. Try refreshing in a moment.',
            },
            ja: {
                title: '統計データを一時的に利用できません',
                body: '統計サービスに接続できませんでした。しばらくしてから更新してください。',
            },
            de: {
                title: 'Statistiken sind vorübergehend nicht verfügbar',
                body: 'Der Statistikdienst konnte nicht erreicht werden. Bitte aktualisiere die Seite in Kürze.',
            },
            fr: {
                title: 'Les statistiques sont temporairement indisponibles',
                body: 'Le service de statistiques est inaccessible. Réessayez dans un instant.',
            },
        },
        empty: {
            en: {
                title: 'No stats yet',
                body: 'Once listing data is collected, category, host, hour, and day trends will appear here.',
            },
            ja: {
                title: '統計データはまだありません',
                body: '募集データが集まると、ここにカテゴリ、ホスト、時間帯の傾向が表示されます。',
            },
            de: {
                title: 'Noch keine Statistiken',
                body: 'Sobald Eintragsdaten gesammelt wurden, erscheinen hier Trends zu Kategorien, Hosts und Zeiten.',
            },
            fr: {
                title: 'Aucune statistique pour le moment',
                body: 'Lorsque des recrutements seront collectés, les tendances par catégorie, hôte et horaire apparaîtront ici.',
            },
        },
    };

    const STATS_TRANSLATIONS = {
        page_title: {
            en: 'Party Finder Statistics',
            ja: 'パーティ募集統計',
            de: 'Gruppensuche-Statistiken',
            fr: 'Statistiques de la recherche de groupe',
        },
        page_title_7days: {
            en: 'Party Finder Statistics (7 Days)',
            ja: 'パーティ募集統計（過去7日間）',
            de: 'Gruppensuche-Statistiken (7 Tage)',
            fr: 'Statistiques (7 derniers jours)',
        },
        nav_stats: { en: 'Stats', ja: '統計', de: 'Statistiken', fr: 'Statistiques' },
        nav_all_time: { en: 'All Time', ja: '全期間', de: 'Gesamtzeitraum', fr: 'Depuis toujours' },
        nav_7days: { en: '7 Days', ja: '7日間', de: '7 Tage', fr: '7 jours' },
        top_categories: {
            en: 'Top categories',
            ja: 'コンテンツ別集計',
            de: 'Top-Kategorien',
            fr: 'Catégories principales',
        },
        top_hosts: {
            en: 'Top hosts',
            ja: 'ホストワールド別集計',
            de: 'Top-Hosts',
            fr: 'Hôtes principaux',
        },
        top_hours: {
            en: 'Top hours (UTC)',
            ja: '時間帯別集計 (UTC)',
            de: 'Top-Stunden (UTC)',
            fr: 'Heures principales (UTC)',
        },
        top_days: {
            en: 'Top days (UTC)',
            ja: '曜日別集計 (UTC)',
            de: 'Top-Tage (UTC)',
            fr: 'Jours principaux (UTC)',
        },
        details: { en: 'Details', ja: '詳細', de: 'Details', fr: 'Détails' },
        th_duty: { en: 'Duty', ja: 'コンテンツ', de: 'Inhalt', fr: 'Mission' },
        th_count: { en: 'Count', ja: '件数', de: 'Anzahl', fr: 'Nombre' },
        th_world: { en: 'World (created)', ja: 'ワールド (作成)', de: 'Welt (erstellt)', fr: 'Monde (créé)' },
        th_name: { en: 'Name', ja: '名前', de: 'Name', fr: 'Nom' },
        th_hour: { en: 'Hour', ja: '時刻', de: 'Stunde', fr: 'Heure' },
        total_template: {
            en: 'Stats for {count} listings',
            ja: '{count} 件の募集統計',
            de: 'Statistiken für {count} Einträge',
            fr: 'Statistiques pour {count} recrutements',
        },
        other: { en: 'Other', ja: 'その他', de: 'Sonstige', fr: 'Autres' },
        tooltip_treemap: {
            en: '{label} ({percent}% - {count})',
            ja: '{label}（{percent}%・{count}件）',
            de: '{label} ({percent}% – {count})',
            fr: '{label} ({percent} % - {count})',
        },
        tooltip_bar: {
            en: '{label}: {count} ({percent}%)',
            ja: '{label}: {count}件 ({percent}%)',
            de: '{label}: {count} ({percent}%)',
            fr: '{label} : {count} ({percent} %)',
        },
    };

    const DAY_NAMES = {
        monday: { en: 'Monday', ja: '月曜日', de: 'Montag', fr: 'Lundi' },
        tuesday: { en: 'Tuesday', ja: '火曜日', de: 'Dienstag', fr: 'Mardi' },
        wednesday: { en: 'Wednesday', ja: '水曜日', de: 'Mittwoch', fr: 'Mercredi' },
        thursday: { en: 'Thursday', ja: '木曜日', de: 'Donnerstag', fr: 'Jeudi' },
        friday: { en: 'Friday', ja: '金曜日', de: 'Freitag', fr: 'Vendredi' },
        saturday: { en: 'Saturday', ja: '土曜日', de: 'Samstag', fr: 'Samedi' },
        sunday: { en: 'Sunday', ja: '日曜日', de: 'Sonntag', fr: 'Dimanche' },
    };

    function translateStat(key, requestedLang) {
        const safeLang = STATS_TRANSLATIONS[key]?.[requestedLang] ? requestedLang : 'en';
        return STATS_TRANSLATIONS[key]?.[safeLang] || STATS_TRANSLATIONS[key]?.en || key;
    }

    function translateDayLabel(label, requestedLang) {
        const normalized = String(label ?? '').trim().toLowerCase();
        const entry = DAY_NAMES[normalized];
        if (!entry) return String(label ?? '');
        return entry[requestedLang] || entry.en;
    }

    function formatTemplate(template, values) {
        return String(template).replace(/\{(\w+)\}/g, (match, name) => (
            Object.prototype.hasOwnProperty.call(values, name) ? values[name] : match
        ));
    }

    function lang() {
        const cookie = document.cookie.match(/(?:^|; )lang=([^;]*)/);
        if (cookie) {
            try {
                return decodeURIComponent(cookie[1]);
            } catch (_) {
                // Fall back to the server-provided language hint below.
            }
        }
        const accepted = document.getElementById('language')?.dataset.accept;
        return accepted || 'en';
    }

    function statsCopy(kind, requestedLang) {
        return copy[kind]?.[requestedLang] || copy[kind]?.en || copy.error.en;
    }

    function isStatsEmpty(stats) {
        return Number(stats?.num_listings || 0) <= 0;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fillRows(tableId, rows, renderer) {
        const tbody = document.querySelector(`#${tableId} tbody`);
        tbody.innerHTML = rows.map(renderer).join('');
    }

    function hideLoadingState() {
        const loading = document.getElementById('stats-loading');
        if (loading) loading.style.display = 'none';
    }

    function showState(kind) {
        hideLoadingState();
        const state = statsCopy(kind, lang());
        const container = document.getElementById(`stats-${kind}`);
        if (!container) return;

        const title = document.getElementById(`stats-${kind}-title`);
        const body = document.getElementById(`stats-${kind}-body`);
        if (title) title.textContent = state.title;
        if (body) body.textContent = state.body;
        container.style.display = '';

        const content = document.getElementById('stats-content');
        if (content) content.style.display = 'none';
    }

    function localizeStatsDom(requestedLang) {
        const currentLang = requestedLang || lang();

        const loadingState = statsCopy('loading', currentLang);
        const loadingTitle = document.getElementById('stats-loading-title');
        const loadingBody = document.getElementById('stats-loading-body');
        if (loadingTitle) loadingTitle.textContent = loadingState.title;
        if (loadingBody) loadingBody.textContent = loadingState.body;

        const pageTitle = document.getElementById('stats-page-title');
        if (pageTitle) {
            const titleKey = window.location.pathname === '/stats/7days' ? 'page_title_7days' : 'page_title';
            pageTitle.textContent = translateStat(titleKey, currentLang);
        }

        if (typeof document.querySelectorAll === 'function') {
            for (const elem of document.querySelectorAll('[data-stats-i18n]')) {
                const key = elem.dataset.statsI18n;
                if (key) {
                    elem.textContent = translateStat(key, currentLang);
                }
            }
        }

        const totalContainer = document.getElementById('stats-total-text');
        const totalSpan = document.getElementById('stats-total');
        if (totalContainer && totalSpan && typeof document.createTextNode === 'function') {
            const template = translateStat('total_template', currentLang);
            const parts = template.split('{count}');
            if (parts.length === 2) {
                totalContainer.textContent = '';
                totalContainer.append(
                    document.createTextNode(parts[0]),
                    totalSpan,
                    document.createTextNode(parts[1]),
                );
            }
        }

        const i18nApi = {
            lang: currentLang,
            otherLabel: translateStat('other', currentLang),
            translateDayLabel: (label) => translateDayLabel(label, currentLang),
            formatTreeMapTooltip: (label, percent, count) => formatTemplate(
                translateStat('tooltip_treemap', currentLang),
                { label, percent, count },
            ),
            formatBarTooltip: (label, count, percent) => formatTemplate(
                translateStat('tooltip_bar', currentLang),
                { label, count, percent },
            ),
        };
        if (typeof window !== 'undefined') {
            window.RPF_STATS_I18N = i18nApi;
        }
        return i18nApi;
    }

    function showError() {
        showState('error');
    }

    let chartScriptsPromise = null;

    function resolveAssetUrl(assetPath) {
        if (typeof window !== 'undefined' && window.__RPF_ASSETS__?.[assetPath]) {
            return window.__RPF_ASSETS__[assetPath];
        }
        const raw = typeof document !== 'undefined'
            ? document.querySelector?.('meta[name="rpf-assets"]')?.getAttribute?.('content')
            : null;
        if (raw) {
            try {
                const parsed = JSON.parse(raw);
                if (typeof parsed?.[assetPath] === 'string') return parsed[assetPath];
            } catch (_) {
                // Ignore malformed manifest metadata.
            }
        }
        return assetPath;
    }

    function loadScript(src) {
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.defer = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.body.appendChild(script);
        });
    }

    function loadChartScripts() {
        if (chartScriptsPromise) return chartScriptsPromise;

        chartScriptsPromise = (async () => {
            if (!window.d3) {
                await loadScript(resolveAssetUrl('/assets/d3.js'));
            }
            await loadScript(resolveAssetUrl('/assets/stats.js'));
        })().catch((error) => {
            chartScriptsPromise = null;
            throw error;
        });

        return chartScriptsPromise;
    }

    async function initialize() {
        document.documentElement.classList.remove('no-js');
        document.documentElement.classList.add('js');

        const currentLang = lang();
        localizeStatsDom(currentLang);

        const path = window.location.pathname === '/stats/7days' ? '/api/stats/7days' : '/api/stats';
        const response = await fetch(path, { cache: 'no-cache', credentials: 'same-origin' });
        if (!response.ok) {
            showError();
            return;
        }

        const stats = await response.json();
        if (isStatsEmpty(stats)) {
            showState('empty');
            return;
        }

        hideLoadingState();
        document.getElementById('stats-total').textContent = Number(stats.num_listings || 0).toLocaleString(currentLang);

        fillRows('duties', stats.duties || [], (row) =>
            `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.count)}</td></tr>`);
        fillRows('hosts', stats.hosts || [], (row) =>
            `<tr><td>${escapeHtml(row.world)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.count)}</td></tr>`);
        fillRows('hours', stats.hours || [], (row) =>
            `<tr><td>${escapeHtml(row.hour)}</td><td>${escapeHtml(row.count)}</td></tr>`);
        fillRows('days', stats.days || [], (row) =>
            `<tr><td>${escapeHtml(translateDayLabel(row.label, currentLang))}</td><td>${escapeHtml(row.count)}</td></tr>`);

        document.getElementById('stats-content').style.display = '';
        try {
            await loadChartScripts();
        } catch (error) {
            window.console?.debug?.('Failed to load stats charts', error);
        }
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports.__test__ = {
            DAY_NAMES,
            STATS_TRANSLATIONS,
            initialize,
            isStatsEmpty,
            loadChartScripts,
            localizeStatsDom,
            statsCopy,
            translateDayLabel,
            translateStat,
        };
        return;
    }

    initialize().catch(showError);
})();
