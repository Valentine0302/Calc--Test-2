/ Улучшенный калькулятор фрахтовых ставок с интеграцией всех доступных источников данных
// и поддержкой анализа сезонности

import { Pool } from 'pg';
import dotenv from 'dotenv';

// Импорт скраперов для различных индексов
import scfiScraper from './scfi_scraper.js';
import fbxScraper from './fbx_scraper.js';
import wciScraper from './wci_scraper.js';
import bdiScraper from './bdi_scraper.js';
import ccfiScraper from './ccfi_scraper.js';
import harpexScraper from './harpex_scraper.js';
import xenetaScraper from './xeneta_scraper.js';
import contexScraper from './contex_scraper.js';
import istfixScraper from './istfix_scraper.js';
import ctsScraper from './cts_scraper.js';

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

// Весовые коэффициенты для различных источников данных
const SOURCE_WEIGHTS = {
  'SCFI': 1.2,
  'CCFI': 1.2,
  'Freightos FBX': 1.2,
  'Drewry WCI': 1.2,
  'BDI': 0.8,
  'Harpex': 0.9,
  'Xeneta XSI': 1.1,
  'New ConTex': 1.0,
  'ISTFIX': 0.9,
  'CTS': 1.0
};

// Коэффициенты нормализации для приведения разных индексов к сопоставимым значениям
const NORMALIZATION_FACTORS = {
  'SCFI': 0.5,
  'CCFI': 0.5,
  'Freightos FBX': 1.0,
  'Drewry WCI': 1.0,
  'BDI': 0.3,
  'Harpex': 0.7,
  'Xeneta XSI': 0.6,
  'New ConTex': 0.8,
  'ISTFIX': 0.7,
  'CTS': 0.9
};

// Базовые сезонные коэффициенты по месяцам
const BASE_SEASONALITY_FACTORS = {
  1: 0.95,  // Январь
  2: 0.90,  // Февраль
  3: 0.95,  // Март
  4: 1.00,  // Апрель
  5: 1.05,  // Май
  6: 1.10,  // Июнь
  7: 1.15,  // Июль
  8: 1.15,  // Август
  9: 1.10,  // Сентябрь
  10: 1.05, // Октябрь
  11: 1.00, // Ноябрь
  12: 0.95  // Декабрь
};

// Функция для расчета фрахтовой ставки
async function calculateFreightRate(originPort, destinationPort, containerType, weight) {
  try {
    console.log(`Calculating freight rate for route ${originPort} to ${destinationPort}, container type: ${containerType}, weight: ${weight}`);
    
    // Получение данных о портах
    const originPortData = await getPortById(originPort);
    const destinationPortData = await getPortById(destinationPort);
    
    if (!originPortData || !destinationPortData) {
      throw new Error('Port data not found');
    }
    
    // Получение данных из всех доступных источников
    const sourceData = await collectDataFromAllSources(originPortData, destinationPortData);
    
    // Если нет данных ни из одного источника, возвращаем ошибку
    if (Object.keys(sourceData).length === 0) {
      throw new Error('No data available from any source');
    }
    
    // Расчет средневзвешенной ставки
    const { weightedRate, reliability, minRate, maxRate } = calculateWeightedRate(sourceData);
    
    // Получение коэффициента сезонности
    const seasonalityFactor = await getSeasonalityFactor(originPortData.region, destinationPortData.region);
    
    // Применение коэффициента сезонности
    const seasonalRate = weightedRate * seasonalityFactor;
    
    // Расчет топливной надбавки
    const fuelSurcharge = await calculateFuelSurcharge(originPortData, destinationPortData, containerType);
    
    // Расчет итоговой ставки с учетом типа контейнера и веса
    const finalRate = calculateFinalRate(seasonalRate, containerType, weight, fuelSurcharge);
    
    // Сохранение результата расчета в историю
    await saveCalculationHistory(originPort, destinationPort, containerType, weight, finalRate, reliability);
    
    // Возвращаем результат
    return {
      originPort: originPortData.name,
      destinationPort: destinationPortData.name,
      containerType,
      weight,
      baseRate: weightedRate,
      seasonalityFactor,
      seasonalRate,
      fuelSurcharge,
      finalRate,
      minRate: minRate * seasonalityFactor,
      maxRate: maxRate * seasonalityFactor,
      reliability,
      currency: 'USD',
      sourcesUsed: Object.keys(sourceData)
    };
  } catch (error) {
    console.error('Error calculating freight rate:', error);
    throw error;
  }
}

