import { saveRomToCache, getCachedRom, loadSram, saveSram, exportSaveFile, importSaveFile } from './storage.js';

let currentRomName = '';
let isEmulatorInitialized = false;

// 0. Оптимизация звука: перехватываем создание AudioContext внутри Desmond,
// чтобы задать буфер 'interactive' и снизить прерывания звука
const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
if (OriginalAudioContext) {
    window.AudioContext = window.webkitAudioContext = function(options = {}) {
        options.latencyHint = 'interactive';
        const ctx = new OriginalAudioContext(options);
        window.__desmondAudioCtx = ctx;
        return ctx;
    };
}

// 1. Регистрация Service Worker[cite: 2, 5]
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.error(err));
    });
}

// 2. Проверка кэшированной игры при запуске[cite: 2, 3]
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

// 3. Загрузка нового ROM через input[cite: 2, 3]
document.getElementById('rom-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const arrayBuffer = await file.arrayBuffer();
        await saveRomToCache(file.name, arrayBuffer);
        loadEmulatorAndRun(file.name, arrayBuffer);
        event.target.value = ''; // Сброс инпута, чтобы работал повторный выбор
    } catch (error) {
        console.error('Ошибка чтения ROM файла:', error);
    }
});

// 4. Подключение desmond.js, выравнивание экранов и запуск
async function loadEmulatorAndRun(romName, arrayBuffer) {
    currentRomName = romName;

    if (window.__desmondAudioCtx && window.__desmondAudioCtx.state === 'suspended') {
        window.__desmondAudioCtx.resume();
    }

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

    // Восстанавливаем сохранение перед стартом игры
    const sramData = await loadSram(romName);
    if (sramData) {
        injectSaveToEmulator(romName, sramData);
    }

    const blob = new Blob([arrayBuffer], { type: 'application/octet-stream' });
    const romUrl = URL.createObjectURL(blob);
    const player = document.getElementById('player');

    const startPlayer = () => {
        player.loadURL(romUrl, () => {
            fixDesmondShadowDOM(player);
            if (sramData) injectSaveToEmulator(romName, sramData);
        });
        // На случай если версия desmond.js не вызывает callback в loadURL:
        setTimeout(() => fixDesmondShadowDOM(player), 500);
    };

    if (player && typeof player.loadURL === 'function') {
        startPlayer();
    } else {
        setTimeout(startPlayer, 350);
    }
}

// Снимает жесткую привязку к левому верхнему углу внутри Shadow DOM плеера
// и активирует тачскрин на нижнем экране
function fixDesmondShadowDOM(player) {
    if (!player) return;
    const root = player.shadowRoot || player;
    const canvases = root.querySelectorAll('canvas');
    canvases.forEach((canvas) => {
        canvas.style.position = 'relative';
        canvas.style.top = 'auto';
        canvas.style.left = 'auto';
        canvas.style.width = '256px';
        canvas.style.height = '192px';
        canvas.style.display = 'block';
        canvas.style.pointerEvents = 'auto';
        canvas.style.touchAction = 'none';
    });
}

/* ==========================================
   Управление: Геймпад и фикс Start / Select
   ========================================== */

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

    // В старых сборках Emscripten/Desmond свойство keyCode в конструкторе KeyboardEvent
    // часто игнорируется и равно 0, из-за чего не работают Enter (Start) и Shift (Select).
    // Принудительно задаем keyCode и which через Object.defineProperty:
    const createKeyEvent = (codeVal, keyName, codeName) => {
        const ev = new KeyboardEvent(eventType, {
            key: keyName,
            code: codeName,
            bubbles: true,
            cancelable: true
        });
        Object.defineProperty(ev, 'keyCode', { get: () => codeVal });
        Object.defineProperty(ev, 'which', { get: () => codeVal });
        return ev;
    };

    const ev = createKeyEvent(map.keyCode, map.key, map.code);
    window.dispatchEvent(ev);
    document.dispatchEvent(ev);

    // Дублируем Select на Backspace (код 8), так как ряд сборок Desmond мапит Select на него
    if (btnKey === 'select') {
        const altEv = createKeyEvent(8, 'Backspace', 'Backspace');
        window.dispatchEvent(altEv);
        document.dispatchEvent(altEv);
    }
}

