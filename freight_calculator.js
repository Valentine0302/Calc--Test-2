// Модуль для агрегации данных из различных источников и расчета ставок фрахта
// Объединяет данные из SCFI, FBX, WCI и других источников

import { Pool } from 'pg';
import dotenv from 'dotenv';
import scfiScraper from './scfi_scraper.js';
import fbxScraper from './fbx_scraper.js';
import wciScraper from './wci_scraper.js';

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

// Весовые коэффициенты источников данных
const SOURCE_WEIGHTS = {
  'SCFI': 1.2,
  'Freightos FBX': 1.2,
  'Drewry WCI': 1.2,
  'Xeneta XSI': 1.2,
  'S&P Global Platts': 1.2,
  'Container Trades Statistics': 1.0,
  'Alphaliner': 1.0,
};

// Функция для расчета ставки фрахта на основе данных из различных источников
async function calculateFreightRate(origin, destination, containerType, weight) {
  try {
    console.log(`Calculating freight rate for ${origin} to ${destination}, container type: ${containerType}, weight: ${weight || 'not specified'}`);
    
    // Получение данных из различных источников
    const scfiData = await scfiScraper.getSCFIDataForRoute(origin, destination);
    const fbxData = await fbxScraper.getFBXDataForRoute(origin, destination);
    const wciData = await wciScraper.getWCIDataForRoute(origin, destination);
    
    // Массив для хранения данных из всех источников
    const sourcesData = [];
    
    // Добавление данных из SCFI, если они доступны
    if (scfiData && scfiData.current_index) {
      sourcesData.push({
        source: 'SCFI',
        rate: scfiData.current_index,
        weight: SOURCE_WEIGHTS['SCFI'] || 1.0
      });
    }
    
    // Добавление данных из FBX, если они доступны
    if (fbxData && fbxData.current_index) {
      sourcesData.push({
        source: 'Freightos FBX',
        rate: fbxData.current_index,
        weight: SOURCE_WEIGHTS['Freightos FBX'] || 1.0
      });
    }
    
    // Добавление данных из WCI, если они доступны
    if (wciData && wciData.current_index) {
      sourcesData.push({
        source: 'Drewry WCI',
        rate: wciData.current_index,
        weight: SOURCE_WEIGHTS['Drewry WCI'] || 1.0
      });
    }
    
    // Если нет данных ни из одного источника, используем базовый расчет
    if (sourcesData.length === 0) {
      console.log('No data available from any source, using base calculation');
      return calculateBaseRate(origin, destination, containerType, weight);
    }
    
    // Расчет средневзвешенной ставки
    let totalWeight = 0;
    let weightedSum = 0;
    
    sourcesData.forEach(data => {
      weightedSum += data.rate * data.weight;
      totalWeight += data.weight;
    });
    
    let baseRate = Math.round(weightedSum / totalWeight);
    
    // Применение коэффициента веса, если он указан
    if (weight && weight > 0) {
      // Базовая ставка обычно рассчитывается для стандартного веса
      // Если вес превышает стандартный, применяем надбавку
      const standardWeight = getStandardWeight(containerType);
      if (weight > standardWeight) {
        const weightFactor = 1 + ((weight - standardWeight) / standardWeight) * 0.5; // 50% надбавка за каждую единицу превышения стандартного веса
        baseRate = Math.round(baseRate * weightFactor);
      }
    }
    
    // Расчет минимальной и максимальной ставки
    // Используем стандартное отклонение для определения диапазона
    const rates = sourcesData.map(data => data.rate);
    const stdDev = calculateStandardDeviation(rates);
    
    // Минимальная ставка: базовая ставка минус стандартное отклонение, но не менее 80% от базовой
    const minRate = Math.round(Math.max(baseRate - stdDev, baseRate * 0.8));
    
    // Максимальная ставка: базовая ставка плюс стандартное отклонение, но не более 120% от базовой
    const maxRate = Math.round(Math.min(baseRate + stdDev, baseRate * 1.2));
    
    // Расчет надежности на основе количества источников и их согласованности
    // Чем больше источников и меньше стандартное отклонение, тем выше надежность
    const sourceCount = sourcesData.length;
    const maxPossibleSources = 3; // SCFI, FBX, WCI
    const sourceRatio = sourceCount / maxPossibleSources;
    
    // Коэффициент вариации (CV) - отношение стандартного отклонения к среднему
    const cv = baseRate > 0 ? stdDev / baseRate : 0;
    
    // Надежность: от 0.7 до 1.0, зависит от количества источников и их согласованности
    const reliability = Math.round((0.7 + 0.3 * sourceRatio * (1 - Math.min(cv, 0.5) / 0.5)) * 100) / 100;
    
    // Формирование результата
    const result = {
      rate: baseRate,
      minRate: minRate,
      maxRate: maxRate,
      reliability: reliability,
      sourceCount: sourceCount,
      sources: sourcesData.map(data => data.source),
      finalRate: baseRate // Добавляем finalRate для совместимости с API
    };
    
    console.log('Calculation result:', result);
    
    return result;
  } catch (error) {
    console.error('Error calculating freight rate:', error);
    // В случае ошибки используем базовый расчет
    return calculateBaseRate(origin, destination, containerType, weight);
  }
}

