// Модуль для анализа сезонности ставок фрахта
// Создает и анализирует базу исторических данных для выявления сезонных паттернов

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

// Функция для инициализации таблиц для анализа сезонности
async function initializeSeasonalityTables() {
  const client = await pool.connect();
  
  try {
    // Начало транзакции
    await client.query('BEGIN');
    
    // Сначала удаляем проблемные таблицы, если они существуют
    await client.query('DROP TABLE IF EXISTS historical_rates CASCADE');
    
    // Создание таблицы для хранения исторических данных о ставках
    // ВАЖНО: Используем origin_port и destination_port вместо origin_port_id и destination_port_id
    await client.query(`
      CREATE TABLE IF NOT EXISTS historical_rates (
        id SERIAL PRIMARY KEY,
        origin_port VARCHAR(10) NOT NULL,
        destination_port VARCHAR(10) NOT NULL,
        origin_region VARCHAR(50),
        destination_region VARCHAR(50),
        container_type VARCHAR(10) NOT NULL,
        rate NUMERIC NOT NULL,
        date DATE NOT NULL,
        source VARCHAR(50),
        UNIQUE(origin_port, destination_port, container_type, date, source)
      )
    `);
    
    // Создание таблицы для хранения коэффициентов сезонности
    await client.query(`
      CREATE TABLE IF NOT EXISTS seasonality_factors (
        id SERIAL PRIMARY KEY,
        origin_region VARCHAR(50) NOT NULL,
        destination_region VARCHAR(50) NOT NULL,
        month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
        seasonality_factor NUMERIC NOT NULL,
        confidence NUMERIC NOT NULL,
        last_updated TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(origin_region, destination_region, month)
      )
    `);
    
    // Создание таблицы для хранения цен на топливо
    await client.query(`
      CREATE TABLE IF NOT EXISTS fuel_prices (
        id SERIAL PRIMARY KEY,
        price NUMERIC NOT NULL,
        date DATE NOT NULL,
        source VARCHAR(50),
        fuel_type VARCHAR(50) DEFAULT 'VLSFO',
        UNIQUE(date, source)
      )
    `);
    
    // Создание таблицы для хранения расстояний между портами
    await client.query(`
      CREATE TABLE IF NOT EXISTS port_distances (
        id SERIAL PRIMARY KEY,
        origin_port VARCHAR(10) NOT NULL,
        destination_port VARCHAR(10) NOT NULL,
        distance NUMERIC NOT NULL,
        UNIQUE(origin_port, destination_port)
      )
    `);
    
    // Завершение транзакции
    await client.query('COMMIT');
    
    console.log('Seasonality tables initialized successfully');
  } catch (error) {
    // Откат транзакции в случае ошибки
    await client.query('ROLLBACK');
    console.error('Error initializing seasonality tables:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию
    console.log('Continuing initialization despite error in seasonality tables');
  } finally {
    // Освобождение клиента
    client.release();
  }
}

// Функция для импорта исторических данных о ставках
async function importHistoricalRates() {
  try {
    console.log('Importing historical rates data...');
    
    // Импорт данных из таблицы calculation_history
    await importHistoricalDataFromCalculationHistory();
    
    // Дополнение данных синтетическими, если исторических данных недостаточно
    const countQuery = 'SELECT COUNT(*) FROM historical_rates';
    const countResult = await pool.query(countQuery);
    
    if (countResult.rows[0].count < 1000) {
      console.log('Not enough historical data, generating synthetic data...');
      await generateSyntheticHistoricalData();
    }
  } catch (error) {
    console.error('Error in importHistoricalRates:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию
    console.log('Continuing initialization despite error in historical rates import');
  }
}

// Улучшенная функция для импорта исторических данных из calculation_history
async function importHistoricalDataFromCalculationHistory() {
  try {
    console.log('Importing historical data from calculation_history');
    
    // Проверяем существование таблицы
    const tableCheckQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'calculation_history'
      )
    `;
    
    const tableExists = await pool.query(tableCheckQuery);
    if (!tableExists.rows[0].exists) {
      console.log('Table calculation_history does not exist, skipping import');
      return;
    }
    
    // Проверяем структуру таблицы
    const columnsQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'calculation_history'
    `;
    
    const columnsResult = await pool.query(columnsQuery);
    const columns = columnsResult.rows.map(row => row.column_name);
    
    // Если таблица пуста или не содержит нужных колонок, пропускаем импорт
    if (columns.length === 0) {
      console.log('Table calculation_history has no columns, skipping import');
      return;
    }
    
    // Формируем запрос в зависимости от доступных колонок
    let historyQuery;
    
    if (columns.includes('origin_port_id') && columns.includes('destination_port_id')) {
      historyQuery = `
        SELECT 
          origin_port_id as origin_port, 
          destination_port_id as destination_port, 
          container_type, 
          rate, 
          created_at,
          sources
        FROM calculation_history
        ORDER BY created_at
      `;
    } else if (columns.includes('origin_port') && columns.includes('destination_port')) {
      historyQuery = `
        SELECT 
          origin_port, 
          destination_port, 
          container_type, 
          rate, 
          created_at,
          sources
        FROM calculation_history
        ORDER BY created_at
      `;
    } else {
      console.log('Table calculation_history does not have required columns, skipping import');
      return;
    }
    
    const historyResult = await pool.query(historyQuery);
    
    if (historyResult.rows.length === 0) {
      console.log('No historical data found in calculation_history');
      return;
    }
    
    // Получение информации о регионах портов
    const portRegions = await getPortRegions();
    
    // Импорт данных из calculation_history в historical_rates
    const client = await pool.connect();
    
    try {
      // Начало транзакции
      await client.query('BEGIN');
      
      for (const row of historyResult.rows) {
        const originPort = row.origin_port;
        const destPort = row.destination_port;
        const originRegion = portRegions[originPort] || 'Unknown';
        const destinationRegion = portRegions[destPort] || 'Unknown';
        const date = new Date(row.created_at).toISOString().split('T')[0];
        const source = row.sources || 'calculation_history';
        
        // Вставка данных в таблицу historical_rates
        // ВАЖНО: Используем origin_port и destination_port
        await client.query(
          `INSERT INTO historical_rates 
           (origin_port, destination_port, origin_region, destination_region, container_type, rate, date, source) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (origin_port, destination_port, container_type, date, source) 
           DO UPDATE SET 
             rate = $6,
             origin_region = $3,
             destination_region = $4`,
          [
            originPort,
            destPort,
            originRegion,
            destinationRegion,
            row.container_type,
            row.rate,
            date,
            source
          ]
        );
      }
      
      // Завершение транзакции
      await client.query('COMMIT');
      
      console.log(`Imported ${historyResult.rows.length} historical rates from calculation_history`);
    } catch (error) {
      // Откат транзакции в случае ошибки
      await client.query('ROLLBACK');
      console.error('Error importing historical rates:', error);
      // Не пробрасываем ошибку дальше
    } finally {
      // Освобождение клиента
      client.release();
    }
  } catch (error) {
    console.error('Error importing historical data from calculation_history:', error);
    // Важно: не пробрасываем ошибку дальше, чтобы не прерывать инициализацию
    console.log('Continuing initialization despite error in historical data import');
  }
}

// Функция для генерации синтетических исторических данных
async function generateSyntheticHistoricalData() {
  try {
    console.log('Generating synthetic historical data...');
    
    // Получение списка всех портов
    const portsQuery = 'SELECT id, region FROM ports';
    const portsResult = await pool.query(portsQuery);
    
    if (portsResult.rows.length === 0) {
      console.log('No ports found in database');
      return;
    }
    
    // Создание массива популярных маршрутов
    const popularRoutes = [];
    
    // Добавление маршрутов Азия -> Европа
    const asiaPorts = portsResult.rows.filter(port => port.region === 'Asia');
    const europePorts = portsResult.rows.filter(port => port.region === 'Europe');
    
    for (let i = 0; i < Math.min(5, asiaPorts.length); i++) {
      for (let j = 0; j < Math.min(5, europePorts.length); j++) {
        popularRoutes.push({
          origin: asiaPorts[i].id,
          destination: europePorts[j].id,
          originRegion: 'Asia',
          destinationRegion: 'Europe'
        });
      }
    }
    
    // Добавление маршрутов Азия -> Северная Америка
    const northAmericaPorts = portsResult.rows.filter(port => port.region === 'North America');
    
    for (let i = 0; i < Math.min(5, asiaPorts.length); i++) {
      for (let j = 0; j < Math.min(5, northAmericaPorts.length); j++) {
        popularRoutes.push({
          origin: asiaPorts[i].id,
          destination: northAmericaPorts[j].id,
          originRegion: 'Asia',
          destinationRegion: 'North America'
        });
      }
    }
    
    // Добавление маршрутов Европа -> Северная Америка
    for (let i = 0; i < Math.min(5, europePorts.length); i++) {
      for (let j = 0; j < Math.min(5, northAmericaPorts.length); j++) {
        popularRoutes.push({
          origin: europePorts[i].id,
          destination: northAmericaPorts[j].id,
          originRegion: 'Europe',
          destinationRegion: 'North America'
        });
      }
    }
    
    // Типы контейнеров
    const containerTypes = ['20DV', '40DV', '40HC'];
    
    // Генерация данных за последние 3 года
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setFullYear(endDate.getFullYear() - 3);
    
    // Массив для хранения сгенерированных данных
    const syntheticData = [];
    
    // Генерация данных для каждого маршрута
    for (const route of popularRoutes) {
      for (const containerType of containerTypes) {
        // Генерация базовой ставки для маршрута
        const baseRate = 1000 + Math.random() * 2000;
        
        // Генерация данных для каждого месяца
        let currentDate = new Date(startDate);
        
        while (currentDate <= endDate) {
          // Расчет сезонного коэффициента
          const month = currentDate.getMonth() + 1;
          const seasonalFactor = getSeasonalFactorForMonth(month);
          
          // Расчет годового тренда (рост ставок со временем)
          const yearsSinceStart = (currentDate - startDate) / (365 * 24 * 60 * 60 * 1000);
          const trendFactor = 1 + yearsSinceStart * 0.1; // 10% рост в год
          
          // Добавление случайной вариации
          const randomFactor = 0.9 + Math.random() * 0.2; // ±10% случайная вариация
          
          // Расчет итоговой ставки
          const rate = Math.round(baseRate * seasonalFactor * trendFactor * randomFactor);
          
          // Форматирование даты
          const date = currentDate.toISOString().split('T')[0];
          
          // Добавление данных в массив
          syntheticData.push({
            origin_port: route.origin,
            destination_port: route.destination,
            origin_region: route.originRegion,
            destination_region: route.destinationRegion,
            container_type: containerType,
            rate,
            date,
            source: 'synthetic'
          });
          
          // Переход к следующему месяцу
          currentDate.setMonth(currentDate.getMonth() + 1);
        }
      }
    }
    
    // Сохранение сгенерированных данных в базу данных
    const client = await pool.connect();
    
    try {
      // Начало транзакции
      await client.query('BEGIN');
      
      for (const data of syntheticData) {
        // Вставка данных в таблицу historical_rates
        // ВАЖНО: Используем origin_port и destination_port
        await client.query(
          `INSERT INTO historical_rates 
           (origin_port, destination_port, origin_region, destination_region, container_type, rate, date, source) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (origin_port, destination_port, container_type, date, source) 
           DO NOTHING`,
          [
            data.origin_port,
            data.destination_port,
            data.origin_region,
            data.destination_region,
            data.container_type,
            data.rate,
            data.date,
            data.source
          ]
        );
      }
      
      // Завершение транзакции
      await client.query('COMMIT');
      
      console.log(`Generated and saved ${syntheticData.length} synthetic historical rates`);
    } catch (error) {
      // Откат транзакции в случае ошибки
      await client.query('ROLLBACK');
      console.error('Error saving synthetic historical rates:', error);
      // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию
      console.log('Continuing initialization despite error in synthetic data generation');
    } finally {
      // Освобождение клиента
      client.release();
    }
  } catch (error) {
    console.error('Error generating synthetic historical data:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию
    console.log('Continuing initialization despite error in synthetic data generation');
  }
}

// Функция для получения сезонного коэффициента для месяца
function getSeasonalFactorForMonth(month) {
  // Сезонные коэффициенты по месяцам (пик в летние месяцы)
  const seasonalFactors = {
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
  
  return seasonalFactors[month] || 1.0;
}

// Функция для получения регионов всех портов
async function getPortRegions() {
  try {
    const query = 'SELECT id, region FROM ports';
    const result = await pool.query(query);
    
    // Создание объекта с регионами портов
    const portRegions = {};
    
    for (const row of result.rows) {
      portRegions[row.id] = row.region;
    }
    
    return portRegions;
  } catch (error) {
    console.error('Error getting port regions:', error);
    return {};
  }
}

// Функция для анализа сезонности и расчета коэффициентов
async function analyzeSeasonality() {
  try {
    console.log('Analyzing seasonality patterns...');
    
    // Получение уникальных пар регионов
    const regionsQuery = `
      SELECT DISTINCT origin_region, destination_region 
      FROM historical_rates 
      WHERE origin_region IS NOT NULL AND destination_region IS NOT NULL
    `;
    
    const regionsResult = await pool.query(regionsQuery);
    
    if (regionsResult.rows.length === 0) {
      console.log('No region pairs found in historical data');
      return;
    }
    
    // Анализ сезонности для каждой пары регионов
    for (const regionPair of regionsResult.rows) {
      const originRegion = regionPair.origin_region;
      const destinationRegion = regionPair.destination_region;
      
      // Получение данных о ставках для пары регионов
      const ratesQuery = `
        SELECT 
          date, 
          AVG(rate) as avg_rate,
          COUNT(*) as data_points
        FROM historical_rates 
        WHERE origin_region = $1 AND destination_region = $2
        GROUP BY date
        ORDER BY date
      `;
      
      const ratesResult = await pool.query(ratesQuery, [
        originRegion,
        destinationRegion
      ]);
      
      if (ratesResult.rows.length < 12) {
        console.log(`Not enough data for ${originRegion} -> ${destinationRegion}, skipping`);
        continue;
      }
      
      // Расчет сезонных коэффициентов по месяцам
      const monthlyRates = {};
      const monthlyDataPoints = {};
      
      for (const row of ratesResult.rows) {
        const date = new Date(row.date);
        const month = date.getMonth() + 1; // 1-12
        
        if (!monthlyRates[month]) {
          monthlyRates[month] = [];
          monthlyDataPoints[month] = 0;
        }
        
        monthlyRates[month].push(parseFloat(row.avg_rate));
        monthlyDataPoints[month] += parseInt(row.data_points);
      }
      
      // Расчет среднегодовой ставки
      let totalRate = 0;
      let totalDataPoints = 0;
      
      for (const month in monthlyRates) {
        const avgMonthRate = monthlyRates[month].reduce((a, b) => a + b, 0) / monthlyRates[month].length;
        totalRate += avgMonthRate;
        totalDataPoints += monthlyDataPoints[month];
      }
      
      const avgYearRate = totalRate / Object.keys(monthlyRates).length;
      
      // Расчет сезонных коэффициентов
      const seasonalityFactors = {};
      const confidenceFactors = {};
      
      for (const month in monthlyRates) {
        const avgMonthRate = monthlyRates[month].reduce((a, b) => a + b, 0) / monthlyRates[month].length;
        seasonalityFactors[month] = avgMonthRate / avgYearRate;
        
        // Расчет уровня достоверности на основе количества данных
        const dataPoints = monthlyDataPoints[month];
        confidenceFactors[month] = Math.min(1.0, dataPoints / 100); // Максимум 1.0 при 100+ точках данных
      }
      
      // Сохранение коэффициентов в базу данных
      const client = await pool.connect();
      
      try {
        // Начало транзакции
        await client.query('BEGIN');
        
        for (const month in seasonalityFactors) {
          // Вставка или обновление коэффициента в таблице
          await client.query(
            `INSERT INTO seasonality_factors 
             (origin_region, destination_region, month, seasonality_factor, confidence, last_updated) 
             VALUES ($1, $2, $3, $4, $5, NOW())
             ON CONFLICT (origin_region, destination_region, month) 
             DO UPDATE SET 
               seasonality_factor = $4,
               confidence = $5,
               last_updated = NOW()`,
            [
              originRegion,
              destinationRegion,
              month,
              seasonalityFactors[month],
              confidenceFactors[month]
            ]
          );
        }
        
        // Завершение транзакции
        await client.query('COMMIT');
        
        console.log(`Calculated seasonality factors for ${originRegion} -> ${destinationRegion}`);
      } catch (error) {
        // Откат транзакции в случае ошибки
        await client.query('ROLLBACK');
        console.error(`Error saving seasonality factors for ${originRegion} -> ${destinationRegion}:`, error);
      } finally {
        // Освобождение клиента
        client.release();
      }
    }
    
    console.log('Seasonality analysis completed');
  } catch (error) {
    console.error('Error analyzing seasonality:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию
    console.log('Continuing initialization despite error in seasonality analysis');
  }
}

// Функция для получения сезонного коэффициента для конкретного маршрута и даты
async function getSeasonalityFactor(originPort, destinationPort, date) {
  try {
    // Получение регионов портов
    const portRegionsQuery = `
      SELECT 
        (SELECT region FROM ports WHERE id = $1) as origin_region,
        (SELECT region FROM ports WHERE id = $2) as destination_region
    `;
    
    const portRegionsResult = await pool.query(portRegionsQuery, [
      originPort,
      destinationPort
    ]);
    
    if (portRegionsResult.rows.length === 0 || 
        !portRegionsResult.rows[0].origin_region || 
        !portRegionsResult.rows[0].destination_region) {
      console.log(`Could not determine regions for ports ${originPort} -> ${destinationPort}`);
      return 1.0; // Значение по умолчанию
    }
    
    const originRegion = portRegionsResult.rows[0].origin_region;
    const destinationRegion = portRegionsResult.rows[0].destination_region;
    
    // Определение месяца
    const month = date ? new Date(date).getMonth() + 1 : new Date().getMonth() + 1;
    
    // Получение сезонного коэффициента из базы данных
    const factorQuery = `
      SELECT seasonality_factor, confidence 
      FROM seasonality_factors 
      WHERE origin_region = $1 AND destination_region = $2 AND month = $3
    `;
    
    const factorResult = await pool.query(factorQuery, [
      originRegion,
      destinationRegion,
      month
    ]);
    
    if (factorResult.rows.length === 0) {
      console.log(`No seasonality factor found for ${originRegion} -> ${destinationRegion}, month ${month}`);
      return 1.0; // Значение по умолчанию
    }
    
    const factor = factorResult.rows[0].seasonality_factor;
    const confidence = factorResult.rows[0].confidence;
    
    // Применение коэффициента с учетом уровня достоверности
    // Если достоверность низкая, коэффициент ближе к 1.0
    const adjustedFactor = 1.0 + (factor - 1.0) * confidence;
    
    return adjustedFactor;
  } catch (error) {
    console.error('Error getting seasonality factor:', error);
    return 1.0; // Значение по умолчанию в случае ошибки
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
        seasonality_factor,
        confidence,
        last_updated
      FROM seasonality_factors
      ORDER BY origin_region, destination_region, month
    `;
    
    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    console.error('Error getting all seasonality factors:', error);
    return [];
  }
}

// Функция для получения исторических данных о ставках для визуализации
async function getHistoricalRatesForVisualization(originRegion, destinationRegion, containerType, months) {
  try {
    // Определение периода
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setMonth(startDate.getMonth() - (months || 12));
    
    // Получение данных о ставках
    const query = `
      SELECT 
        date, 
        AVG(rate) as avg_rate,
        COUNT(*) as data_points
      FROM historical_rates 
      WHERE origin_region = $1 
        AND destination_region = $2 
        AND container_type = $3
        AND date >= $4
      GROUP BY date
      ORDER BY date
    `;
    
    const result = await pool.query(query, [
      originRegion,
      destinationRegion,
      containerType,
      startDate.toISOString().split('T')[0]
    ]);
    
    return result.rows;
  } catch (error) {
    console.error('Error getting historical rates for visualization:', error);
    return [];
  }
}

// Функция для инициализации и обновления всех данных для анализа сезонности
async function initializeAndUpdateSeasonalityData() {
  try {
    console.log('Initializing and updating seasonality data...');
    
    // Инициализация таблиц
    await initializeSeasonalityTables();
    
    // Импорт исторических данных о ставках
    await importHistoricalRates();
    
    // Анализ сезонности
    await analyzeSeasonality();
    
    console.log('Seasonality data initialization and update completed');
    return true;
  } catch (error) {
    console.error('Error initializing and updating seasonality data:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию системы
    console.log('Continuing system initialization despite seasonality data error');
    return false;
  }
}

// Функция для анализа сезонных факторов (для вызова из API)
async function analyzeSeasonalityFactors() {
  try {
    await analyzeSeasonality();
    return true;
  } catch (error) {
    console.error('Error in analyzeSeasonalityFactors:', error);
    return false;
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
