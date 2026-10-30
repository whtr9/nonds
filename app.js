import { saveRomToCache, getCachedRom, loadSram, saveSram, exportSaveFile, importSaveFile } from './storage.js'; //[cite: 2]

// Проверка navigator.serviceWorker и регистрация sw.js[cite: 1, 2]
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js')
            .then((registration) => {
                console.log('Service Worker успешно зарегистрирован с областью видимости:', registration.scope);
            })
            .catch((error) => {
                console.error('Ошибка регистрации Service Worker:', error);
            });
    });
}

// Глобальные переменные эмулятора
let audioContext = null;
let isEmulatorInitialized = false;
let currentRomName = ''; // Переменная для отслеживания текущей запущенной игры

// 1. Регистрация Service Worker
// Проверка navigator.serviceWorker и регистрация sw.js для обеспечения офлайн-работы[cite: 1].
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js')
            .then(reg => console.log('Service Worker успешно зарегистрирован', reg))
            .catch(err => console.error('Ошибка регистрации Service Worker', err));
    });
}

// 2. Инициализация звука
// Инициализация звукового контекста (AudioContext — запускается строго после первого клика пользователя из-за политик автовоспроизведения браузеров)[cite: 1].
function initAudio() {
    if (!audioContext) {
        audioContext = new AudioContext();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

// 3. Обработка интерфейса загрузки
// Проверка наличия игры при обновлении страницы. Работа кнопки «Продолжить последнюю игру» активируется после загрузки кэша[cite: 1].
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const cachedRom = await getCachedRom();
        if (cachedRom && cachedRom.data) {
            const btnContinue = document.getElementById('btn-continue');
            btnContinue.disabled = false;
            btnContinue.addEventListener('click', () => {
                initAudio();
                loadEmulatorAndRun(cachedRom.name, new Uint8Array(cachedRom.data));
            });
        }
    } catch (error) {
        console.error('Ошибка при чтении кэшированного ROM из IndexedDB:', error);
    }
});

// Чтение файла из <input>, сохранение в storage.js и запуск[cite: 1].
document.getElementById('rom-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    initAudio();
    
    try {
        const arrayBuffer = await file.arrayBuffer();
        await saveRomToCache(file.name, arrayBuffer); 
        loadEmulatorAndRun(file.name, new Uint8Array(arrayBuffer));
    } catch (error) {
        console.error('Ошибка обработки ROM файла:', error);
    }
});

// 4. Инициализация эмулятора и запуск ROM
async function loadEmulatorAndRun(romName, romData) {
    // Загрузка модуля из /core/desmume.js[cite: 1].
    if (!isEmulatorInitialized) {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'core/desmume.js';
            script.onload = resolve;
            script.onerror = reject;
            document.body.appendChild(script);
            currentRomName = romName;
        });
        isEmulatorInitialized = true;
    }

    // Настройка объекта Emscripten
    window.Module = window.Module || {};
    
    // Привязка буферов рендеринга к <canvas>[cite: 1]. 
    // Примечание: Desmond-wasm может требовать передачи контекстов напрямую, 
    // здесь указана стандартная привязка для Emscripten-модулей.
    const topCanvas = document.getElementById('top-screen');
    const bottomCanvas = document.getElementById('bottom-screen');
    window.Module.canvas = topCanvas; 

    // Callback после того, как WASM среда готова
    const runGame = async () => {
        // Передача ROM в виртуальную файловую систему Emscripten (Module.FS)[cite: 1].
        window.Module.FS.writeFile(romName, romData);

        // Проверка наличия привязанного .sav в storage.js[cite: 1].
        const sramData = await loadSram(romName);
        if (sramData) {
            const savName = romName.replace(/\.nds$/i, '.sav');
            // Передача сохранения в методы ядра или виртуальную файловую систему[cite: 1].
            window.Module.FS.writeFile(savName, sramData);
        }

        // Запуск игры через экспортируемый метод ядра C++ 
        // (название функции зависит от конкретной сборки, например 'load_rom' или 'main')
        if (typeof window.Module.ccall === 'function') {
            window.Module.ccall('loadROM', 'void', ['string'], [romName]);
        }
    };

    if (window.Module.calledRun) {
        // Если WASM уже инициализирован
        runGame();
    } else {
        // Ожидание инициализации
        window.Module.onRuntimeInitialized = runGame;
    }

    // Примерная мапа клавиш для ядра DeSmuME (в зависимости от реализации WASM-порта значения могут отличаться)
    const keyMap = {
        'a': 0, 'b': 1, 'select': 2, 'start': 3,
        'right': 4, 'left': 5, 'up': 6, 'down': 7,
        'r': 8, 'l': 9, 'x': 10, 'y': 11
    };

// Привязка физических клавиш клавиатуры (keydown / keyup) для удобства игры с ПК[cite: 1].
    const keyboardMap = {
        'KeyX': 'a', 'KeyZ': 'b', 'ShiftRight': 'select', 'Enter': 'start',
        'ArrowRight': 'right', 'ArrowLeft': 'left', 'ArrowUp': 'up', 'ArrowDown': 'down',
        'KeyW': 'r', 'KeyQ': 'l', 'KeyS': 'x', 'KeyA': 'y'
    };

    function triggerButton(key, isPressed) {
        if (!isEmulatorInitialized || !key) return;
        const coreKeyCode = keyMap[key];
        
        // Вызов функции WASM ядра для эмуляции зажатия/отпускания клавиш[cite: 1].
        // Название метода ccall зависит от конкретной сборки ядра.
        if (typeof window.Module.ccall === 'function') {
            window.Module.ccall(
                isPressed ? 'simulateKeyDown' : 'simulateKeyUp', 
                'void', 
                ['number'], 
                [coreKeyCode]
            );
        }
    }

