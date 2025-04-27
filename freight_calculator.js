// Исправленная версия freight_calculator.js с экспортом по умолчанию
// для совместимости с server.js

// Модуль для агрегации данных из различных источников и расчета фрахтовой ставки

import { Pool } from 'pg';
import dotenv from 'dotenv';
import * as scfiScraper from './scfi_scraper.js';
import * as fbxScraper from './fbx_scraper.js';
import * as wciScraper from './wci_scraper.js';

// Загрузка переменных окружения
dotenv.config();

// Подключение к базе данных
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
    sslmode: 'require'
  }
});

// Функция для расчета базовой ставки фрахта на основе портов отправления и назначения
function calculateBaseRate(origin, destination) {
  console.log(`Calculating base rate for route ${origin.name} to ${destination.name}`);
  
  // Используем детерминированный алгоритм на основе полных названий портов
  // вместо случайных чисел или только первых символов
  
  // Создаем хеш на основе полных названий портов
  let originHash = 0;
  let destHash = 0;
  
  // Хеш-функция для строк
  for (let i = 0; i < origin.name.length; i++) {
    originHash = ((originHash << 5) - originHash) + origin.name.charCodeAt(i);
    originHash = originHash & originHash; // Преобразование в 32-битное целое
  }
  
  for (let i = 0; i < destination.name.length; i++) {
    destHash = ((destHash << 5) - destHash) + destination.name.charCodeAt(i);
    destHash = destHash & destHash; // Преобразование в 32-битное целое
  }
  
  // Используем абсолютные значения хешей для избежания отрицательных чисел
  originHash = Math.abs(originHash);
  destHash = Math.abs(destHash);
  
  // Базовая ставка: 1500 + модификатор на основе хешей портов
  // Модификатор ограничен диапазоном 0-1500 для предсказуемости
  const baseRate = 1500 + ((originHash + destHash) % 1500);
  
  console.log(`Base rate calculation details:
    Origin port: ${origin.name} (hash: ${originHash})
    Destination port: ${destination.name} (hash: ${destHash})
    Base rate: $${baseRate}`);
  
  return baseRate;
}

// Функция для расчета ставки фрахта с учетом всех факторов
async function calculateFreightRate(originPort, destinationPort, containerType, containerCount) {
  console.log(`Calculating freight rate for ${containerCount} x ${containerType.name} from ${originPort.name} to ${destinationPort.name}`);
  
  try {
    // Получение базовой ставки
    const baseRate = calculateBaseRate(originPort, destinationPort);
    
    // Получение данных из различных источников
    const sourcesData = await collectDataFromAllSources(originPort, destinationPort);
    
    // Массив для хранения данных о корректировках
    const adjustments = [];
    
    // Корректировка на основе типа контейнера
    const containerTypeMultiplier = getContainerTypeMultiplier(containerType.code);
    const containerAdjustment = baseRate * (containerTypeMultiplier - 1);
    adjustments.push({
      factor: 'Container Type',
      value: containerTypeMultiplier,
      adjustment: containerAdjustment
    });
    
    // Корректировка на основе количества контейнеров (скидка за объем)
    const volumeDiscount = calculateVolumeDiscount(containerCount);
    const volumeAdjustment = baseRate * -volumeDiscount; // Отрицательное значение, так как это скидка
    adjustments.push({
      factor: 'Volume Discount',
      value: volumeDiscount,
      adjustment: volumeAdjustment
    });
    
    // Корректировка на основе данных индексов
    let indexAdjustment = 0;
    
    // Если есть данные хотя бы из одного источника, используем их
    if (sourcesData.length > 0) {
      // Вычисляем среднее значение корректировки из всех источников
      const totalAdjustment = sourcesData.reduce((sum, data) => sum + data.adjustment, 0);
      indexAdjustment = totalAdjustment / sourcesData.length;
      
      // Добавляем информацию о каждом источнике в массив корректировок
      sourcesData.forEach(data => {
        adjustments.push({
          factor: `Index ${data.source}`,
          value: data.value,
          adjustment: data.adjustment
        });
      });
    } else {
      // Если нет данных ни из одного источника, используем стандартную корректировку
      indexAdjustment = baseRate * 0.05; // 5% от базовой ставки
      adjustments.push({
        factor: 'Standard Index',
        value: 0.05,
        adjustment: indexAdjustment
      });
    }
    
    // Расчет итоговой ставки
    const totalRate = baseRate + containerAdjustment + volumeAdjustment + indexAdjustment;
    
    // Возвращаем результат расчета
    return {
      baseRate: Math.round(totalRate), // Округляем до целого числа
      details: {
        baseCalculation: baseRate,
        adjustments,
        containerType: containerType.name,
        containerCount,
        sourcesData
      }
    };
  } catch (error) {
    console.error('Error calculating freight rate:', error);
    throw error;
  }
}

