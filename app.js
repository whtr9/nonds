import {
    saveRomToCache,
    getCachedRom,
    loadSram,
    saveSram,
    saveQuickState,
    loadQuickState,
    deleteQuickState,
    exportSaveFile,
    importSaveFile
} from './storage.js';

let currentRomName = '';
let isEmulatorInitialized = false;

// 1. Регистрация Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.error(err));
    });
}

// 2. Управление звуком (Mute / Unmute)
window.__ndsMuted = localStorage.getItem('nds_muted') === 'true';
const btnMute = document.getElementById('btn-mute');

function updateMuteUI() {
    if (!btnMute) return;
    btnMute.textContent = window.__ndsMuted ? '🔇' : '🔊';
    btnMute.classList.toggle('muted', window.__ndsMuted);
    if (window.__desmondSetMute) {
        window.__desmondSetMute(window.__ndsMuted);
    }
}
updateMuteUI();

if (btnMute) {
    btnMute.addEventListener('click', () => {
        window.__ndsMuted = !window.__ndsMuted;
        localStorage.setItem('nds_muted', window.__ndsMuted);
        updateMuteUI();
    });
}

// 3. Выдвигающееся меню для Экспорта и Импорта .sav
const btnMenuToggle = document.getElementById('btn-menu-toggle');
const savDrawer = document.getElementById('sav-drawer');

if (btnMenuToggle && savDrawer) {
    btnMenuToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        savDrawer.classList.toggle('open');
    });

    // Закрытие меню при клике вне его области
    document.addEventListener('pointerdown', (e) => {
        if (savDrawer.classList.contains('open') && !e.target.closest('.menu-container')) {
            savDrawer.classList.remove('open');
        }
    });
}

// Автоматический перехват внутриигровых сохранений (.sav) из ядра Desmond в БД
window.__onDesmondAutoSave = async (uint8Array) => {
    if (currentRomName && uint8Array && uint8Array.byteLength > 0) {
        await saveSram(currentRomName, uint8Array);
        console.log('Внутриигровое автосохранение (.sav) записано в IndexedDB:', currentRomName);
    }
};

// 4. Кнопка «Продолжить» при запуске (загружает ROM + точный кадр Save State)
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const cachedRom = await getCachedRom();
        if (cachedRom && cachedRom.data) {
            const btnContinue = document.getElementById('btn-continue');
            btnContinue.disabled = false;
            btnContinue.addEventListener('click', () => {
                loadEmulatorAndRun(cachedRom.name, cachedRom.data, true);
            });
        }
    } catch (error) {
        console.error('Ошибка чтения ROM из IndexedDB:', error);
    }
});

// 5. Загрузка нового ROM
document.getElementById('rom-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const arrayBuffer = await file.arrayBuffer();
        await saveRomToCache(file.name, arrayBuffer);
        document.getElementById('btn-continue').disabled = false;
        loadEmulatorAndRun(file.name, arrayBuffer, true);
        event.target.value = '';
    } catch (error) {
        console.error('Ошибка чтения ROM файла:', error);
    }
});

// 6. Инициализация desmond.js и запуск игры
async function loadEmulatorAndRun(romName, arrayBuffer, restoreQuickState = true) {
    currentRomName = romName;
    enableExitGuard();

    const [savedSram, savedQuickState] = await Promise.all([
        loadSram(romName),
        restoreQuickState ? loadQuickState(romName) : Promise.resolve(null)
    ]);

    window.__pendingSaveData = savedSram || null;
    window.__pendingQuickState = savedQuickState || null;

    if (!isEmulatorInitialized) {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'core/desmond.js';
            script.onload = resolve;
            script.onerror = reject;
            document.body.appendChild(script);
        });
        isEmulatorInitialized = true;
    }

    updateMuteUI();

    const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
    const romUrl = URL.createObjectURL(blob);
    const player = document.getElementById('player');

    const startPlayer = () => {
        player.loadURL(romUrl, () => {
            fixDesmondLayout(player);
        });
        setTimeout(() => fixDesmondLayout(player), 300);
    };

    if (player && typeof player.loadURL === 'function') {
        startPlayer();
    } else {
        setTimeout(startPlayer, 350);
    }
}

// Стилизация обоих экранов внутри Shadow DOM (+15% к размеру)
function fixDesmondLayout(player) {
    if (!player || !player.shadowRoot) return;
    const canvases = player.shadowRoot.querySelectorAll('canvas');
    canvases.forEach((canvas) => {
        canvas.style.position = 'relative';
        canvas.style.top = 'auto';
        canvas.style.left = 'auto';
        canvas.style.width = '358px';
        canvas.style.height = '269px';
        canvas.style.display = 'block';
        canvas.style.pointerEvents = 'auto';
        canvas.style.touchAction = 'none';
    });
}

/* ==========================================
   Управление: Прямая запись в глобальный объект window.__ndsKeys
   ========================================== */

window.__ndsKeys = window.__ndsKeys || {};

document.querySelectorAll('button[data-key]').forEach(btn => {
    const key = btn.getAttribute('data-key');

    const press = (e) => {
        if (e.cancelable) e.preventDefault();
        btn.classList.add('active');
        window.__ndsKeys[key] = true;
        if (window.__desmondSetButton) {
            window.__desmondSetButton(key, true);
        }
    };

    const release = (e) => {
        if (e.cancelable) e.preventDefault();
        btn.classList.remove('active');
        window.__ndsKeys[key] = false;
        if (window.__desmondSetButton) {
            window.__desmondSetButton(key, false);
        }
    };

    btn.addEventListener('touchstart', press, { passive: false });
    btn.addEventListener('touchend', release, { passive: false });
    btn.addEventListener('touchcancel', release, { passive: false });

    btn.addEventListener('mousedown', press);
    btn.addEventListener('mouseup', release);
    btn.addEventListener('mouseleave', release);
});