// Навешивание Pointer Events на экранные кнопки геймпада для поддержки мультитач (например, одновременное зажатие B и D-Pad)[cite: 1].
    document.querySelectorAll('.controls-overlay button[data-key]').forEach(btn => { //[cite: 1, 2]
        const key = btn.getAttribute('data-key'); //[cite: 2]

        btn.addEventListener('pointerdown', (e) => {
            e.preventDefault();
            btn.classList.add('active'); // Изменение прозрачности или смещение при нажатии[cite: 2]
            triggerButton(key, true);
        });

        const releaseButton = (e) => {
            e.preventDefault();
            btn.classList.remove('active'); //[cite: 2]
            triggerButton(key, false);
        };

        btn.addEventListener('pointerup', releaseButton); //[cite: 1]
        btn.addEventListener('pointercancel', releaseButton); //[cite: 1]
        btn.addEventListener('pointerleave', releaseButton); //[cite: 1]
    });

// Обработка событий клавиатуры[cite: 1]
    window.addEventListener('keydown', (e) => {
        const key = keyboardMap[e.code];
        if (key) triggerButton(key, true);
    });
    window.addEventListener('keyup', (e) => {
        const key = keyboardMap[e.code];
        if (key) triggerButton(key, false);
    });

/* ==========================================
   Этап 3: Управление (Стилус на нижнем экране)
   ========================================== */

    const bottomScreen = document.getElementById('bottom-screen'); //[cite: 1, 2]

// Вычисление координат клика относительно размера канваса и перевод их в масштаб 256x192 с передачей флага касания в ядро[cite: 1, 2].
    function handleTouchScreen(e, isTouching) {
        if (!isEmulatorInitialized) return;
        e.preventDefault();

        const rect = bottomScreen.getBoundingClientRect();
        
        let clientX = e.clientX;
        let clientY = e.clientY;

        // Вычисление координат стилуса 
        let x = Math.floor(((clientX - rect.left) / rect.width) * 256);
        let y = Math.floor(((clientY - rect.top) / rect.height) * 192);

        // Ограничение координат в пределах 256x192
        x = Math.max(0, Math.min(255, x));
        y = Math.max(0, Math.min(191, y));

        // Вызов функции WASM ядра для трансляции касаний стилуса
        if (typeof window.Module.ccall === 'function') {
            window.Module.ccall('touchScreen', 'void', ['number', 'number', 'boolean'], [x, y, isTouching]);
        }
    }

    bottomScreen.addEventListener('pointerdown', (e) => handleTouchScreen(e, true)); //[cite: 1]
    bottomScreen.addEventListener('pointermove', (e) => {
        if (e.buttons > 0) handleTouchScreen(e, true);
    }); //[cite: 1]
    bottomScreen.addEventListener('pointerup', (e) => handleTouchScreen(e, false)); //[cite: 1]

/* ==========================================
   Этап 3: Система сохранений (Автосохранение и Импорт/Экспорт)
   ========================================== */

// Настройка таймера для периодической записи во флеш-память эмулятора (SRAM) и выгрузки в storage.js[cite: 1].
    const AUTO_SAVE_INTERVAL_MS = 5000;
    setInterval(async () => {
        if (!isEmulatorInitialized || !currentRomName) return;

        // В зависимости от ядра, считывание .sav файла из виртуальной файловой системы Emscripten[cite: 1]
        const savName = currentRomName.replace(/\.nds$/i, '.sav');
        try {
            if (window.Module.FS.analyzePath(savName).exists) {
                const sramData = window.Module.FS.readFile(savName);
                await saveSram(currentRomName, sramData); // Автоматическое сохранение изменений данных SRAM в IndexedDB[cite: 1, 2]
            }
        } catch (error) {
            // Ошибка чтения/записи игнорируется, если файл еще не создан эмулятором
        }
    }, AUTO_SAVE_INTERVAL_MS);

// Обработчик кнопки «Экспорт .sav»[cite: 1, 2]
    document.getElementById('btn-export-sav').addEventListener('click', () => {
        if (currentRomName) {
            exportSaveFile(currentRomName); // Выгрузка файла .sav на устройство[cite: 1, 2]
        } else {
            alert("Сначала запустите игру!");
        }
    });

// Обработчик скрытого input для загрузки и повторного импорта .sav файла с устройства[cite: 1, 2]
    document.getElementById('sav-input').addEventListener('change', async (event) => {
        const file = event.target.files[0];
        if (!file) return;
        
        if (!currentRomName) {
            alert("Пожалуйста, сначала загрузите ROM, к которому относится это сохранение.");
            return;
        }

        try {
            const sramData = await importSaveFile(currentRomName, file); // Запись в IndexedDB и получение массива[cite: 1, 2]
            const savName = currentRomName.replace(/\.nds$/i, '.sav');
            
            if (isEmulatorInitialized) {
                // Передача загруженного файла сохранения в память работающего ядра[cite: 1, 2]
                window.Module.FS.writeFile(savName, sramData);
                alert("Сохранение успешно импортировано! Пожалуйста, перезапустите игру для применения (обновите страницу и нажмите 'Продолжить последнюю игру').");
            }
        } catch (error) {
            console.error('Ошибка импорта сохранения:', error);
        }
    });
}