// Функция для сбора данных из всех доступных источников
async function collectDataFromAllSources(originPort, destinationPort) {
  const sourceData = {};
  
  try {
    // Получение данных SCFI
    const scfiData = await scfiScraper.getSCFIDataForRoute(originPort.id, destinationPort.id);
    if (scfiData) {
      sourceData['SCFI'] = {
        rate: scfiData.current_index,
        weight: SOURCE_WEIGHTS['SCFI'],
        normalizationFactor: NORMALIZATION_FACTORS['SCFI']
      };
    }
    
    // Получение данных FBX
    const fbxData = await fbxScraper.getFBXDataForRoute(originPort.id, destinationPort.id);
    if (fbxData) {
      sourceData['Freightos FBX'] = {
        rate: fbxData.current_index,
        weight: SOURCE_WEIGHTS['Freightos FBX'],
        normalizationFactor: NORMALIZATION_FACTORS['Freightos FBX']
      };
    }
    
    // Получение данных WCI
    const wciData = await wciScraper.getWCIDataForRoute(originPort.id, destinationPort.id);
    if (wciData) {
      sourceData['Drewry WCI'] = {
        rate: wciData.current_index,
        weight: SOURCE_WEIGHTS['Drewry WCI'],
        normalizationFactor: NORMALIZATION_FACTORS['Drewry WCI']
      };
    }
    
    // Получение данных BDI
    const bdiData = await bdiScraper.getBDIDataForCalculation();
    if (bdiData) {
      sourceData['BDI'] = {
        rate: bdiData.current_index,
        weight: SOURCE_WEIGHTS['BDI'],
        normalizationFactor: NORMALIZATION_FACTORS['BDI']
      };
    }
    
    // Получение данных CCFI
    const ccfiData = await ccfiScraper.getCCFIDataForRoute(originPort.id, destinationPort.id);
    if (ccfiData) {
      sourceData['CCFI'] = {
        rate: ccfiData.current_index,
        weight: SOURCE_WEIGHTS['CCFI'],
        normalizationFactor: NORMALIZATION_FACTORS['CCFI']
      };
    }
    
    // Получение данных Harpex
    const harpexData = await harpexScraper.getHarpexDataForCalculation();
    if (harpexData) {
      sourceData['Harpex'] = {
        rate: harpexData.current_index,
        weight: SOURCE_WEIGHTS['Harpex'],
        normalizationFactor: NORMALIZATION_FACTORS['Harpex']
      };
    }
    
    // Получение данных Xeneta XSI
    const xenetaData = await xenetaScraper.getXenetaDataForRoute(originPort.id, destinationPort.id);
    if (xenetaData) {
      sourceData['Xeneta XSI'] = {
        rate: xenetaData.current_index,
        weight: SOURCE_WEIGHTS['Xeneta XSI'],
        normalizationFactor: NORMALIZATION_FACTORS['Xeneta XSI']
      };
    }
    
    // Получение данных New ConTex
    const contexData = await contexScraper.getContexDataForCalculation();
    if (contexData) {
      sourceData['New ConTex'] = {
        rate: contexData.current_index,
        weight: SOURCE_WEIGHTS['New ConTex'],
        normalizationFactor: NORMALIZATION_FACTORS['New ConTex']
      };
    }
    
    // Получение данных ISTFIX
    const istfixData = await istfixScraper.getISTFIXDataForRoute(originPort.id, destinationPort.id);
    if (istfixData) {
      sourceData['ISTFIX'] = {
        rate: istfixData.current_index,
        weight: SOURCE_WEIGHTS['ISTFIX'],
        normalizationFactor: NORMALIZATION_FACTORS['ISTFIX']
      };
    }
    
    // Получение данных CTS
    const ctsData = await ctsScraper.getCTSDataForRoute(originPort.id, destinationPort.id);
    if (ctsData) {
      sourceData['CTS'] = {
        rate: ctsData.current_index,
        weight: SOURCE_WEIGHTS['CTS'],
        normalizationFactor: NORMALIZATION_FACTORS['CTS']
      };
    }
    
    return sourceData;
  } catch (error) {
    console.error('Error collecting data from sources:', error);
    return sourceData; // Возвращаем то, что успели собрать
  }
}

