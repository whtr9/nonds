import { saveRomToCache, getCachedRom, loadSram, saveSram, exportSaveFile, importSaveFile } from './storage.js';

let currentRomName = '';
let currentRomBuffer = null;
let isEmulatorInitialized = false;

// 0. Оптимизация звука (снижает прерывания звука)
const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
if (OriginalAudioContext) {
    window.AudioContext = window.webkitAudioContext = function(options = {}) {
        options.latencyHint = 'interactive';
        const ctx = new OriginalAudioContext(options);
        window.__desmondAudioCtx = ctx;
        return ctx;
    };
}

// Перехватчик виртуального постоянного URL для ROM-файла.
// Благодаря этому Desmond видит постоянное имя файла (а не случайный blob: URL)
// и корректно сохраняет/загружает прогресс между сессиями!
const originalFetch = window.fetch;
window.fetch = async function(input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('__virtual_rom__/') && currentRomBuffer) {
        return new Response(currentRomBuffer.slice(0), {
            status: 200,
            headers: { 'Content-Type': 'application/octet-stream' }
        });
    }
    return originalFetch.apply(this, arguments);
};

// Перехват XMLHttpRequest (на случай если сборка Desmond грузит ROM через XHR)
const OriginalXHR = window.XMLHttpRequest;
window.XMLHttpRequest = function() {
    const xhr = new OriginalXHR();
    const origOpen = xhr.open;
    let isVirtualRom = false;

    xhr.open = function(method, url) {
        if (typeof url === 'string' && url.includes('__virtual_rom__/') && currentRomBuffer) {
            isVirtualRom = true;
            const blob = new Blob([currentRomBuffer], { type: 'application/octet-stream' });
            const blobUrl = URL.createObjectURL(blob);
            return origOpen.call(this, method, blobUrl);
        }
        return origOpen.apply(this, arguments);
    };
    return xhr;
};

// 1. Регистрация Service Worker
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch(err => console.error(err));
    });
}

// 2. Активация кнопки «Продолжить» при старте
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

// 4. Запуск эмулятора
async function loadEmulatorAndRun(romName, arrayBuffer) {
    currentRomName = romName;
    currentRomBuffer = arrayBuffer;

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

    // Если в нашей БД (storage.js) есть сохранение, записываем его во внутреннюю БД Desmond перед запуском
    const savedSram = await loadSram(romName);
    if (savedSram) {
        await writeSaveToDesmondDB(romName, savedSram);
    }

    // Используем постоянный виртуальный путь с именем игры вместо случайного Blob URL
    const virtualRomUrl = `./__virtual_rom__/${encodeURIComponent(romName)}`;
    const player = document.getElementById('player');

    const startPlayer = () => {
        player.loadURL(virtualRomUrl, () => {
            fixDesmondLayout(player);
        });
        setTimeout(() => fixDesmondLayout(player), 400);
        setTimeout(() => fixDesmondLayout(player), 1200);
    };

    if (player && typeof player.loadURL === 'function') {
        startPlayer();
    } else {
        setTimeout(startPlayer, 350);
    }
}