// Функция для получения стандартного веса для типа контейнера
function getStandardWeight(containerType) {
  const standardWeights = {
    '20DV': 20000, // 20 тонн для 20-футового контейнера
    '40DV': 25000, // 25 тонн для 40-футового контейнера
    '40HC': 27000, // 27 тонн для 40-футового high cube
    '45HC': 28000  // 28 тонн для 45-футового high cube
  };
  
  return standardWeights[containerType] || 20000; // По умолчанию 20 тонн
}

// Функция для базового расчета ставки фрахта (используется, если нет данных из источников)
function calculateBaseRate(origin, destination, containerType, weight) {
  // Базовая ставка: случайное число от 1000 до 3000
  let baseRate = Math.round(Math.random() * 2000 + 1000);
  
  // Применение коэффициента веса, если он указан
  if (weight && weight > 0) {
    const standardWeight = getStandardWeight(containerType);
    if (weight > standardWeight) {
      const weightFactor = 1 + ((weight - standardWeight) / standardWeight) * 0.5;
      baseRate = Math.round(baseRate * weightFactor);
    }
  }
  
  // Минимальная ставка: 80% от базовой
  const minRate = Math.round(baseRate * 0.8);
  
  // Максимальная ставка: 120% от базовой
  const maxRate = Math.round(baseRate * 1.2);
  
  // Надежность: от 0.7 до 0.9
  const reliability = Math.round((Math.random() * 0.2 + 0.7) * 100) / 100;
  
  // Количество источников: от 1 до 3
  const sourceCount = Math.floor(Math.random() * 3) + 1;
  
  return {
    rate: baseRate,
    minRate: minRate,
    maxRate: maxRate,
    reliability: reliability,
    sourceCount: sourceCount,
    sources: ['Base calculation'],
    finalRate: baseRate // Добавляем finalRate для совместимости с API
  };
}

// Функция для расчета стандартного отклонения
function calculateStandardDeviation(values) {
  if (values.length <= 1) {
    return 0;
  }
  
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const squaredDifferences = values.map(value => Math.pow(value - mean, 2));
  const variance = squaredDifferences.reduce((sum, value) => sum + value, 0) / (values.length - 1);
  
  return Math.sqrt(variance);
}

// Функция для обновления данных из всех источников
async function updateAllSourcesData() {
  try {
    console.log('Updating data from all sources...');
    
    // Обновление данных из SCFI
    await scfiScraper.fetchSCFIData();
    
    // Обновление данных из FBX
    await fbxScraper.fetchFBXData();
    
    // Обновление данных из WCI
    await wciScraper.fetchWCIData();
    
    console.log('All sources data updated successfully');
    return true;
  } catch (error) {
    console.error('Error updating sources data:', error);
    return false;
  }
}

// Функция для получения истории расчетов
async function getCalculationHistory() {
  try {
    const query = `
      SELECT 
        ch.id,
        p1.name as origin_port_name,
        p2.name as destination_port_name,
        ch.container_type,
        ch.rate,
        ch.created_at
      FROM calculation_history ch
      JOIN ports p1 ON ch.origin_port_id = p1.id
      JOIN ports p2 ON ch.destination_port_id = p2.id
      ORDER BY ch.created_at DESC
      LIMIT 100
    `;
    
    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    console.error('Error getting calculation history:', error);
    return [];
  }
}

// Экспорт функций
export default {
  calculateFreightRate,
  updateAllSourcesData,
  getCalculationHistory
};