// Функция для расчета средневзвешенной ставки
function calculateWeightedRate(sourceData) {
  let totalWeight = 0;
  let weightedSum = 0;
  let minRate = Infinity;
  let maxRate = 0;
  
  // Расчет средневзвешенной ставки
  for (const source in sourceData) {
    const { rate, weight, normalizationFactor } = sourceData[source];
    const normalizedRate = rate * normalizationFactor;
    
    weightedSum += normalizedRate * weight;
    totalWeight += weight;
    
    // Обновление минимальной и максимальной ставки
    minRate = Math.min(minRate, normalizedRate);
    maxRate = Math.max(maxRate, normalizedRate);
  }
  
  // Расчет средневзвешенной ставки
  const weightedRate = totalWeight > 0 ? weightedSum / totalWeight : 0;
  
  // Расчет показателя надежности (от 0 до 1)
  // Чем больше источников и меньше разброс, тем выше надежность
  const sourceCount = Object.keys(sourceData).length;
  const rateRange = maxRate - minRate;
  const rangeRatio = weightedRate > 0 ? rateRange / weightedRate : 1;
  
  // Формула для расчета надежности:
  // - Учитывает количество источников (больше источников = выше надежность)
  // - Учитывает разброс ставок (меньше разброс = выше надежность)
  const reliability = Math.min(
    1,
    (sourceCount / 10) * (1 - Math.min(1, rangeRatio / 2))
  );
  
  return {
    weightedRate,
    reliability,
    minRate: minRate === Infinity ? weightedRate * 0.8 : minRate,
    maxRate: maxRate === 0 ? weightedRate * 1.2 : maxRate
  };
}

// Функция для получения коэффициента сезонности
async function getSeasonalityFactor(originRegion, destinationRegion) {
  try {
    // Получение текущего месяца
    const currentMonth = new Date().getMonth() + 1; // Месяцы в JavaScript начинаются с 0
    
    // Попытка получить специфический коэффициент для пары регионов
    const query = `
      SELECT factor FROM seasonality_factors 
      WHERE origin_region = $1 AND destination_region = $2 AND month = $3
    `;
    
    const result = await pool.query(query, [originRegion, destinationRegion, currentMonth]);
    
    // Если найден специфический коэффициент, используем его
    if (result.rows.length > 0) {
      return result.rows[0].factor;
    }
    
    // Иначе используем базовый коэффициент для текущего месяца
    return BASE_SEASONALITY_FACTORS[currentMonth];
  } catch (error) {
    console.error('Error getting seasonality factor:', error);
    // В случае ошибки возвращаем нейтральный коэффициент
    return 1.0;
  }
}

// Функция для расчета топливной надбавки
async function calculateFuelSurcharge(originPort, destinationPort, containerType) {
  try {
    // Получение текущей цены на топливо
    const fuelPriceQuery = `
      SELECT price FROM fuel_prices 
      ORDER BY date DESC 
      LIMIT 1
    `;
    
    const fuelPriceResult = await pool.query(fuelPriceQuery);
    const currentFuelPrice = fuelPriceResult.rows.length > 0 ? fuelPriceResult.rows[0].price : 500; // Значение по умолчанию
    
    // Получение базовой цены на топливо
    const baseFuelPrice = 400; // Базовая цена на топливо в USD
    
    // Получение расстояния между портами
    const distanceQuery = `
      SELECT distance FROM port_distances 
      WHERE (origin_port_id = $1 AND destination_port_id = $2) 
      OR (origin_port_id = $2 AND destination_port_id = $1)
    `;
    
    const distanceResult = await pool.query(distanceQuery, [originPort.id, destinationPort.id]);
    
    // Если расстояние не найдено, рассчитываем приблизительно по координатам
    let distance;
    if (distanceResult.rows.length > 0) {
      distance = distanceResult.rows[0].distance;
    } else {
      distance = calculateDistance(
        originPort.latitude, originPort.longitude,
        destinationPort.latitude, destinationPort.longitude
      );
    }
    
    // Коэффициент для расчета надбавки в зависимости от типа контейнера
    const containerFactor = containerType === '40HC' ? 1.2 : 
                           containerType === '40DC' ? 1.0 : 
                           containerType === '20DC' ? 0.6 : 1.0;
    
    // Расчет топливной надбавки
    // Формула: (текущая цена - базовая цена) * коэффициент * (расстояние / 1000)
    const fuelDifference = Math.max(0, currentFuelPrice - baseFuelPrice);
    const surcharge = fuelDifference * containerFactor * (distance / 1000) * 0.15;
    
    return Math.round(surcharge);
  } catch (error) {
    console.error('Error calculating fuel surcharge:', error);
    // В случае ошибки возвращаем приблизительную надбавку
    return containerType === '40HC' ? 300 : 
           containerType === '40DC' ? 250 : 
           containerType === '20DC' ? 150 : 250;
  }
}

