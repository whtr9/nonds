import { saveRomToCache, getCachedRom, loadSram, saveSram, exportSaveFile, importSaveFile } from './storage.js';

let currentRomName = '';
let isEmulatorInitialized = false;

// 1. Регистрация Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then(reg => console.log('Service Worker зарегистрирован:', reg.scope))
            .catch(err => console.error('Ошибка регистрации SW:', err));
    });
}

// 2. Проверка кэшированной игры при запуске
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

// 3. Загрузка нового ROM через input
document.getElementById('rom-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const arrayBuffer = await file.arrayBuffer();
        await saveRomToCache(file.name, arrayBuffer);
        loadEmulatorAndRun(file.name, arrayBuffer);
    } catch (error) {
        console.error('Ошибка чтения ROM файла:', error);
    }
});

// 4. Подключение desmond.js и запуск игры через Blob URL
async function loadEmulatorAndRun(romName, arrayBuffer) {
    currentRomName = romName;

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

    // Восстановление сохранения перед запуском (если есть в нашей БД)
    const sramData = await loadSram(romName);
    if (sramData && window.Module && window.Module.FS) {
        try {
            const savName = romName.replace(/\.nds$/i, '.sav');
            window.Module.FS.writeFile(savName, sramData);
        } catch (e) {
            console.warn('FS ещё не инициализирована для прямой записи .sav');
        }
    }

    // Desmond принимает путь к файлу в метод loadURL().
    // Создаем локальный Blob URL из ArrayBuffer для работы в 100% офлайне:
    const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
    const romUrl = URL.createObjectURL(blob);

    const player = document.getElementById('player');
    if (player && typeof player.loadURL === 'function') {
        player.loadURL(romUrl);
    } else {
        // Небольшая задержка, если веб-компонент только что зарегистрировался
        setTimeout(() => {
            document.getElementById('player').loadURL(romUrl);
        }, 300);
    }
}

/* ==========================================
   Управление: Трансляция экранных кнопок в клавиши Desmond
   ========================================== */

// Desmond по умолчанию слушает стандартные клавиатурные события на window/document:
// Z = B, X = A, A = Y, S = X, Q = L, W = R, Enter = Start, Shift = Select, Стрелки = D-Pad
const desmondKeyMap = {
    'a':      { key: 'x', code: 'KeyX', keyCode: 88 },
    'b':      { key: 'z', code: 'KeyZ', keyCode: 90 },
    'x':      { key: 's', code: 'KeyS', keyCode: 83 },
    'y':      { key: 'a', code: 'KeyA', keyCode: 65 },
    'l':      { key: 'q', code: 'KeyQ', keyCode: 81 },
    'r':      { key: 'w', code: 'KeyW', keyCode: 87 },
    'start':  { key: 'Enter', code: 'Enter', keyCode: 13 },
    'select': { key: 'Shift', code: 'ShiftRight', keyCode: 16 },
    'up':     { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'down':   { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'left':   { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'right':  { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 }
};

function triggerDesmondKey(btnKey, isPressed) {
    const map = desmondKeyMap[btnKey];
    if (!map) return;

    const eventType = isPressed ? 'keydown' : 'keyup';
    const event = new KeyboardEvent(eventType, {
        key: map.key,
        code: map.code,
        keyCode: map.keyCode,
        which: map.keyCode,
        bubbles: true,
        cancelable: true
    });

    window.dispatchEvent(event);
    document.dispatchEvent(event);
}

// Навешивание мультитач-событий на ваши экранные кнопки
document.querySelectorAll('button[data-key]').forEach(btn => {
    const key = btn.getAttribute('data-key');

    btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.classList.add('active');
        triggerDesmondKey(key, true);
    });

    const releaseButton = (e) => {
        e.preventDefault();
        btn.classList.remove('active');
        triggerDesmondKey(key, false);
    };

    btn.addEventListener('pointerup', releaseButton);
    btn.addEventListener('pointercancel', releaseButton);
    btn.addEventListener('pointerleave', releaseButton);
});

/* ==========================================
   Система сохранений (.sav / localforage / FS)
   ========================================== */

// Экспорт и импорт .sav через ваш storage.js
document.getElementById('btn-export-sav').addEventListener('click', () => {
    if (!currentRomName) return alert('Сначала запустите игру!');
    exportSaveFile(currentRomName);
});

document.getElementById('sav-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file || !currentRomName) return alert('Сначала запустите игру!');

    try {
        const sramData = await importSaveFile(currentRomName, file);
        if (window.Module && window.Module.FS) {
            const savName = currentRomName.replace(/\.nds$/i, '.sav');
            window.Module.FS.writeFile(savName, sramData);
        }
        alert('Сохранение импортировано! Перезапустите игру (Продолжить последнюю игру).');
    } catch (err) {
        console.error('Ошибка импорта:', err);
    }
});