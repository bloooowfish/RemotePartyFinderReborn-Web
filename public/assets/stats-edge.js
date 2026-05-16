(function () {
    const copy = {
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

    function showState(kind) {
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

    function showError() {
        showState('error');
    }

    let chartScriptsPromise = null;

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
                await loadScript('/assets/d3.js');
            }
            await loadScript('/assets/stats.js');
        })().catch((error) => {
            chartScriptsPromise = null;
            throw error;
        });

        return chartScriptsPromise;
    }

    async function initialize() {
        document.documentElement.classList.remove('no-js');
        document.documentElement.classList.add('js');

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

        document.getElementById('stats-total').textContent = Number(stats.num_listings || 0).toLocaleString();

        fillRows('duties', stats.duties || [], (row) =>
            `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.count)}</td></tr>`);
        fillRows('hosts', stats.hosts || [], (row) =>
            `<tr><td>${escapeHtml(row.world)}</td><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.count)}</td></tr>`);
        fillRows('hours', stats.hours || [], (row) =>
            `<tr><td>${escapeHtml(row.hour)}</td><td>${escapeHtml(row.count)}</td></tr>`);
        fillRows('days', stats.days || [], (row) =>
            `<tr><td>${escapeHtml(row.label)}</td><td>${escapeHtml(row.count)}</td></tr>`);

        document.getElementById('stats-content').style.display = '';
        try {
            await loadChartScripts();
        } catch (error) {
            window.console?.debug?.('Failed to load stats charts', error);
        }
    }

    if (typeof module !== 'undefined' && module.exports) {
        module.exports.__test__ = {
            initialize,
            isStatsEmpty,
            loadChartScripts,
            statsCopy,
        };
        return;
    }

    initialize().catch(showError);
})();