document.querySelectorAll('button[data-key]').forEach(btn => {
    const key = btn.getAttribute('data-key');

    btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.blur(); // Убираем фокус с кнопки, чтобы Enter (Start) не вызывал клик по ней
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
   Система сохранений (.sav): Синхронизация с ядром Desmond
   ========================================== */

// Функция извлечения текущего .sav напрямую из памяти работающего эмулятора
async function extractSaveFromEmulator(romName) {
    const savName = romName.replace(/\.nds$/i, '.sav');
    const dsvName = romName.replace(/\.nds$/i, '.dsv');

    // 1. Проверяем виртуальную файловую систему Emscripten (Module.FS)
    if (window.Module && window.Module.FS) {
        const fs = window.Module.FS;
        try {
            // Ищем любой созданный ядром файл сохранения (.sav или .dsv) в корне '/'
            const files = fs.readdir('/');
            for (const f of files) {
                if (f.endsWith('.sav') || f.endsWith('.dsv') || f === savName || f === dsvName) {
                    const data = fs.readFile('/' + f);
                    if (data && data.length > 0) return new Uint8Array(data);
                }
            }
        } catch (e) {
            // Игнорируем ошибки чтения
        }
    }

    // 2. Если сборка Desmond хранит сохранения через встроенный localforage
    if (window.localforage) {
        try {
            const keys = await window.localforage.keys();
            for (const k of keys) {
                if (k.includes('sav') || k.includes('save') || k.includes(romName)) {
                    const data = await window.localforage.getItem(k);
                    if (data) return new Uint8Array(data);
                }
            }
        } catch (e) {}
    }

    return null;
}

// Запись сохранения во все доступные хранилища ядра
async function injectSaveToEmulator(romName, uint8Array) {
    const savName = romName.replace(/\.nds$/i, '.sav');

    if (window.Module && window.Module.FS) {
        const fs = window.Module.FS;
        try {
            fs.writeFile('/' + savName, uint8Array);
            // Перезаписываем также текущий активный .sav файл, если он был назван по Blob URL
            const files = fs.readdir('/');
            for (const f of files) {
                if (f.endsWith('.sav') || f.endsWith('.dsv')) {
                    fs.writeFile('/' + f, uint8Array);
                }
            }
        } catch (e) {}
    }

    if (window.localforage) {
        try {
            const keys = await window.localforage.keys();
            for (const k of keys) {
                await window.localforage.setItem(k, uint8Array);
            }
        } catch (e) {}
    }
}

// Фоновое автосохранение каждые 10 секунд (редкий интервал не вызывает лагов звука)
setInterval(async () => {
    if (!isEmulatorInitialized || !currentRomName) return;
    const liveData = await extractSaveFromEmulator(currentRomName);
    if (liveData) {
        await saveSram(currentRomName, liveData);
    }
}, 10000);

// Экспорт .sav (теперь работает прямо во время запущенной игры)
document.getElementById('btn-export-sav').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentRomName) {
        alert('Сначала загрузите или выберите ROM!');
        return;
    }

    // Сначала пробуем вытащить свежие данные из памяти запущенной игры
    const liveData = await extractSaveFromEmulator(currentRomName);
    if (liveData) {
        await saveSram(currentRomName, liveData);
    }

    await exportSaveFile(currentRomName);
});

// Импорт .sav (работает как до, так и во время игры)
document.getElementById('sav-input').addEventListener('change', async (event) => {
    event.stopPropagation();
    const file = event.target.files[0];
    if (!file) return;

    if (!currentRomName) {
        alert('Сначала запустите игру, для которой предназначено сохранение!');
        event.target.value = '';
        return;
    }

    try {
        const sramData = await importSaveFile(currentRomName, file);
        await injectSaveToEmulator(currentRomName, sramData);
        event.target.value = ''; // Сбрасываем инпут, чтобы можно было импортировать снова
        alert('Сохранение успешно импортировано! Перезапустите игру кнопкой «Продолжить последнюю игру», чтобы применить данные.');
    } catch (err) {
        console.error('Ошибка импорта:', err);
    }
});