// Функция для сбора данных из всех источников
async function collectDataFromAllSources(originPort, destinationPort) {
  try {
    // Массив для хранения данных из различных источников
    const sourcesData = [];
    
    // Получение данных SCFI
    try {
      const scfiData = await scfiScraper.getSCFIDataForCalculation();
      if (scfiData && scfiData.value) {
        // Нормализация значения индекса (приведение к диапазону 0-1)
        const normalizedValue = scfiData.value / 2000; // Предполагаем, что максимальное значение SCFI около 2000
        
        // Расчет корректировки на основе значения индекса
        const adjustment = calculateBaseRate(originPort, destinationPort) * (normalizedValue - 0.5);
        
        sourcesData.push({
          source: 'SCFI',
          value: normalizedValue,
          adjustment,
          trend: scfiData.trend,
          date: scfiData.date
        });
      }
    } catch (error) {
      console.error('Error getting SCFI data:', error);
    }
    
    // Получение данных FBX
    try {
      const fbxData = await fbxScraper.getFBXDataForCalculation();
      if (fbxData && fbxData.value) {
        // Нормализация значения индекса
        const normalizedValue = fbxData.value / 5000; // Предполагаем, что максимальное значение FBX около 5000
        
        // Расчет корректировки
        const adjustment = calculateBaseRate(originPort, destinationPort) * (normalizedValue - 0.5);
        
        sourcesData.push({
          source: 'FBX',
          value: normalizedValue,
          adjustment,
          trend: fbxData.trend,
          date: fbxData.date
        });
      }
    } catch (error) {
      console.error('Error getting FBX data:', error);
    }
    
    // Получение данных WCI
    try {
      const wciData = await wciScraper.getWCIDataForCalculation();
      if (wciData && wciData.value) {
        // Нормализация значения индекса
        const normalizedValue = wciData.value / 4000; // Предполагаем, что максимальное значение WCI около 4000
        
        // Расчет корректировки
        const adjustment = calculateBaseRate(originPort, destinationPort) * (normalizedValue - 0.5);
        
        sourcesData.push({
          source: 'WCI',
          value: normalizedValue,
          adjustment,
          trend: wciData.trend,
          date: wciData.date
        });
      }
    } catch (error) {
      console.error('Error getting WCI data:', error);
    }
    
    return sourcesData;
  } catch (error) {
    console.error('Error collecting data from sources:', error);
    return [];
  }
}

// Функция для получения множителя на основе типа контейнера
function getContainerTypeMultiplier(containerTypeCode) {
  // Множители для различных типов контейнеров
  const multipliers = {
    '20DC': 1.0,  // 20-футовый сухой контейнер (базовый)
    '40DC': 1.8,  // 40-футовый сухой контейнер
    '40HC': 2.0,  // 40-футовый высокий контейнер
    '20RF': 2.2,  // 20-футовый рефрижераторный контейнер
    '40RF': 3.0,  // 40-футовый рефрижераторный контейнер
    '20OT': 1.5,  // 20-футовый контейнер с открытым верхом
    '40OT': 2.2,  // 40-футовый контейнер с открытым верхом
    '20FR': 1.7,  // 20-футовый контейнер-платформа
    '40FR': 2.5   // 40-футовый контейнер-платформа
  };
  
  // Возвращаем множитель для указанного типа контейнера или 1.0, если тип не найден
  return multipliers[containerTypeCode] || 1.0;
}

// Функция для расчета скидки за объем
function calculateVolumeDiscount(containerCount) {
  // Скидка за объем в зависимости от количества контейнеров
  if (containerCount >= 100) {
    return 0.25; // 25% скидка для 100+ контейнеров
  } else if (containerCount >= 50) {
    return 0.20; // 20% скидка для 50-99 контейнеров
  } else if (containerCount >= 20) {
    return 0.15; // 15% скидка для 20-49 контейнеров
  } else if (containerCount >= 10) {
    return 0.10; // 10% скидка для 10-19 контейнеров
  } else if (containerCount >= 5) {
    return 0.05; // 5% скидка для 5-9 контейнеров
  } else {
    return 0.0; // Нет скидки для менее 5 контейнеров
  }
}

// Функция для обновления данных из всех источников
async function updateAllSourcesData() {
  try {
    console.log('Updating data from all sources...');
    
    // Обновление данных SCFI
    try {
      await scfiScraper.fetchSCFIData();
      console.log('SCFI data updated successfully');
    } catch (error) {
      console.error('Error updating SCFI data:', error);
    }
    
    // Обновление данных FBX
    try {
      await fbxScraper.fetchFBXData();
      console.log('FBX data updated successfully');
    } catch (error) {
      console.error('Error updating FBX data:', error);
    }
    
    // Обновление данных WCI
    try {
      await wciScraper.fetchWCIData();
      console.log('WCI data updated successfully');
    } catch (error) {
      console.error('Error updating WCI data:', error);
    }
    
    console.log('All sources data updated');
    return true;
  } catch (error) {
    console.error('Error updating sources data:', error);
    return false;
  }
}

// Экспорт функций в формате ES модулей
export { calculateFreightRate, updateAllSourcesData };

// Экспорт по умолчанию для обратной совместимости
export default { calculateFreightRate, updateAllSourcesData };
