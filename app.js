import { saveRomToCache, getCachedRom, loadSram, saveSram, exportSaveFile, importSaveFile } from './storage.js';

let currentRomName = '';
let isEmulatorInitialized = false;

// 1. Регистрация Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.error(err));
    });
}

// Автоматический перехват сохранений из ядра Desmond в вашу БД (storage.js)
window.__onDesmondAutoSave = async (uint8Array) => {
    if (currentRomName && uint8Array && uint8Array.byteLength > 0) {
        await saveSram(currentRomName, uint8Array);
        console.log('Автосохранение записано в IndexedDB:', currentRomName);
    }
};

// 2. Кнопка «Продолжить» при запуске
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const cachedRom = await getCachedRom();
        if (cachedRom && cachedRom.data) {
            const btnContinue = document.getElementById('btn-continue');
            btnContinue.disabled = false;
            btnContinue.addEventListener('click', () => {
                loadEmulatorAndRun(cachedRom.name, cachedRom.data);
            });
        }
    } catch (error) {
        console.error('Ошибка чтения ROM из IndexedDB:', error);
    }
});

// 3. Загрузка нового ROM
document.getElementById('rom-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const arrayBuffer = await file.arrayBuffer();
        await saveRomToCache(file.name, arrayBuffer);
        document.getElementById('btn-continue').disabled = false;
        loadEmulatorAndRun(file.name, arrayBuffer);
        event.target.value = '';
    } catch (error) {
        console.error('Ошибка чтения ROM файла:', error);
    }
});

// 4. Инициализация desmond.js и запуск игры
async function loadEmulatorAndRun(romName, arrayBuffer) {
    currentRomName = romName;

    // Подгружаем сохранение из нашей БД заранее, чтобы tryLoadROM сразу подхватил его
    const savedSram = await loadSram(romName);
    window.__pendingSaveData = savedSram || null;

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

// Стилизация обоих экранов внутри Shadow DOM
function fixDesmondLayout(player) {
    if (!player || !player.shadowRoot) return;
    const canvases = player.shadowRoot.querySelectorAll('canvas');
    canvases.forEach((canvas) => {
        canvas.style.position = 'relative';
        canvas.style.top = 'auto';
        canvas.style.left = 'auto';
        canvas.style.width = '312px';
        canvas.style.height = '234px';
        canvas.style.display = 'block';
        canvas.style.pointerEvents = 'auto';
        canvas.style.touchAction = 'none';
    });
}

/* ==========================================
   Управление: Прямая передача нажатий в emuKeyState ядра
   ========================================== */

document.querySelectorAll('button[data-key]').forEach(btn => {
    const key = btn.getAttribute('data-key');

    btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.blur();
        btn.classList.add('active');
        if (window.__desmondSetButton) {
            window.__desmondSetButton(key, true);
        }
    });

    const releaseButton = (e) => {
        e.preventDefault();
        btn.classList.remove('active');
        if (window.__desmondSetButton) {
            window.__desmondSetButton(key, false);
        }
    };

    btn.addEventListener('pointerup', releaseButton);
    btn.addEventListener('pointercancel', releaseButton);
    btn.addEventListener('pointerleave', releaseButton);
});

/* ==========================================
   Сохранения (.sav): Кнопка Сохранить, Экспорт и Импорт
   ========================================== */

const btnQuickSave = document.getElementById('btn-quick-save');
if (btnQuickSave) {
    btnQuickSave.addEventListener('click', async () => {
        if (!currentRomName) return alert('Сначала запустите игру!');

        const liveSav = window.__desmondExtractSave ? window.__desmondExtractSave() : null;
        if (liveSav && liveSav.byteLength > 0) {
            await saveSram(currentRomName, liveSav);
            alert('Сохранение успешно записано в память браузера!');
        } else {
            alert('Сначала сохранитесь внутри самой игры (через игровое меню Save), а затем нажмите эту кнопку!');
        }
    });
}

// Экспорт .sav прямо во время игры
document.getElementById('btn-export-sav').addEventListener('click', async () => {
    if (!currentRomName) return alert('Сначала запустите игру!');

    const liveSav = window.__desmondExtractSave ? window.__desmondExtractSave() : null;
    if (liveSav && liveSav.byteLength > 0) {
        await saveSram(currentRomName, liveSav);
    }
    await exportSaveFile(currentRomName);
});

// Импорт .sav
document.getElementById('sav-input').addEventListener('change', async (event) => {
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
        window.__pendingSaveData = sramData;
        if (window.__desmondInjectSave) {
            window.__desmondInjectSave(sramData);
        }
        event.target.value = '';
        alert('Сохранение импортировано! Сейчас страница перезагрузится — нажмите «Продолжить», чтобы загрузить мир.');
        window.location.reload();
    } catch (err) {
        console.error('Ошибка импорта:', err);
    }
});