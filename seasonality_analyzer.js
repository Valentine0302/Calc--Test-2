// Модуль анализа сезонности для улучшения точности расчетов фрахтовых ставок
// Анализирует исторические данные и рассчитывает коэффициенты сезонности для различных маршрутов

import { Pool } from 'pg';
import dotenv from 'dotenv';

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

// Функция для инициализации таблицы коэффициентов сезонности
async function initializeSeasonalityTable() {
  const client = await pool.connect();
  
  try {
    // Начало транзакции
    await client.query('BEGIN');
    
    // Создание таблицы, если она не существует
    await client.query(`
      CREATE TABLE IF NOT EXISTS seasonality_factors (
        id SERIAL PRIMARY KEY,
        origin_region VARCHAR(255) NOT NULL,
        destination_region VARCHAR(255) NOT NULL,
        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        factor NUMERIC NOT NULL,
        confidence NUMERIC NOT NULL,
        last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(origin_region, destination_region, month)
      )
    `);
    
    // Проверка, есть ли уже данные в таблице
    const checkResult = await client.query('SELECT COUNT(*) FROM seasonality_factors');
    
    // Если таблица пуста, заполняем базовыми коэффициентами
    if (parseInt(checkResult.rows[0].count) === 0) {
      console.log('Initializing seasonality factors table with base values');
      
      // Получение списка всех регионов
      const regionsResult = await client.query('SELECT DISTINCT region FROM ports WHERE region IS NOT NULL');
      const regions = regionsResult.rows.map(row => row.region);
      
      // Для каждой пары регионов и каждого месяца добавляем базовый коэффициент
      for (const originRegion of regions) {
        for (const destinationRegion of regions) {
          // Пропускаем одинаковые регионы
          if (originRegion === destinationRegion) continue;
          
          for (let month = 1; month <= 12; month++) {
            await client.query(
              `INSERT INTO seasonality_factors 
               (origin_region, destination_region, month, factor, confidence) 
               VALUES ($1, $2, $3, $4, $5)`,
              [
                originRegion,
                destinationRegion,
                month,
                BASE_SEASONALITY_FACTORS[month],
                0.5 // Начальный уровень достоверности
              ]
            );
          }
        }
      }
    }
    
    // Завершение транзакции
    await client.query('COMMIT');
    
    console.log('Seasonality factors table initialized');
  } catch (error) {
    // Откат транзакции в случае ошибки
    await client.query('ROLLBACK');
    console.error('Error initializing seasonality factors table:', error);
    throw error;
  } finally {
    // Освобождение клиента
    client.release();
  }
}

// Функция для создания таблицы исторических ставок
async function initializeHistoricalRatesTable() {
  const client = await pool.connect();
  
  try {
    // Начало транзакции
    await client.query('BEGIN');
    
    // Создание таблицы, если она не существует
    await client.query(`
      CREATE TABLE IF NOT EXISTS historical_rates (
        id SERIAL PRIMARY KEY,
        origin_region VARCHAR(255) NOT NULL,
        destination_region VARCHAR(255) NOT NULL,
        container_type VARCHAR(10) NOT NULL,
        rate NUMERIC NOT NULL,
        rate_date DATE NOT NULL,
        source VARCHAR(255),
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(origin_region, destination_region, container_type, rate_date, source)
      )
    `);
    
    // Завершение транзакции
    await client.query('COMMIT');
    
    console.log('Historical rates table initialized');
  } catch (error) {
    // Откат транзакции в случае ошибки
    await client.query('ROLLBACK');
    console.error('Error initializing historical rates table:', error);
    throw error;
  } finally {
    // Освобождение клиента
    client.release();
  }
}

