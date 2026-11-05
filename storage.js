// Изолирующий модуль IndexedDB (база NDS_Emulator_DB, версия 2)
const DB_NAME = 'NDS_Emulator_DB';
const DB_VERSION = 2;

// Создание хранилищ roms, saves (для .sav) и states (для точного момента игры)
export function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('roms')) {
                db.createObjectStore('roms');
            }
            if (!db.objectStoreNames.contains('saves')) {
                db.createObjectStore('saves');
            }
            if (!db.objectStoreNames.contains('states')) {
                db.createObjectStore('states');
            }
        };

        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

// Сжатие и распаковка слепков памяти через нативный браузерный GZIP
async function compressData(uint8Array) {
    if (typeof CompressionStream === 'undefined') return uint8Array;
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    writer.write(uint8Array);
    writer.close();
    const buffer = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buffer);
}

async function decompressData(uint8Array) {
    if (typeof DecompressionStream === 'undefined') return uint8Array;
    // Проверка магических байтов GZIP (0x1f, 0x8b)
    if (uint8Array.length < 2 || uint8Array[0] !== 0x1f || uint8Array[1] !== 0x8b) {
        return uint8Array;
    }
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    writer.write(uint8Array);
    writer.close();
    const buffer = await new Response(ds.readable).arrayBuffer();
    return new Uint8Array(buffer);
}

// Запись и чтение последней игры (ROM)
export async function saveRomToCache(name, arrayBuffer) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['roms'], 'readwrite');
        const store = tx.objectStore('roms');
        const request = store.put({ name, data: arrayBuffer }, 'lastGame');
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function getCachedRom() {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['roms'], 'readonly');
        const store = tx.objectStore('roms');
        const request = store.get('lastGame');
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

// Сохранение и извлечение внутриигрового прогресса (SRAM / .sav)
export async function saveSram(romName, uint8Array) {
    const db = await initDB();
    // Копируем буфер, чтобы не было ссылки на живой HEAPU8
    const copy = new Uint8Array(uint8Array);
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['saves'], 'readwrite');
        const store = tx.objectStore('saves');
        const request = store.put(copy, romName);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function loadSram(romName) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['saves'], 'readonly');
        const store = tx.objectStore('saves');
        const request = store.get(romName);
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

// Сохранение и загрузка ТОЧНОГО МОМЕНТА ИГРЫ (Save State) со сжатием
export async function saveQuickState(romName, rawStateUint8Array) {
    const compressed = await compressData(rawStateUint8Array);
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['states'], 'readwrite');
        const store = tx.objectStore('states');
        const request = store.put(compressed, romName);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

export async function loadQuickState(romName) {
    const db = await initDB();
    const compressed = await new Promise((resolve, reject) => {
        const tx = db.transaction(['states'], 'readonly');
        const store = tx.objectStore('states');
        const request = store.get(romName);
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
    if (!compressed) return null;
    return await decompressData(compressed);
}

export async function deleteQuickState(romName) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['states'], 'readwrite');
        const store = tx.objectStore('states');
        const request = store.delete(romName);
        request.onsuccess = () => resolve();
        request.onerror = (e) => reject(e.target.error);
    });
}

// Генерация Blob и скачивание файла <romName>.sav на устройство
export async function exportSaveFile(romName) {
    try {
        const uint8Array = await loadSram(romName);
        if (!uint8Array || uint8Array.byteLength === 0) {
            alert('Внутриигровое сохранение (.sav) не найдено! Сначала сохранитесь внутри самой игры через её меню.');
            return;
        }
        const cleanName = romName.replace(/\.nds$/i, '');
        const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${cleanName}.sav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Ошибка экспорта:', error);
    }
}

// Чтение .sav через FileReader и запись в IndexedDB
export function importSaveFile(romName, file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const arrayBuffer = e.target.result;
                const uint8Array = new Uint8Array(arrayBuffer);
                await saveSram(romName, uint8Array);
                resolve(uint8Array);
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = (e) => reject(e.target.error);
        reader.readAsArrayBuffer(file);
    });
}