// Функция для расчета расстояния между портами по координатам
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Радиус Земли в км
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  const distance = R * c;
  
  // Учитываем, что морской путь обычно длиннее прямой линии
  return distance * 1.4;
}

// Вспомогательная функция для перевода градусов в радианы
function deg2rad(deg) {
  return deg * (Math.PI/180);
}

// Функция для расчета итоговой ставки с учетом типа контейнера и веса
function calculateFinalRate(baseRate, containerType, weight, fuelSurcharge) {
  // Коэффициенты для разных типов контейнеров
  const containerFactor = containerType === '40HC' ? 1.2 : 
                         containerType === '40DC' ? 1.0 : 
                         containerType === '20DC' ? 0.6 : 1.0;
  
  // Базовая ставка с учетом типа контейнера
  let rate = baseRate * containerFactor;
  
  // Учет веса (если превышает стандартный)
  const standardWeight = containerType === '40HC' ? 30000 : 
                        containerType === '40DC' ? 30000 : 
                        containerType === '20DC' ? 24000 : 30000;
  
  if (weight > standardWeight) {
    const overweight = weight - standardWeight;
    const overweightFactor = 1 + (overweight / standardWeight) * 0.5;
    rate *= overweightFactor;
  }
  
  // Добавление топливной надбавки
  rate += fuelSurcharge;
  
  // Округление до целого числа
  return Math.round(rate);
}

// Функция для получения данных о порте по ID
async function getPortById(portId) {
  try {
    const query = 'SELECT * FROM ports WHERE id = $1';
    const result = await pool.query(query, [portId]);
    
    if (result.rows.length === 0) {
      throw new Error(`Port with ID ${portId} not found`);
    }
    
    return result.rows[0];
  } catch (error) {
    console.error('Error getting port data:', error);
    throw error;
  }
}

// Функция для сохранения результата расчета в историю
async function saveCalculationHistory(originPort, destinationPort, containerType, weight, rate, reliability) {
  try {
    const query = `
      INSERT INTO calculation_history 
      (origin_port_id, destination_port_id, container_type, weight, rate, reliability, calculation_date) 
      VALUES ($1, $2, $3, $4, $5, $6, NOW())
    `;
    
    await pool.query(query, [
      originPort,
      destinationPort,
      containerType,
      weight,
      rate,
      reliability
    ]);
    
    console.log('Calculation history saved');
  } catch (error) {
    console.error('Error saving calculation history:', error);
    // Ошибка сохранения истории не должна прерывать основной процесс
  }
}

// Функция для получения истории расчетов
async function getCalculationHistory(limit = 100) {
  try {
    const query = `
      SELECT 
        ch.id,
        op.name as origin_port,
        dp.name as destination_port,
        ch.container_type,
        ch.weight,
        ch.rate,
        ch.reliability,
        ch.calculation_date
      FROM calculation_history ch
      JOIN ports op ON ch.origin_port_id = op.id
      JOIN ports dp ON ch.destination_port_id = dp.id
      ORDER BY ch.calculation_date DESC
      LIMIT $1
    `;
    
    const result = await pool.query(query, [limit]);
    
    return result.rows;
  } catch (error) {
    console.error('Error getting calculation history:', error);
    throw error;
  }
}

// Экспорт функций
export default {
  calculateFreightRate,
  getCalculationHistory
};