// Функция для импорта исторических данных из таблицы calculation_history
async function importHistoricalDataFromCalculationHistory() {
  const client = await pool.connect();
  
  try {
    console.log('Importing historical data from calculation_history');
    
    // Начало транзакции
    await client.query('BEGIN');
    
    // Проверка существования таблицы calculation_history
    const tableCheckResult = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'calculation_history'
      )
    `);
    
    if (!tableCheckResult.rows[0].exists) {
      console.log('calculation_history table does not exist, skipping import');
      await client.query('COMMIT');
      return;
    }
    
    // Получение данных из calculation_history и преобразование их в исторические ставки
    const historyResult = await client.query(`
      SELECT 
        op.region as origin_region,
        dp.region as destination_region,
        ch.container_type,
        ch.rate,
        ch.calculation_date::date as rate_date,
        'calculation_history' as source
      FROM calculation_history ch
      JOIN ports op ON ch.origin_port_id = op.id
      JOIN ports dp ON ch.destination_port_id = dp.id
      WHERE op.region IS NOT NULL AND dp.region IS NOT NULL
    `);
    
    // Вставка данных в таблицу historical_rates
    for (const row of historyResult.rows) {
      await client.query(
        `INSERT INTO historical_rates 
         (origin_region, destination_region, container_type, rate, rate_date, source) 
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (origin_region, destination_region, container_type, rate_date, source) 
         DO NOTHING`,
        [
          row.origin_region,
          row.destination_region,
          row.container_type,
          row.rate,
          row.rate_date,
          row.source
        ]
      );
    }
    
    // Завершение транзакции
    await client.query('COMMIT');
    
    console.log(`Imported ${historyResult.rows.length} records from calculation_history`);
  } catch (error) {
    // Откат транзакции в случае ошибки
    await client.query('ROLLBACK');
    console.error('Error importing historical data:', error);
    throw error;
  } finally {
    // Освобождение клиента
    client.release();
  }
}

// Функция для импорта исторических данных из таблиц индексов
async function importHistoricalDataFromIndices() {
  const client = await pool.connect();
  
  try {
    console.log('Importing historical data from freight indices');
    
    // Начало транзакции
    await client.query('BEGIN');
    
    // Список таблиц индексов для импорта
    const indexTables = [
      'freight_indices_scfi',
      'freight_indices_fbx',
      'freight_indices_wci',
      'freight_indices_bdi',
      'freight_indices_ccfi',
      'freight_indices_harpex',
      'freight_indices_xsi',
      'freight_indices_contex',
      'freight_indices_istfix',
      'freight_indices_cts'
    ];
    
    // Для каждой таблицы индексов
    for (const table of indexTables) {
      // Проверка существования таблицы
      const tableCheckResult = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_name = $1
        )
      `, [table]);
      
      if (!tableCheckResult.rows[0].exists) {
        console.log(`${table} table does not exist, skipping import`);
        continue;
      }
      
      // Получение данных из таблицы индексов
      const indexResult = await client.query(`
        SELECT 
          route,
          current_index,
          index_date
        FROM ${table}
      `);
      
      // Определение регионов на основе маршрута
      for (const row of indexResult.rows) {
        // Извлечение регионов из маршрута
        const regions = extractRegionsFromRoute(row.route);
        
        if (regions) {
          // Вставка данных в таблицу historical_rates
          await client.query(
            `INSERT INTO historical_rates 
             (origin_region, destination_region, container_type, rate, rate_date, source) 
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (origin_region, destination_region, container_type, rate_date, source) 
             DO NOTHING`,
            [
              regions.origin,
              regions.destination,
              '40DC', // Стандартный тип контейнера для индексов
              row.current_index,
              row.index_date,
              table
            ]
          );
        }
      }
      
      console.log(`Imported data from ${table}`);
    }
    
    // Завершение транзакции
    await client.query('COMMIT');
    
    console.log('Historical data import from indices completed');
  } catch (error) {
    // Откат транзакции в случае ошибки
    await client.query('ROLLBACK');
    console.error('Error importing historical data from indices:', error);
    throw error;
  } finally {
    // Освобождение клиента
    client.release();
  }
}

