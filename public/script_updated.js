// Обновленный клиентский JavaScript для калькулятора ставок фрахта
// Включает функциональность поиска ближайших портов и верификации email

document.addEventListener('DOMContentLoaded', function() {
    // Элементы формы
    const calculatorForm = document.getElementById('calculatorForm');
    const originSelect = document.getElementById('origin');
    const destinationSelect = document.getElementById('destination');
    const containerTypeSelect = document.getElementById('containerType');
    const emailInput = document.getElementById('email');
    const resultContainer = document.getElementById('resultContainer');
    
    // Элементы для отображения результатов
    const routeDisplay = document.getElementById('routeDisplay');
    const containerDisplay = document.getElementById('containerDisplay');
    const dateDisplay = document.getElementById('dateDisplay');
    const minRateDisplay = document.getElementById('minRate');
    const avgRateDisplay = document.getElementById('avgRate');
    const maxRateDisplay = document.getElementById('maxRate');
    const rateIndicator = document.getElementById('rateIndicator');
    const sourceCountDisplay = document.getElementById('sourceCount');
    const reliabilityDisplay = document.getElementById('reliability');
    
    // Элементы для поиска портов
    const originSearch = document.createElement('input');
    originSearch.type = 'text';
    originSearch.placeholder = 'Поиск порта отправления...';
    originSearch.className = 'w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 mb-2';
    
    const destinationSearch = document.createElement('input');
    destinationSearch.type = 'text';
    destinationSearch.placeholder = 'Поиск порта назначения...';
    destinationSearch.className = 'w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500 mb-2';
    
    // Добавляем поля поиска перед селектами
    originSelect.parentNode.insertBefore(originSearch, originSelect);
    destinationSelect.parentNode.insertBefore(destinationSearch, destinationSelect);
    
    // Элементы для запроса на добавление порта
    const requestPortButton = document.createElement('button');
    requestPortButton.type = 'button';
    requestPortButton.textContent = 'Запросить добавление порта';
    requestPortButton.className = 'text-sm text-blue-600 hover:text-blue-800 mt-1 cursor-pointer';
    
    // Добавляем кнопку запроса порта после селекта назначения
    destinationSelect.parentNode.appendChild(requestPortButton);
    
    // Модальное окно для запроса порта
    const portRequestModal = document.createElement('div');
    portRequestModal.className = 'fixed inset-0 bg-gray-600 bg-opacity-50 flex items-center justify-center hidden';
    portRequestModal.id = 'portRequestModal';
    
    portRequestModal.innerHTML = `
        <div class="bg-white rounded-lg shadow-lg p-6 w-full max-w-md">
            <h3 class="text-lg font-medium text-gray-900 mb-4">Запрос на добавление порта</h3>
            <form id="portRequestForm" class="space-y-4">
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Название порта</label>
                    <input type="text" id="portName" class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500" required>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Страна</label>
                    <input type="text" id="portCountry" class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500" required>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Регион</label>
                    <select id="portRegion" class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500">
                        <option value="Europe">Европа</option>
                        <option value="Asia">Азия</option>
                        <option value="North America">Северная Америка</option>
                        <option value="South America">Южная Америка</option>
                        <option value="Africa">Африка</option>
                        <option value="Oceania">Океания</option>
                        <option value="Middle East">Ближний Восток</option>
                    </select>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Причина запроса</label>
                    <textarea id="requestReason" class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500" rows="3"></textarea>
                </div>
                <div>
                    <label class="block text-sm font-medium text-gray-700 mb-1">Email</label>
                    <input type="email" id="requestEmail" class="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-blue-500 focus:border-blue-500" required>
                </div>
                <div class="flex justify-end space-x-3">
                    <button type="button" id="cancelPortRequest" class="px-4 py-2 bg-gray-200 text-gray-800 font-medium rounded-md shadow-sm hover:bg-gray-300 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-gray-500 transition-colors">
                        Отмена
                    </button>
                    <button type="submit" class="px-4 py-2 bg-blue-600 text-white font-medium rounded-md shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 transition-colors">
                        Отправить запрос
                    </button>
                </div>
            </form>
        </div>
    `;
    
    document.body.appendChild(portRequestModal);
    
    // Обработчики для модального окна запроса порта
    requestPortButton.addEventListener('click', function() {
        document.getElementById('portRequestModal').classList.remove('hidden');
        document.getElementById('requestEmail').value = emailInput.value;
    });
    
    document.getElementById('cancelPortRequest').addEventListener('click', function() {
        document.getElementById('portRequestModal').classList.add('hidden');
    });
    
    document.getElementById('portRequestForm').addEventListener('submit', function(e) {
        e.preventDefault();
        
        const portName = document.getElementById('portName').value;
        const country = document.getElementById('portCountry').value;
        const region = document.getElementById('portRegion').value;
        const requestReason = document.getElementById('requestReason').value;
        const userEmail = document.getElementById('requestEmail').value;
        
        // Валидация email
        validateEmail(userEmail)
            .then(result => {
                if (!result.isValid) {
                    alert(result.message || 'Неверный формат email');
                    return;
                }
                
                // Отправка запроса на добавление порта
                fetch('/api/ports/request', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        portName,
                        country,
                        region,
                        requestReason,
                        userEmail
                    })
                })
                .then(response => response.json())
                .then(data => {
                    if (data.success) {
                        alert('Запрос на добавление порта успешно отправлен');
                        document.getElementById('portRequestModal').classList.add('hidden');
                    } else {
                        alert(data.error || 'Ошибка при отправке запроса');
                    }
                })
                .catch(error => {
                    console.error('Error:', error);
                    alert('Произошла ошибка при отправке запроса');
                });
            });
    });
    
    // Функция для загрузки портов
    function loadPorts() {
        fetch('/api/ports')
            .then(response => response.json())
            .then(ports => {
                // Сортировка портов по региону и стране
                ports.sort((a, b) => {
                    if (a.region !== b.region) {
                        return a.region.localeCompare(b.region);
                    }
                    if (a.country !== b.country) {
                        return a.country.localeCompare(b.country);
                    }
                    return a.name.localeCompare(b.name);
                });
                
                // Группировка портов по региону и стране
                const portsByRegion = {};
                ports.forEach(port => {
                    if (!portsByRegion[port.region]) {
                        portsByRegion[port.region] = {};
                    }
                    if (!portsByRegion[port.region][port.country]) {
                        portsByRegion[port.region][port.country] = [];
                    }
                    portsByRegion[port.region][port.country].push(port);
                });
                
                // Очистка селектов
                originSelect.innerHTML = '<option value="">Выберите порт отправления</option>';
                destinationSelect.innerHTML = '<option value="">Выберите порт назначения</option>';
                
                // Заполнение селектов с группировкой
                Object.keys(portsByRegion).forEach(region => {
                    const regionGroup = document.createElement('optgroup');
                    regionGroup.label = region;
                    
                    Object.keys(portsByRegion[region]).forEach(country => {
                        const countryGroup = document.createElement('optgroup');
                        countryGroup.label = country;
                        
                        portsByRegion[region][country].forEach(port => {
                            const option = document.createElement('option');
                            option.value = port.id;
                            option.textContent = port.name;
                            option.dataset.latitude = port.latitude;
                            option.dataset.longitude = port.longitude;
                            countryGroup.appendChild(option);
                        });
                        
                        regionGroup.appendChild(countryGroup);
                    });
                    
                    originSelect.appendChild(regionGroup.cloneNode(true));
                    destinationSelect.appendChild(regionGroup);
                });
            })
            .catch(error => {
                console.error('Error loading ports:', error);
                alert('Ошибка при загрузке списка портов');
            });
    }
    
    // Функция для загрузки типов контейнеров
    function loadContainerTypes() {
        fetch('/api/container-types')
            .then(response => response.json())
            .then(containerTypes => {
                containerTypeSelect.innerHTML = '<option value="">Выберите тип контейнера</option>';
                
                containerTypes.forEach(type => {
                    const option = document.createElement('option');
                    option.value = type.id;
                    option.textContent = type.name;
                    option.title = type.description;
                    containerTypeSelect.appendChild(option);
                });
            })
            .catch(error => {
                console.error('Error loading container types:', error);
                alert('Ошибка при загрузке типов контейнеров');
            });
    }
    
    // Функция для поиска портов
    function searchPorts(query, callback) {
        fetch(`/api/ports/search?query=${encodeURIComponent(query)}`)
            .then(response => response.json())
            .then(ports => {
                callback(ports);
            })
            .catch(error => {
                console.error('Error searching ports:', error);
                callback([]);
            });
    }
    
    // Функция для валидации email
    function validateEmail(email) {
        return fetch('/api/validate-email', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ email })
        })
        .then(response => response.json())
        .catch(error => {
            console.error('Error validating email:', error);
            return { isValid: false, message: 'Ошибка при проверке email' };
        });
    }
    
    // Функция для поиска ближайших портов
    function findNearestPorts(latitude, longitude, callback) {
        fetch(`/api/ports/nearest?latitude=${latitude}&longitude=${longitude}`)
            .then(response => response.json())
            .then(ports => {
                callback(ports);
            })
            .catch(error => {
                console.error('Error finding nearest ports:', error);
                callback([]);
            });
    }
    
    // Функция для расчета ставки фрахта
    function calculateFreightRate(origin, destination, containerType, email) {
        // Сначала валидируем email
        validateEmail(email)
            .then(result => {
                if (!result.isValid) {
                    alert(result.message || 'Неверный формат email');
                    return;
                }
                
                // Если email валиден, отправляем запрос на расчет ставки
                fetch('/api/calculate', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        origin,
                        destination,
                        containerType,
                        email
                    })
                })
                .then(response => response.json())
                .then(data => {
                    if (data.error) {
                        alert(data.error);
                        return;
                    }
                    
                    // Отображение результатов
                    displayResults(data, origin, destination, containerType);
                })
                .catch(error => {
                    console.error('Error:', error);
                    alert('Произошла ошибка при расчете ставки фрахта');
                });
            });
    }
    
    // Функция для отображения результатов
    function displayResults(data, origin, destination, containerType) {
        // Получаем названия портов из селектов
        const originName = originSelect.options[originSelect.selectedIndex].text;
        const destinationName = destinationSelect.options[destinationSelect.selectedIndex].text;
        const containerName = containerTypeSelect.options[containerTypeSelect.selectedIndex].text;
        
        // Заполняем информацию о маршруте
        routeDisplay.textContent = `${originName} → ${destinationName}`;
        containerDisplay.textContent = containerName;
        dateDisplay.textContent = new Date().toLocaleDateString();
        
        // Заполняем информацию о ставке
        minRateDisplay.textContent = `$${data.min_rate}`;
        avgRateDisplay.textContent = `$${data.rate}`;
        maxRateDisplay.textContent = `$${data.max_rate}`;
        
        // Устанавливаем позицию индикатора ставки
        const range = data.max_rate - data.min_rate;
        const position = range > 0 ? ((data.rate - data.min_rate) / range) * 100 : 50;
        rateIndicator.style.width = `${position}%`;
        
        // Заполняем информацию о надежности
        sourceCountDisplay.textContent = data.source_count;
        reliabilityDisplay.textContent = `${Math.round(data.reliability * 100)}%`;
        
        // Показываем блок с результатами
        resultContainer.classList.remove('hidden');
        
        // Прокручиваем страницу к результатам
        resultContainer.scrollIntoView({ behavior: 'smooth' });
    }
    
    // Обработчик отправки формы
    calculatorForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        const origin = originSelect.value;
        const destination = destinationSelect.value;
        const containerType = containerTypeSelect.value;
        const email = emailInput.value;
        
        // Проверка заполнения всех полей
        if (!origin || !destination || !containerType || !email) {
            alert('Пожалуйста, заполните все поля формы');
            return;
        }
        
        // Расчет ставки фрахта
        calculateFreightRate(origin, destination, containerType, email);
    });
    
    // Обработчики для поиска портов
    let originSearchTimeout, destinationSearchTimeout;
    
    originSearch.addEventListener('input', function() {
        clearTimeout(originSearchTimeout);
        originSearchTimeout = setTimeout(() => {
            const query = this.value.trim();
            if (query.length >= 2) {
                searchPorts(query, ports => {
                    // Очистка селекта
                    originSelect.innerHTML = '<option value="">Выберите порт отправления</option>';
                    
                    // Заполнение селекта результатами поиска
                    ports.forEach(port => {
                        const option = document.createElement('option');
                        option.value = port.id;
                        option.textContent = `${port.name}, ${port.country}`;
                        option.dataset.latitude = port.latitude;
                        option.dataset.longitude = port.longitude;
                        originSelect.appendChild(option);
                    });
                    
                    // Если результатов нет, показываем сообщение
                    if (ports.length === 0) {
                        const option = document.createElement('option');
                        option.disabled = true;
                        option.textContent = 'Порты не найдены';
                        originSelect.appendChild(option);
                    }
                });
            } else if (query.length === 0) {
                // Если поле поиска пустое, загружаем все порты
                loadPorts();
            }
        }, 300);
    });
    
    destinationSearch.addEventListener('input', function() {
        clearTimeout(destinationSearchTimeout);
        destinationSearchTimeout = setTimeout(() => {
            const query = this.value.trim();
            if (query.length >= 2) {
                searchPorts(query, ports => {
                    // Очистка селекта
                    destinationSelect.innerHTML = '<option value="">Выберите порт назначения</option>';
                    
                    // Заполнение селекта результатами поиска
                    ports.forEach(port => {
                        const option = document.createElement('option');
                        option.value = port.id;
                        option.textContent = `${port.name}, ${port.country}`;
                        option.dataset.latitude = port.latitude;
                        option.dataset.longitude = port.longitude;
                        destinationSelect.appendChild(option);
                    });
                    
                    // Если результатов нет, показываем сообщение
                    if (ports.length === 0) {
                        const option = document.createElement('option');
                        option.disabled = true;
                        option.textContent = 'Порты не найдены';
                        destinationSelect.appendChild(option);
                    }
                });
            } else if (query.length === 0) {
                // Если поле поиска пустое, загружаем все порты
                loadPorts();
            }
        }, 300);
    });
    
    // Функция для определения местоположения пользователя
    function getUserLocation() {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition(
                position => {
                    const { latitude, longitude } = position.coords;
                    
                    // Поиск ближайших портов
                    findNearestPorts(latitude, longitude, ports => {
                        if (ports.length > 0) {
                            // Создаем кнопку для выбора ближайшего порта
                            const nearestPortButton = document.createElement('button');
                            nearestPortButton.type = 'button';
                            nearestPortButton.textContent = `Ближайший порт: ${ports[0].name}, ${ports[0].country}`;
                            nearestPortButton.className = 'text-sm text-blue-600 hover:text-blue-800 mt-1 cursor-pointer block';
                            nearestPortButton.onclick = function() {
                                originSelect.value = ports[0].id;
                            };
                            
                            // Добавляем кнопку после поля поиска порта отправления
                            if (!document.getElementById('nearestPortButton')) {
                                nearestPortButton.id = 'nearestPortButton';
                                originSearch.parentNode.insertBefore(nearestPortButton, originSelect);
                            }
                        }
                    });
                },
                error => {
                    console.error('Error getting user location:', error);
                }
            );
        }
    }
    
    // Инициализация
    loadPorts();
    loadContainerTypes();
    getUserLocation();
    
    // Установка текущего года в футере
    document.getElementById('currentYear').textContent = new Date().getFullYear();
});