// Выравнивание и масштабирование экранов (312x234 каждый) + включение тачскрина
function fixDesmondLayout(player) {
    if (!player) return;
    const root = player.shadowRoot || player;
    const canvases = root.querySelectorAll('canvas');
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
        btn.blur();
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
   Надежное чтение и запись сохранений (.sav)
   из всех внутренних баз Desmond (IndexedDB + FS)
   ========================================== */

// Читает данные сохранения напрямую из внутренней IndexedDB (localforage) или FS ядра Desmond
async function readSaveFromDesmondDB(romName) {
    // 1. Проверяем window.localforage (если Desmond экспортировал его глобально)
    if (window.localforage) {
        try {
            const keys = await window.localforage.keys();
            for (const k of keys) {
                const val = await window.localforage.getItem(k);
                if (val && (val.byteLength > 0 || val.length > 0)) {
                    return new Uint8Array(val.buffer || val);
                }
            }
        } catch (e) {}
    }

    // 2. Прямое чтение из всех IndexedDB баз домена (Desmond обычно создает базу 'localforage' или '/data')
    const possibleDbNames = ['localforage', '/data', 'desmond', 'emscripten_filesystem'];
    for (const dbName of possibleDbNames) {
        try {
            const data = await new Promise((resolve) => {
                const req = indexedDB.open(dbName);
                req.onerror = () => resolve(null);
                req.onsuccess = (e) => {
                    const db = e.target.result;
                    const storeNames = Array.from(db.objectStoreNames);
                    if (storeNames.length === 0) {
                        db.close();
                        return resolve(null);
                    }
                    const tx = db.transaction(storeNames, 'readonly');
                    let found = null;
                    storeNames.forEach(sName => {
                        const store = tx.objectStore(sName);
                        const getAllReq = store.getAll();
                        getAllReq.onsuccess = () => {
                            const items = getAllReq.result || [];
                            for (const item of items) {
                                // Ищем бинарный массив сохранения (обычно от 512 байт до 1 МБ)
                                const raw = (item && item.contents) ? item.contents : item;
                                if (raw instanceof Uint8Array || raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
                                    const arr = new Uint8Array(raw.buffer || raw);
                                    if (arr.byteLength >= 128 && arr.byteLength <= 2 * 1024 * 1024) {
                                        found = arr;
                                    }
                                }
                            }
                        };
                    });
                    tx.oncomplete = () => {
                        db.close();
                        resolve(found);
                    };
                    tx.onerror = () => {
                        db.close();
                        resolve(null);
                    };
                };
            });
            if (data) return data;
        } catch (e) {}
    }

    // 3. Проверка Emscripten Module.FS
    const fs = (window.Module && window.Module.FS) || window.FS;
    if (fs) {
        try {
            const scanDirs = ['/', '/data', '/saves'];
            for (const dir of scanDirs) {
                try {
                    const files = fs.readdir(dir);
                    for (const f of files) {
                        if (f.endsWith('.sav') || f.endsWith('.dsv')) {
                            const fullPath = dir === '/' ? '/' + f : dir + '/' + f;
                            const data = fs.readFile(fullPath);
                            if (data && data.length > 0) return new Uint8Array(data);
                        }
                    }
                } catch (e) {}
            }
        } catch (e) {}
    }

    // 4. Резерв: берем из нашей базы storage.js
    return await loadSram(romName);
}

// Записывает импортированный .sav во все внутренние хранилища Desmond
async function writeSaveToDesmondDB(romName, uint8Array) {
    await saveSram(romName, uint8Array);

    // 1. Запись через localforage
    if (window.localforage) {
        try {
            const keys = await window.localforage.keys();
            for (const k of keys) {
                await window.localforage.setItem(k, uint8Array);
            }
        } catch (e) {}
    }

    // 2. Прямая перезапись ключей в базе localforage через IndexedDB API
    try {
        await new Promise((resolve) => {
            const req = indexedDB.open('localforage');
            req.onerror = () => resolve();
            req.onsuccess = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains('keyvaluepairs')) {
                    db.close();
                    return resolve();
                }
                const tx = db.transaction(['keyvaluepairs'], 'readwrite');
                const store = tx.objectStore('keyvaluepairs');
                const keysReq = store.getAllKeys();
                keysReq.onsuccess = () => {
                    const keys = keysReq.result || [];
                    keys.forEach(k => store.put(uint8Array, k));
                };
                tx.oncomplete = () => {
                    db.close();
                    resolve();
                };
            };
        });
    } catch (e) {}

    // 3. Запись в Module.FS
    const fs = (window.Module && window.Module.FS) || window.FS;
    if (fs) {
        try {
            const savName = romName.replace(/\.nds$/i, '.sav');
            fs.writeFile('/' + savName, uint8Array);
            const files = fs.readdir('/');
            for (const f of files) {
                if (f.endsWith('.sav') || f.endsWith('.dsv')) {
                    fs.writeFile('/' + f, uint8Array);
                }
            }
        } catch (e) {}
    }
}

// Кнопка «💾 Сохранить» (принудительная фиксация текущего сохранения)
const btnQuickSave = document.getElementById('btn-quick-save');
if (btnQuickSave) {
    btnQuickSave.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!currentRomName) {
            alert('Сначала запустите игру!');
            return;
        }
        const liveData = await readSaveFromDesmondDB(currentRomName);
        if (liveData && liveData.byteLength > 0) {
            await saveSram(currentRomName, liveData);
            alert('Прогресс успешно зафиксирован! При следующем нажатии «Продолжить» игра запустится с этого сохранения.');
        } else {
            alert('Внимание: внутриигровое сохранение еще не создано! Сначала сохранитесь внутри самой игры (в Pokémon: нажмите X -> Save), а затем нажмите эту кнопку.');
        }
    });
}

// Кнопка «Экспорт .sav» (работает прямо во время игры)
document.getElementById('btn-export-sav').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentRomName) {
        alert('Сначала загрузите или продолжите игру!');
        return;
    }

    const liveData = await readSaveFromDesmondDB(currentRomName);
    if (liveData && liveData.byteLength > 0) {
        await saveSram(currentRomName, liveData);
        await exportSaveFile(currentRomName);
    } else {
        alert('Файл сохранения пока пуст! Сначала сохранитесь внутри самой игры (через игровое меню Save), чтобы картридж создал данные .sav.');
    }
});

// Кнопка «Импорт .sav» (работает во время игры и автоматически перезапускает ROM с новым сохранением)
document.getElementById('sav-input').addEventListener('change', async (event) => {
    event.stopPropagation();
    const file = event.target.files[0];
    if (!file) return;

    if (!currentRomName) {
        const cachedRom = await getCachedRom();
        if (cachedRom && cachedRom.name) {
            currentRomName = cachedRom.name;
            currentRomBuffer = cachedRom.data;
        } else {
            alert('Сначала выберите ROM игры, а затем импортируйте .sav!');
            event.target.value = '';
            return;
        }
    }

    try {
        const sramData = await importSaveFile(currentRomName, file);
        await writeSaveToDesmondDB(currentRomName, sramData);
        event.target.value = '';
        alert('Сохранение импортировано! Сейчас страница перезагрузится, нажмите «Продолжить», чтобы войти в игру с загруженным сохранением.');
        window.location.reload();
    } catch (err) {
        console.error('Ошибка импорта:', err);
    }
});