// Вспомогательная функция для извлечения регионов из маршрута
function extractRegionsFromRoute(route) {
  // Шаблоны для извлечения регионов из различных форматов маршрутов
  const patterns = [
    // Формат "Asia to Europe"
    { regex: /(\w+)\s+to\s+(\w+)/i, originIndex: 1, destinationIndex: 2 },
    // Формат "Asia-Europe"
    { regex: /(\w+)-(\w+)/i, originIndex: 1, destinationIndex: 2 },
    // Формат "Shanghai-Rotterdam"
    { regex: /Shanghai|China|East Asia/i, origin: 'Asia' },
    { regex: /Rotterdam|Europe|North Europe/i, destination: 'Europe' },
    { regex: /North America|USA|Los Angeles/i, destination: 'North America' },
    { regex: /Mediterranean|South Europe/i, destination: 'Mediterranean' }
  ];
  
  for (const pattern of patterns) {
    if (pattern.regex.test(route)) {
      if (pattern.originIndex && pattern.destinationIndex) {
        const match = route.match(pattern.regex);
        if (match) {
          return {
            origin: match[pattern.originIndex],
            destination: match[pattern.destinationIndex]
          };
        }
      } else {
        // Для шаблонов с фиксированными регионами
        return {
          origin: pattern.origin || 'Unknown',
          destination: pattern.destination || 'Unknown'
        };
      }
    }
  }
  
  // Если не удалось извлечь регионы, возвращаем null
  return null;
}

// Функция для генерации синтетических исторических данных
async function generateSyntheticHistoricalData(years = 5) {
  const client = await pool.connect();
  
  try {
    console.log(`Generating synthetic historical data for ${years} years`);
    
    // Начало транзакции
    await client.query('BEGIN');
    
    // Получение списка всех регионов
    const regionsResult = await client.query('SELECT DISTINCT region FROM ports WHERE region IS NOT NULL');
    const regions = regionsResult.rows.map(row => row.region);
    
    // Типы контейнеров
    const containerTypes = ['20DC', '40DC', '40HC'];
    
    // Базовые ставки для разных пар регионов
    const baseRates = {
      'Asia-Europe': 2000,
      'Europe-Asia': 1000,
      'Asia-North America': 2500,
      'North America-Asia': 1200,
      'Europe-North America': 1800,
      'North America-Europe': 1500,
      'Asia-Mediterranean': 1900,
      'Mediterranean-Asia': 950,
      'Europe-Mediterranean': 1200,
      'Mediterranean-Europe': 1100
    };
    
    // Текущая дата
    const currentDate = new Date();
    
    // Генерация данных за указанное количество лет
    for (let yearOffset = 0; yearOffset < years; yearOffset++) {
      for (let month = 0; month < 12; month++) {
        // Создание даты для текущего месяца и года
        const date = new Date(
          currentDate.getFullYear() - yearOffset,
          month,
          15
        );
        
        // Форматирование даты в формат YYYY-MM-DD
        const formattedDate = date.toISOString().split('T')[0];
        
        // Сезонный коэффициент для текущего месяца
        const seasonalFactor = BASE_SEASONALITY_FACTORS[month + 1];
        
        // Годовой тренд (небольшое увеличение ставок каждый год)
        const yearTrend = 1 + (yearOffset * 0.05);
        
        // Для каждой пары регионов
        for (const originRegion of regions) {
          for (const destinationRegion of regions) {
            // Пропускаем одинаковые регионы
            if (originRegion === destinationRegion) continue;
            
            // Определение ключа для базовой ставки
            const rateKey = `${originRegion}-${destinationRegion}`;
            const alternativeKey = `${destinationRegion}-${originRegion}`;
            
            // Базовая ставка для пары регионов
            let baseRate = baseRates[rateKey] || baseRates[alternativeKey] || 1500;
            
            // Для каждого типа контейнера
            for (const containerType of containerTypes) {
              // Коэффициент для типа контейнера
              const containerFactor = containerType === '40HC' ? 1.2 : 
                                     containerType === '40DC' ? 1.0 : 
                                     containerType === '20DC' ? 0.6 : 1.0;
              
              // Случайное отклонение (±10%)
              const randomFactor = 0.9 + (Math.random() * 0.2);
              
              // Расчет итоговой ставки
              const rate = Math.round(baseRate * containerFactor * seasonalFactor * randomFactor / yearTrend);
              
              // Вставка данных в таблицу historical_rates
              await client.query(
                `INSERT INTO historical_rates 
                 (origin_region, destination_region, container_type, rate, rate_date, source) 
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (origin_region, destination_region, container_type, rate_date, source) 
                 DO NOTHING`,
                [
                  originRegion,
                  destinationRegion,
                  containerType,
                  rate,
                  formattedDate,
                  'synthetic'
                ]
              );
            }
          }
        }
      }
    }
    
    // Завершение транзакции
    await client.query('COMMIT');
    
    console.log('Synthetic historical data generation completed');
  } catch (error) {
    // Откат транзакции в случае ошибки
    await client.query('ROLLBACK');
    console.error('Error generating synthetic historical data:', error);
    throw error;
  } finally {
    // Освобождение клиента
    client.release();
  }
}

