(function () {
    const LANGUAGE_NAMES = {
        en: 'English',
        ja: '日本語',
        de: 'Deutsch',
        fr: 'Français',
    };

    function readCookie(name) {
        const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
        return match ? decodeURIComponent(match[1]) : null;
    }

    function selectedLanguage(language) {
        const cookieLang = readCookie('lang');
        if (cookieLang && LANGUAGE_NAMES[cookieLang]) {
            return cookieLang;
        }

        const accepted = language?.dataset.accept;
        if (accepted && LANGUAGE_NAMES[accepted]) {
            return accepted;
        }

        const documentLang = document.documentElement.lang;
        return LANGUAGE_NAMES[documentLang] ? documentLang : 'en';
    }

    function writeStateLanguage(lang) {
        try {
            const saved = JSON.parse(localStorage.getItem('state') || '{}');
            if (saved && typeof saved === 'object') {
                saved.lang = lang;
                localStorage.setItem('state', JSON.stringify(saved));
            }
        } catch (_) {
            localStorage.setItem('state', JSON.stringify({ lang }));
        }
    }

    function reflectLanguage(language, lang) {
        if (!language) return;

        document.documentElement.lang = lang;
        language.dataset.accept = lang;

        const selected = language.querySelector(`[data-value="${lang}"]`);
        const trigger = language.previousElementSibling;
        if (trigger) {
            trigger.textContent = selected?.textContent.trim() || LANGUAGE_NAMES[lang] || lang;
        }
    }

    function setUpLanguage() {
        let language = document.getElementById('language');
        if (!language) return;

        reflectLanguage(language, selectedLanguage(language));

        for (let elem of language.querySelectorAll('[data-value]')) {
            elem.addEventListener('click', (event) => {
                event.preventDefault();
                const lang = elem.dataset.value;
                document.cookie = `lang=${encodeURIComponent(lang)};path=/;max-age=31536000;samesite=lax`;
                writeStateLanguage(lang);
                reflectLanguage(language, lang);
                window.location.reload();
            });
        }
    }

    setUpLanguage();
})();
