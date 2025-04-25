// Модуль для расчета топливных надбавок
// Анализирует цены на топливо и рассчитывает соответствующие надбавки к ставкам фрахта

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

// Функция для инициализации таблиц для расчета топливных надбавок
async function initializeFuelSurchargeTables() {
  const client = await pool.connect();
  
  try {
    // Начало транзакции
    await client.query('BEGIN');
    
    // Проверка существования таблицы fuel_prices
    const tableCheckQuery = `
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'fuel_prices'
      )
    `;
    
    const tableExists = await client.query(tableCheckQuery);
    
    if (!tableExists.rows[0].exists) {
      // Создание таблицы для хранения цен на топливо
      await client.query(`
        CREATE TABLE fuel_prices (
          id SERIAL PRIMARY KEY,
          price NUMERIC NOT NULL,
          date DATE NOT NULL,
          source VARCHAR(50),
          UNIQUE(date, source)
        )
      `);
    }
    
    // Создание таблицы для хранения коэффициентов топливных надбавок
    await client.query(`
      CREATE TABLE IF NOT EXISTS fuel_surcharge_factors (
        id SERIAL PRIMARY KEY,
        base_price NUMERIC NOT NULL,
        price_range NUMERIC NOT NULL,
        surcharge_factor NUMERIC NOT NULL,
        last_updated TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    
    // Завершение транзакции
    await client.query('COMMIT');
    
    console.log('Fuel surcharge tables initialized successfully');
  } catch (error) {
    // Откат транзакции в случае ошибки
    await client.query('ROLLBACK');
    console.error('Error initializing fuel surcharge tables:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию
  } finally {
    // Освобождение клиента
    client.release();
  }
}

// Функция для получения текущей цены на топливо
async function getCurrentFuelPrice() {
  try {
    // Получение последней цены на топливо из базы данных
    const query = `
      SELECT price 
      FROM fuel_prices 
      ORDER BY date DESC 
      LIMIT 1
    `;
    
    const result = await pool.query(query);
    
    if (result.rows.length === 0) {
      console.log('No fuel price data found, using default price');
      return 600; // Значение по умолчанию, если данных нет
    }
    
    return result.rows[0].price;
  } catch (error) {
    console.error('Error getting current fuel price:', error);
    return 600; // Значение по умолчанию в случае ошибки
  }
}

// Функция для расчета топливной надбавки
async function calculateFuelSurcharge(baseRate, distance) {
  try {
    // Получение текущей цены на топливо
    const currentFuelPrice = await getCurrentFuelPrice();
    
    // Получение коэффициентов топливных надбавок из базы данных
    const factorsQuery = `
      SELECT base_price, price_range, surcharge_factor 
      FROM fuel_surcharge_factors 
      ORDER BY base_price
    `;
    
    const factorsResult = await pool.query(factorsQuery);
    
    // Если коэффициенты не найдены, используем значения по умолчанию
    if (factorsResult.rows.length === 0) {
      // Расчет надбавки по формуле по умолчанию
      // Базовая цена на топливо - 500 долларов за тонну
      // Каждые 100 долларов сверх базовой цены добавляют 3% к ставке
      const baseFuelPrice = 500;
      const priceRange = 100;
      const surchargeFactorPerRange = 0.03;
      
      const priceAboveBase = Math.max(0, currentFuelPrice - baseFuelPrice);
      const surchargePercentage = (priceAboveBase / priceRange) * surchargeFactorPerRange;
      
      // Расчет надбавки с учетом расстояния
      // Чем больше расстояние, тем больше влияние топливной надбавки
      const distanceFactor = Math.min(1.0, distance / 10000);
      const adjustedSurchargePercentage = surchargePercentage * distanceFactor;
      
      const surchargeAmount = baseRate * adjustedSurchargePercentage;
      
      return {
        amount: Math.round(surchargeAmount),
        percentage: Math.round(adjustedSurchargePercentage * 100),
        fuelPrice: currentFuelPrice
      };
    }
    
    // Поиск подходящего диапазона цен
    let surchargePercentage = 0;
    
    for (const factor of factorsResult.rows) {
      const baseFuelPrice = factor.base_price;
      const priceRange = factor.price_range;
      const surchargeFactorPerRange = factor.surcharge_factor;
      
      const priceAboveBase = Math.max(0, currentFuelPrice - baseFuelPrice);
      surchargePercentage += (priceAboveBase / priceRange) * surchargeFactorPerRange;
    }
    
    // Расчет надбавки с учетом расстояния
    const distanceFactor = Math.min(1.0, distance / 10000);
    const adjustedSurchargePercentage = surchargePercentage * distanceFactor;
    
    const surchargeAmount = baseRate * adjustedSurchargePercentage;
    
    return {
      amount: Math.round(surchargeAmount),
      percentage: Math.round(adjustedSurchargePercentage * 100),
      fuelPrice: currentFuelPrice
    };
  } catch (error) {
    console.error('Error calculating fuel surcharge:', error);
    // В случае ошибки возвращаем нулевую надбавку
    return {
      amount: 0,
      percentage: 0,
      fuelPrice: 0
    };
  }
}

// Функция для получения исторических данных о ценах на топливо
async function getFuelPriceHistory(months) {
  try {
    // Получение данных за указанное количество месяцев
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setMonth(startDate.getMonth() - months);
    
    const query = `
      SELECT 
        date, 
        AVG(price) as avg_price,
        COUNT(*) as data_points
      FROM fuel_prices 
      WHERE date >= $1
      GROUP BY date
      ORDER BY date
    `;
    
    const result = await pool.query(query, [
      startDate.toISOString().split('T')[0]
    ]);
    
    return result.rows;
  } catch (error) {
    console.error('Error getting fuel price history:', error);
    return [];
  }
}

// Функция для получения данных о ценах на топливо из внешних источников
async function fetchFuelPrices() {
  try {
    console.log('Fetching fuel prices from external sources...');
    
    // В реальном приложении здесь был бы код для получения данных из API
    // Например, Bunker Index, Ship & Bunker, MABUX и т.д.
    
    // Для демонстрации используем моковые данные
    await fetchMockFuelPrices();
    
    console.log('Fuel prices fetched successfully');
  } catch (error) {
    console.error('Error fetching fuel prices:', error);
  }
}

// Функция для получения моковых данных о ценах на топливо
async function fetchMockFuelPrices() {
  try {
    console.log('Generating mock fuel price data...');
    
    // Генерация данных о ценах на топливо за последние 3 месяца
    const endDate = new Date();
    const startDate = new Date(endDate);
    startDate.setMonth(startDate.getMonth() - 3);
    
    // Базовая цена на топливо
    const basePrice = 600; // Примерная цена на VLSFO в долларах за тонну
    
    // Массив для хранения сгенерированных данных
    const fuelPricesData = [];
    
    // Генерация данных для каждого дня
    let currentDate = new Date(startDate);
    
    while (currentDate <= endDate) {
      // Добавление случайной вариации к базовой цене
      const randomFactor = 0.95 + Math.random() * 0.1; // ±5% случайная вариация
      
      // Расчет итоговой цены
      const price = Math.round(basePrice * randomFactor);
      
      // Форматирование даты
      const date = currentDate.toISOString().split('T')[0];
      
      // Добавление данных в массив
      fuelPricesData.push({
        price,
        date,
        source: 'mock'
      });
      
      // Переход к следующему дню
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    // Сохранение сгенерированных данных в базу данных
    await saveFuelPrices(fuelPricesData);
    
    console.log(`Generated and saved ${fuelPricesData.length} mock fuel prices`);
  } catch (error) {
    console.error('Error generating mock fuel prices:', error);
  }
}

// Функция для сохранения данных о ценах на топливо в базу данных
async function saveFuelPrices(fuelPrices) {
  try {
    const client = await pool.connect();
    
    try {
      // Начало транзакции
      await client.query('BEGIN');
      
      // Проверяем структуру таблицы fuel_prices
      const columnsQuery = `
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'fuel_prices'
      `;
      
      const columnsResult = await client.query(columnsQuery);
      const columns = columnsResult.rows.map(row => row.column_name);
      
      // Проверяем наличие колонки fuel_type
      const hasFuelTypeColumn = columns.includes('fuel_type');
      
      for (const data of fuelPrices) {
        // Адаптируем запрос в зависимости от структуры таблицы
        let query;
        let params;
        
        if (hasFuelTypeColumn) {
          query = `
            INSERT INTO fuel_prices 
            (price, date, source, fuel_type) 
            VALUES ($1, $2, $3, $4)
            ON CONFLICT (date, source) 
            DO NOTHING
          `;
          params = [
            data.price,
            data.date,
            data.source,
            data.fuel_type || 'VLSFO'  // Значение по умолчанию, если не указано
          ];
        } else {
          query = `
            INSERT INTO fuel_prices 
            (price, date, source) 
            VALUES ($1, $2, $3)
            ON CONFLICT (date, source) 
            DO NOTHING
          `;
          params = [
            data.price,
            data.date,
            data.source
          ];
        }
        
        await client.query(query, params);
      }
      
      // Завершение транзакции
      await client.query('COMMIT');
      
      console.log(`Saved ${fuelPrices.length} fuel prices`);
      return true;
    } catch (error) {
      // Откат транзакции в случае ошибки
      await client.query('ROLLBACK');
      console.error('Error saving fuel prices:', error);
      // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию
      return false;
    } finally {
      // Освобождение клиента
      client.release();
    }
  } catch (error) {
    console.error('Error in saveFuelPrices:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию
    return false;
  }
}

// Функция для инициализации коэффициентов топливных надбавок
async function initializeFuelSurchargeFactors() {
  try {
    console.log('Initializing fuel surcharge factors...');
    
    // Проверка наличия данных в таблице
    const countQuery = 'SELECT COUNT(*) FROM fuel_surcharge_factors';
    const countResult = await pool.query(countQuery);
    
    if (countResult.rows[0].count > 0) {
      console.log('Fuel surcharge factors already exist');
      return;
    }
    
    // Определение коэффициентов топливных надбавок
    const factors = [
      {
        base_price: 500, // Базовая цена на топливо в долларах за тонну
        price_range: 100, // Диапазон цен для применения коэффициента
        surcharge_factor: 0.03 // Коэффициент надбавки (3% за каждые 100 долларов)
      }
    ];
    
    // Сохранение коэффициентов в базу данных
    const client = await pool.connect();
    
    try {
      // Начало транзакции
      await client.query('BEGIN');
      
      for (const factor of factors) {
        // Вставка коэффициента в таблицу
        await client.query(
          `INSERT INTO fuel_surcharge_factors 
           (base_price, price_range, surcharge_factor, last_updated) 
           VALUES ($1, $2, $3, NOW())`,
          [
            factor.base_price,
            factor.price_range,
            factor.surcharge_factor
          ]
        );
      }
      
      // Завершение транзакции
      await client.query('COMMIT');
      
      console.log(`Initialized ${factors.length} fuel surcharge factors`);
    } catch (error) {
      // Откат транзакции в случае ошибки
      await client.query('ROLLBACK');
      console.error('Error initializing fuel surcharge factors:', error);
      throw error;
    } finally {
      // Освобождение клиента
      client.release();
    }
  } catch (error) {
    console.error('Error in initializeFuelSurchargeFactors:', error);
    throw error;
  }
}

// Функция для обновления коэффициентов топливных надбавок
async function updateFuelSurchargeFactors(factors) {
  try {
    console.log('Updating fuel surcharge factors...');
    
    // Сохранение коэффициентов в базу данных
    const client = await pool.connect();
    
    try {
      // Начало транзакции
      await client.query('BEGIN');
      
      // Очистка таблицы
      await client.query('DELETE FROM fuel_surcharge_factors');
      
      for (const factor of factors) {
        // Вставка коэффициента в таблицу
        await client.query(
          `INSERT INTO fuel_surcharge_factors 
           (base_price, price_range, surcharge_factor, last_updated) 
           VALUES ($1, $2, $3, NOW())`,
          [
            factor.base_price,
            factor.price_range,
            factor.surcharge_factor
          ]
        );
      }
      
      // Завершение транзакции
      await client.query('COMMIT');
      
      console.log(`Updated ${factors.length} fuel surcharge factors`);
      return true;
    } catch (error) {
      // Откат транзакции в случае ошибки
      await client.query('ROLLBACK');
      console.error('Error updating fuel surcharge factors:', error);
      return false;
    } finally {
      // Освобождение клиента
      client.release();
    }
  } catch (error) {
    console.error('Error in updateFuelSurchargeFactors:', error);
    return false;
  }
}

// Функция для получения всех коэффициентов топливных надбавок
async function getAllFuelSurchargeFactors() {
  try {
    const query = `
      SELECT 
        base_price, 
        price_range, 
        surcharge_factor,
        last_updated
      FROM fuel_surcharge_factors
      ORDER BY base_price
    `;
    
    const result = await pool.query(query);
    return result.rows;
  } catch (error) {
    console.error('Error getting all fuel surcharge factors:', error);
    return [];
  }
}

// Функция для инициализации и обновления всех данных для расчета топливных надбавок
async function initializeAndUpdateFuelSurchargeData() {
  try {
    console.log('Initializing and updating fuel surcharge data...');
    
    // Инициализация таблиц
    await initializeFuelSurchargeTables();
    
    // Получение данных о ценах на топливо
    await fetchFuelPrices();
    
    // Инициализация коэффициентов топливных надбавок
    await initializeFuelSurchargeFactors();
    
    console.log('Fuel surcharge data initialization and update completed');
    return true;
  } catch (error) {
    console.error('Error initializing and updating fuel surcharge data:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать инициализацию системы
    console.log('Continuing system initialization despite fuel surcharge data error');
    return false;
  }
}

// Экспорт функций
export default {
  initializeAndUpdateFuelSurchargeData,
  calculateFuelSurcharge,
  getFuelPriceHistory,
  getAllFuelSurchargeFactors,
  updateFuelSurchargeFactors
};
