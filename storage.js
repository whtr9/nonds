// Изолирующий модуль IndexedDB (база NDS_Emulator_DB, версия 1)[cite: 1]
const DB_NAME = 'NDS_Emulator_DB';
const DB_VERSION = 1;

// Создание хранилищ roms и saves[cite: 1]
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
        };

        request.onsuccess = (event) => resolve(event.target.result);
        request.onerror = (event) => reject(event.target.error);
    });
}

// Запись и чтение последней игры[cite: 1]
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

// Сохранение и извлечение игрового прогресса (SRAM) внутри браузера[cite: 1]
export async function saveSram(romName, uint8Array) {
    const db = await initDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(['saves'], 'readwrite');
        const store = tx.objectStore('saves');
        const request = store.put(uint8Array, romName);
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

// Генерация Blob и автоматическое скачивание файла <romName>.sav на устройство[cite: 1]
export async function exportSaveFile(romName) {
    try {
        const uint8Array = await loadSram(romName);
        if (!uint8Array) {
            console.error('Сохранение не найдено в кэше');
            return;
        }
        const blob = new Blob([uint8Array], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${romName}.sav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (error) {
        console.error('Ошибка экспорта:', error);
    }
}

// Чтение .sav через FileReader, запись в IndexedDB и возврат массива для ядра[cite: 1]
export function importSaveFile(romName, file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const arrayBuffer = e.target.result;
                const uint8Array = new Uint8Array(arrayBuffer);
                await saveSram(romName, uint8Array);
                resolve(uint8Array); // Данные готовы для передачи в память работающего ядра[cite: 1]
            } catch (err) {
                reject(err);
            }
        };
        reader.onerror = (e) => reject(e.target.error);
        reader.readAsArrayBuffer(file);
    });
}