/* ==========================================
   Сохранения: Быстрое сохранение момента (Save State) + Экспорт/Импорт .sav
   ========================================== */

const btnQuickSave = document.getElementById('btn-quick-save');
if (btnQuickSave) {
    btnQuickSave.addEventListener('click', async () => {
        if (!currentRomName) return alert('Сначала запустите игру!');

        const originalText = btnQuickSave.textContent;
        btnQuickSave.textContent = '⏳...';
        btnQuickSave.disabled = true;

        try {
            const stateSnapshot = window.__desmondCaptureState ? window.__desmondCaptureState() : null;
            if (!stateSnapshot) {
                alert('Игра ещё не загружена!');
                return;
            }
            await saveQuickState(currentRomName, stateSnapshot);

            const liveSav = window.__desmondExtractSave ? await window.__desmondExtractSave() : null;
            if (liveSav && liveSav.byteLength > 0) {
                await saveSram(currentRomName, liveSav);
            }

            alert('Точный момент игры сохранён! При нажатии «Продолжить» вы вернётесь в эту же секунду.');
        } catch (err) {
            console.error('Ошибка быстрого сохранения:', err);
            alert('Ошибка при сохранении состояния.');
        } finally {
            btnQuickSave.textContent = originalText;
            btnQuickSave.disabled = false;
        }
    });
}

// Экспорт .sav прямо во время игры
document.getElementById('btn-export-sav').addEventListener('click', async () => {
    if (savDrawer) savDrawer.classList.remove('open');
    if (!currentRomName) return alert('Сначала запустите игру!');

    const liveSav = window.__desmondExtractSave ? await window.__desmondExtractSave() : null;
    if (liveSav && liveSav.byteLength > 0) {
        await saveSram(currentRomName, liveSav);
    }
    await exportSaveFile(currentRomName);
});

// Импорт .sav
document.getElementById('sav-input').addEventListener('change', async (event) => {
    if (savDrawer) savDrawer.classList.remove('open');
    const file = event.target.files[0];
    if (!file) return;

    if (!currentRomName) {
        const cachedRom = await getCachedRom();
        if (cachedRom && cachedRom.name) {
            currentRomName = cachedRom.name;
        } else {
            alert('Сначала загрузите ROM игры!');
            event.target.value = '';
            return;
        }
    }

    try {
        const sramData = await importSaveFile(currentRomName, file);
        await deleteQuickState(currentRomName);
        window.__pendingSaveData = sramData;
        if (window.__desmondInjectSave) {
            await window.__desmondInjectSave(sramData);
        }
        event.target.value = '';
        alert('Файл .sav импортирован! Сейчас страница перезагрузится — нажмите «Продолжить», чтобы загрузить сохранение.');
        window.location.reload();
    } catch (err) {
        console.error('Ошибка импорта:', err);
    }

});

/* ==========================================
   Защита от случайного выхода свайпом (Back Gesture Trap)
   ========================================== */

let isExitGuardActive = false;

function enableExitGuard() {
    if (isExitGuardActive) return;
    isExitGuardActive = true;
    // Создаём буферное состояние в истории, чтобы жест «Назад» не закрывал PWA
    history.pushState({ ndsGuard: true }, '', location.href);
}

// Активируем защиту при первом же касании экрана или запуске игры
window.addEventListener('pointerdown', enableExitGuard, { once: true });

// Перехватываем жест смахивания с края экрана («Назад»)
window.addEventListener('popstate', async (event) => {
    if (!currentRomName) {
        // Если игра ещё не запущена, просто возвращаем ловушку на место
        history.pushState({ ndsGuard: true }, '', location.href);
        return;
    }

    // Ставим эмулятор на паузу, пока игрок решает
    if (window.__desmondSetPause) window.__desmondSetPause(true);

    const wantToSaveAndExit = confirm(
        'Вы сделали жест «Назад».\n\nНажмите «ОК», чтобы СОХРАНИТЬ этот момент и выйти.\nНажмите «Отмена», чтобы ПРОДОЛЖИТЬ игру.'
    );

    if (wantToSaveAndExit) {
        try {
            const stateSnapshot = window.__desmondCaptureState ? window.__desmondCaptureState() : null;
            if (stateSnapshot) {
                await saveQuickState(currentRomName, stateSnapshot);
            }
            const liveSav = window.__desmondExtractSave ? await window.__desmondExtractSave() : null;
            if (liveSav && liveSav.byteLength > 0) {
                await saveSram(currentRomName, liveSav);
            }
        } catch (err) {
            console.error('Ошибка сохранения перед выходом:', err);
        }
        // Отпускаем приложение (закрываем или перезагружаем в стартовое меню)
        history.back();
    } else {
        // Игрок нажал «Отмена» — восстанавливаем барьер в истории и снимаем игру с паузы
        history.pushState({ ndsGuard: true }, '', location.href);
        if (window.__desmondSetPause) window.__desmondSetPause(false);
    }
});

// Дополнительная подстраховка для стандартного закрытия вкладки
window.addEventListener('beforeunload', (e) => {
    if (currentRomName) {
        e.preventDefault();
        e.returnValue = '';
    }
});

// Автосохранение .sav при сворачивании PWA (например, свайпом домой снизу вверх)
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'hidden' && currentRomName) {
        const liveSav = window.__desmondExtractSave ? await window.__desmondExtractSave() : null;
        if (liveSav && liveSav.byteLength > 0) {
            await saveSram(currentRomName, liveSav);
        }
    }
});