// Функция для анализа исторических данных и расчета коэффициентов сезонности
async function analyzeSeasonalityFactors() {
  const client = await pool.connect();
  
  try {
    console.log('Analyzing seasonality factors');
    
    // Начало транзакции
    await client.query('BEGIN');
    
    // Получение списка всех пар регионов из исторических данных
    const regionPairsResult = await client.query(`
      SELECT DISTINCT origin_region, destination_region 
      FROM historical_rates
    `);
    
    // Для каждой пары регионов
    for (const { origin_region, destination_region } of regionPairsResult.rows) {
      // Получение среднегодовой ставки для пары регионов
      const avgRateResult = await client.query(`
        SELECT AVG(rate) as avg_rate 
        FROM historical_rates 
        WHERE origin_region = $1 AND destination_region = $2
      `, [origin_region, destination_region]);
      
      const avgRate = parseFloat(avgRateResult.rows[0].avg_rate);
      
      // Для каждого месяца
      for (let month = 1; month <= 12; month++) {
        // Получение средней ставки для месяца
        const monthlyRateResult = await client.query(`
          SELECT AVG(rate) as avg_rate, COUNT(*) as count
          FROM historical_rates 
          WHERE origin_region = $1 
          AND destination_region = $2 
          AND EXTRACT(MONTH FROM rate_date) = $3
        `, [origin_region, destination_region, month]);
        
        const monthlyAvgRate = parseFloat(monthlyRateResult.rows[0].avg_rate);
        const dataCount = parseInt(monthlyRateResult.rows[0].count);
        
        // Расчет коэффициента сезонности
        let seasonalityFactor;
        let confidence;
        
        if (isNaN(monthlyAvgRate) || dataCount < 3) {
          // Если недостаточно данных, используем базовый коэффициент
          seasonalityFactor = BASE_SEASONALITY_FACTORS[month];
          confidence = 0.5;
        } else {
          // Расчет коэффициента как отношение средней ставки за месяц к среднегодовой ставке
          seasonalityFactor = monthlyAvgRate / avgRate;
          
          // Ограничение коэффициента разумными пределами
          seasonalityFactor = Math.max(0.7, Math.min(1.3, seasonalityFactor));
          
          // Расчет уровня достоверности на основе количества данных
          confidence = Math.min(1.0, dataCount / 20);
        }
        
        // Обновление коэффициента сезонности в таблице
        await client.query(`
          UPDATE seasonality_factors 
          SET factor = $1, confidence = $2, last_updated = NOW() 
          WHERE origin_region = $3 AND destination_region = $4 AND month = $5
        `, [seasonalityFactor, confidence, origin_region, destination_region, month]);
      }
    }
    
    // Завершение транзакции
    await client.query('COMMIT');
    
    console.log('Seasonality factors analysis completed');
  } catch (error) {
    // Откат транзакции в случае ошибки
    await client.query('ROLLBACK');
    console.error('Error analyzing seasonality factors:', error);
    throw error;
  } finally {
    // Освобождение клиента
    client.release();
  }
}

// Функция для получения коэффициента сезонности для конкретной пары регионов и месяца
async function getSeasonalityFactor(originRegion, destinationRegion, month = null) {
  try {
    // Если месяц не указан, используем текущий
    const targetMonth = month || (new Date().getMonth() + 1);
    
    // Запрос коэффициента из базы данных
    const query = `
      SELECT factor, confidence FROM seasonality_factors 
      WHERE origin_region = $1 AND destination_region = $2 AND month = $3
    `;
    
    const result = await pool.query(query, [originRegion, destinationRegion, targetMonth]);
    
    // Если коэффициент найден, возвращаем его
    if (result.rows.length > 0) {
      return {
        factor: parseFloat(result.rows[0].factor),
        confidence: parseFloat(result.rows[0].confidence)
      };
    }
    
    // Если коэффициент не найден, используем базовый
    return {
      factor: BASE_SEASONALITY_FACTORS[targetMonth],
      confidence: 0.5
    };
  } catch (error) {
    console.error('Error getting seasonality factor:', error);
    // В случае ошибки возвращаем базовый коэффициент
    return {
      factor: BASE_SEASONALITY_FACTORS[month || (new Date().getMonth() + 1)],
      confidence: 0.5
    };
  }
}

// Функция для получения всех коэффициентов сезонности
async function getAllSeasonalityFactors() {
  try {
    const query = `
      SELECT 
        origin_region, 
        destination_region, 
        month, 
        factor, 
        confidence, 
        last_updated 
      FROM seasonality_factors 
      ORDER BY origin_region, destination_region, month
    `;
    
    const result = await pool.query(query);
    
    return result.rows;
  } catch (error) {
    console.error('Error getting all seasonality factors:', error);
    throw error;
  }
}

// Функция для получения исторических данных для визуализации
async function getHistoricalRatesForVisualization(originRegion, destinationRegion, containerType = '40DC', months = 24) {
  try {
    const query = `
      SELECT 
        rate_date, 
        AVG(rate) as avg_rate,
        MIN(rate) as min_rate,
        MAX(rate) as max_rate,
        COUNT(*) as data_count
      FROM historical_rates 
      WHERE origin_region = $1 
      AND destination_region = $2 
      AND container_type = $3
      AND rate_date >= NOW() - INTERVAL '${months} months'
      GROUP BY rate_date
      ORDER BY rate_date
    `;
    
    const result = await pool.query(query, [originRegion, destinationRegion, containerType]);
    
    return result.rows;
  } catch (error) {
    console.error('Error getting historical rates for visualization:', error);
    throw error;
  }
}

// Функция для инициализации и обновления всех данных сезонности
async function initializeAndUpdateSeasonalityData(generateSynthetic = true) {
  try {
    console.log('Initializing and updating seasonality data');
    
    // Инициализация таблиц
    await initializeSeasonalityTable();
    await initializeHistoricalRatesTable();
    
    // Импорт исторических данных
    await importHistoricalDataFromCalculationHistory();
    await importHistoricalDataFromIndices();
    
    // Генерация синтетических данных, если требуется
    if (generateSynthetic) {
      await generateSyntheticHistoricalData(5);
    }
    
    // Анализ и обновление коэффициентов сезонности
    await analyzeSeasonalityFactors();
    
    console.log('Seasonality data initialization and update completed');
  } catch (error) {
    console.error('Error initializing and updating seasonality data:', error);
    throw error;
  }
}

// Экспорт функций
export default {
  initializeAndUpdateSeasonalityData,
  getSeasonalityFactor,
  getAllSeasonalityFactors,
  getHistoricalRatesForVisualization,
  analyzeSeasonalityFactors
};
