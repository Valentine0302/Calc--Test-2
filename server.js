// Исправленная версия server.js с фиксами для SCFI и записи истории запросов

// Объединяет скраперы данных, анализ сезонности и расчет топливной надбавки

import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Импорт модулей скраперов для различных индексов
// Используем прямой импорт для всех скраперов, включая SCFI
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

// Импорт модулей анализа и расчета
import seasonalityAnalyzer from './seasonality_analyzer.js';
import enhancedFreightCalculator from './freight_calculator.js';
import fuelSurchargeCalculator from './fuel_surcharge_calculator.js';

// Загрузка переменных окружения
dotenv.config();

// Определение __dirname для ES модулей
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Подключение к базе данных
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
    sslmode: 'require'
  }
});

// Создание экземпляра Express
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Функция для инициализации всех компонентов системы
async function initializeSystem() {
  try {
    console.log('Initializing enhanced freight calculator system...');
    
    // Инициализация модуля анализа сезонности
    await seasonalityAnalyzer.initializeAndUpdateSeasonalityData(false); // false - не генерировать синтетические данные при первом запуске
    
    // Инициализация модуля расчета топливной надбавки
    await fuelSurchargeCalculator.initializeAndUpdateFuelSurchargeData();
    
    console.log('System initialization completed');
  } catch (error) {
    console.error('Error initializing system:', error);
  }
}

// Маршрут для получения списка портов
app.get('/api/ports', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ports ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching ports:', error);
    res.status(500).json({ error: 'Failed to fetch ports' });
  }
});

// Маршрут для получения типов контейнеров
app.get('/api/container-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM container_types ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching container types:', error);
    res.status(500).json({ error: 'Failed to fetch container types' });
  }
});

// Маршрут для расчета фрахтовой ставки
app.post('/api/calculate', async (req, res) => {
  try {
    const { 
      originPortId, 
      destinationPortId, 
      containerTypeId, 
      containerCount,
      email
    } = req.body;
    
    // Проверка наличия всех необходимых параметров
    if (!originPortId || !destinationPortId || !containerTypeId || !containerCount || !email) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Проверка валидности email
    const emailCheckResult = await pool.query('SELECT * FROM verified_emails WHERE email = $1', [email]);
    
    if (emailCheckResult.rows.length === 0) {
      // Если email не найден в базе верифицированных, проверяем его
      const isValid = await verifyEmail(email);
      
      if (!isValid) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      
      // Сохраняем верифицированный email
      await pool.query('INSERT INTO verified_emails (email, verified_at) VALUES ($1, NOW())', [email]);
    }
    
    // Получение данных о портах
    const originPortResult = await pool.query('SELECT * FROM ports WHERE id = $1', [originPortId]);
    const destinationPortResult = await pool.query('SELECT * FROM ports WHERE id = $1', [destinationPortId]);
    
    if (originPortResult.rows.length === 0 || destinationPortResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid port ID' });
    }
    
    const originPort = originPortResult.rows[0];
    const destinationPort = destinationPortResult.rows[0];
    
    // Получение данных о типе контейнера
    const containerTypeResult = await pool.query('SELECT * FROM container_types WHERE id = $1', [containerTypeId]);
    
    if (containerTypeResult.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid container type ID' });
    }
    
    const containerType = containerTypeResult.rows[0];
    
    // Расчет фрахтовой ставки с использованием улучшенного калькулятора
    const freightRate = await enhancedFreightCalculator.calculateFreightRate(
      originPort,
      destinationPort,
      containerType,
      containerCount
    );
    
    // Расчет топливной надбавки
    const fuelSurcharge = await fuelSurchargeCalculator.calculateFuelSurcharge(
      originPort,
      destinationPort,
      containerType.code
    );
    
    // Расчет сезонной надбавки
    const seasonalFactor = await seasonalityAnalyzer.getSeasonalFactor(
      originPort.region,
      destinationPort.region
    );
    
    // Расчет итоговой стоимости
    const totalRate = freightRate.baseRate + fuelSurcharge + (freightRate.baseRate * seasonalFactor);
    
    // Сохранение результата расчета в истории
    try {
      // Проверяем существование таблицы calculation_history
      const tableCheckResult = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'calculation_history'
        );
      `);
      
      // Если таблица не существует, создаем ее
      if (!tableCheckResult.rows[0].exists) {
        await pool.query(`
          CREATE TABLE calculation_history (
            id SERIAL PRIMARY KEY,
            origin_port_id VARCHAR(10) NOT NULL,
            destination_port_id VARCHAR(10) NOT NULL,
            container_type_id INTEGER NOT NULL,
            container_count INTEGER NOT NULL,
            base_rate NUMERIC NOT NULL,
            fuel_surcharge NUMERIC NOT NULL,
            seasonal_factor NUMERIC NOT NULL,
            total_rate NUMERIC NOT NULL,
            email VARCHAR(255) NOT NULL,
            calculated_at TIMESTAMP NOT NULL DEFAULT NOW()
          )
        `);
      }
      
      // Вставляем запись в историю расчетов
      await pool.query(
        `INSERT INTO calculation_history 
         (origin_port_id, destination_port_id, container_type_id, container_count, 
          base_rate, fuel_surcharge, seasonal_factor, total_rate, email, calculated_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [
          originPortId,
          destinationPortId,
          containerTypeId,
          containerCount,
          freightRate.baseRate,
          fuelSurcharge,
          seasonalFactor,
          totalRate,
          email
        ]
      );
      
      console.log('Calculation history saved successfully');
    } catch (historyError) {
      console.error('Error saving calculation history:', historyError);
      // Продолжаем выполнение, даже если не удалось сохранить историю
    }
    
    // Возвращаем результат расчета
    res.json({
      originPort: originPort.name,
      destinationPort: destinationPort.name,
      containerType: containerType.name,
      containerCount,
      baseRate: freightRate.baseRate,
      fuelSurcharge,
      seasonalFactor,
      totalRate,
      currency: 'USD',
      details: freightRate.details
    });
  } catch (error) {
    console.error('Error calculating freight rate:', error);
    res.status(500).json({ error: 'Failed to calculate freight rate' });
  }
});

// Маршрут для получения истории расчетов
app.get('/api/history', async (req, res) => {
  try {
    const { email } = req.query;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Проверяем существование таблицы calculation_history
    const tableCheckResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'calculation_history'
      );
    `);
    
    // Если таблица не существует, возвращаем пустой массив
    if (!tableCheckResult.rows[0].exists) {
      return res.json([]);
    }
    
    const result = await pool.query(
      `SELECT ch.*, 
        op.name as origin_port_name, 
        dp.name as destination_port_name, 
        ct.name as container_type_name 
       FROM calculation_history ch
       JOIN ports op ON ch.origin_port_id = op.id
       JOIN ports dp ON ch.destination_port_id = dp.id
       JOIN container_types ct ON ch.container_type_id = ct.id
       WHERE ch.email = $1
       ORDER BY ch.calculated_at DESC`,
      [email]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching calculation history:', error);
    res.status(500).json({ error: 'Failed to fetch calculation history' });
  }
});

// Маршрут для получения данных о фрахтовых индексах
app.get('/api/freight-indices', async (req, res) => {
  try {
    const indices = {};
    
    // Получение данных SCFI
    try {
      indices.SCFI = await scfiScraper.getSCFIDataForCalculation();
    } catch (error) {
      console.error('Error fetching SCFI data:', error);
      indices.SCFI = { status: 'Error', error: error.message };
    }
    
    // Получение данных FBX
    try {
      indices.FBX = await fbxScraper.getFBXDataForCalculation();
    } catch (error) {
      console.error('Error fetching FBX data:', error);
      indices.FBX = { status: 'Error', error: error.message };
    }
    
    // Получение данных WCI
    try {
      indices.WCI = await wciScraper.getWCIDataForCalculation();
    } catch (error) {
      console.error('Error fetching WCI data:', error);
      indices.WCI = { status: 'Error', error: error.message };
    }
    
    // Получение данных BDI
    try {
      indices.BDI = await bdiScraper.getBDIDataForCalculation();
    } catch (error) {
      console.error('Error fetching BDI data:', error);
      indices.BDI = { status: 'Error', error: error.message };
    }
    
    // Получение данных CCFI
    try {
      indices.CCFI = await ccfiScraper.getCCFIDataForCalculation();
    } catch (error) {
      console.error('Error fetching CCFI data:', error);
      indices.CCFI = { status: 'Error', error: error.message };
    }
    
    // Получение данных Harpex
    try {
      indices.Harpex = await harpexScraper.getHarpexDataForCalculation();
    } catch (error) {
      console.error('Error fetching Harpex data:', error);
      indices.Harpex = { status: 'Error', error: error.message };
    }
    
    // Получение данных ConTex
    try {
      indices.NewConTex = await contexScraper.getConTexDataForCalculation();
    } catch (error) {
      console.error('Error fetching ConTex data:', error);
      indices.NewConTex = { status: 'Error', error: error.message };
    }
    
    // Получение данных ISTFIX
    try {
      indices.ISTFIX = await istfixScraper.getISTFIXDataForCalculation();
    } catch (error) {
      console.error('Error fetching ISTFIX data:', error);
      indices.ISTFIX = { status: 'Error', error: error.message };
    }
    
    // Получение данных CTS
    try {
      indices.CTS = await ctsScraper.getCTSDataForCalculation();
    } catch (error) {
      console.error('Error fetching CTS data:', error);
      indices.CTS = { status: 'Error', error: error.message };
    }
    
    // Получение данных о ценах на топливо
    try {
      indices.FuelPrices = await fuelSurchargeCalculator.getCurrentFuelPrice();
    } catch (error) {
      console.error('Error fetching fuel prices:', error);
      indices.FuelPrices = { status: 'Error', error: error.message };
    }
    
    // Получение данных о сезонности
    try {
      indices.Seasonality = await seasonalityAnalyzer.getCurrentSeasonalityData();
    } catch (error) {
      console.error('Error fetching seasonality data:', error);
      indices.Seasonality = { status: 'Error', error: error.message };
    }
    
    res.json(indices);
  } catch (error) {
    console.error('Error fetching freight indices:', error);
    res.status(500).json({ error: 'Failed to fetch freight indices' });
  }
});

// Маршрут для получения данных о ценах на топливо
app.get('/api/fuel-prices', async (req, res) => {
  try {
    const fuelPrices = await fuelSurchargeCalculator.getCurrentFuelPrice();
    res.json(fuelPrices);
  } catch (error) {
    console.error('Error fetching fuel prices:', error);
    res.status(500).json({ error: 'Failed to fetch fuel prices' });
  }
});

// Маршрут для получения истории цен на топливо
app.get('/api/fuel-prices/history', async (req, res) => {
  try {
    const fuelPriceHistory = await fuelSurchargeCalculator.getFuelPriceHistory();
    res.json(fuelPriceHistory);
  } catch (error) {
    console.error('Error fetching fuel price history:', error);
    res.status(500).json({ error: 'Failed to fetch fuel price history' });
  }
});

// Маршрут для получения данных о сезонности
app.get('/api/seasonality', async (req, res) => {
  try {
    const seasonalityData = await seasonalityAnalyzer.getCurrentSeasonalityData();
    res.json(seasonalityData);
  } catch (error) {
    console.error('Error fetching seasonality data:', error);
    res.status(500).json({ error: 'Failed to fetch seasonality data' });
  }
});

// Маршрут для получения расстояния между портами
app.get('/api/port-distance', async (req, res) => {
  try {
    const { originPortId, destinationPortId } = req.query;
    
    if (!originPortId || !destinationPortId) {
      return res.status(400).json({ error: 'Origin and destination port IDs are required' });
    }
    
    const distance = await fuelSurchargeCalculator.getPortDistance(originPortId, destinationPortId);
    res.json({ distance });
  } catch (error) {
    console.error('Error fetching port distance:', error);
    res.status(500).json({ error: 'Failed to fetch port distance' });
  }
});

// Функция для проверки валидности email
async function verifyEmail(email) {
  // Базовая проверка формата email
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return false;
  }
  
  // Проверка на временные email-сервисы
  const tempEmailDomains = [
    'tempmail.com', 'temp-mail.org', 'guerrillamail.com', 'mailinator.com',
    'throwawaymail.com', '10minutemail.com', 'yopmail.com', 'getnada.com'
  ];
  
  const domain = email.split('@')[1];
  if (tempEmailDomains.includes(domain)) {
    return false;
  }
  
  // Дополнительные проверки можно добавить здесь
  
  return true;
}

// Административные маршруты

// Маршрут для обновления данных о фрахтовых индексах
app.post('/api/admin/update-indices', async (req, res) => {
  try {
    const { apiKey } = req.body;
    
    // Проверка API ключа
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    const updateResults = {};
    
    // Обновление данных SCFI
    try {
      // Явно вызываем fetchSCFIData и обрабатываем результат
      const scfiResult = await scfiScraper.fetchSCFIData();
      console.log('SCFI update result:', scfiResult);
      updateResults.SCFI = scfiResult && scfiResult.length > 0 ? 'Success' : 'Error';
    } catch (error) {
      console.error('Error updating SCFI data:', error);
      updateResults.SCFI = 'Error';
    }
    
    // Обновление данных FBX
    try {
      await fbxScraper.fetchFBXData();
      updateResults.FBX = 'Success';
    } catch (error) {
      console.error('Error updating FBX data:', error);
      updateResults.FBX = 'Error';
    }
    
    // Обновление данных WCI
    try {
      await wciScraper.fetchWCIData();
      updateResults.WCI = 'Success';
    } catch (error) {
      console.error('Error updating WCI data:', error);
      updateResults.WCI = 'Error';
    }
    
    // Обновление данных BDI
    try {
      await bdiScraper.fetchBDIData();
      updateResults.BDI = 'Success';
    } catch (error) {
      console.error('Error updating BDI data:', error);
      updateResults.BDI = 'Error';
    }
    
    // Обновление данных CCFI
    try {
      await ccfiScraper.fetchCCFIData();
      updateResults.CCFI = 'Success';
    } catch (error) {
      console.error('Error updating CCFI data:', error);
      updateResults.CCFI = 'Error';
    }
    
    // Обновление данных Harpex
    try {
      await harpexScraper.fetchHarpexData();
      updateResults.Harpex = 'Success';
    } catch (error) {
      console.error('Error updating Harpex data:', error);
      updateResults.Harpex = 'Error';
    }
    
    // Обновление данных ConTex
    try {
      await contexScraper.fetchConTexData();
      updateResults.NewConTex = 'Success';
    } catch (error) {
      console.error('Error updating ConTex data:', error);
      updateResults.NewConTex = 'Error';
    }
    
    // Обновление данных ISTFIX
    try {
      await istfixScraper.fetchISTFIXData();
      updateResults.ISTFIX = 'Success';
    } catch (error) {
      console.error('Error updating ISTFIX data:', error);
      updateResults.ISTFIX = 'Error';
    }
    
    // Обновление данных CTS
    try {
      await ctsScraper.fetchCTSData();
      updateResults.CTS = 'Success';
    } catch (error) {
      console.error('Error updating CTS data:', error);
      updateResults.CTS = 'Error';
    }
    
    // Обновление данных о ценах на топливо
    try {
      await fuelSurchargeCalculator.fetchCurrentFuelPrices();
      updateResults.FuelPrices = 'Success';
    } catch (error) {
      console.error('Error updating fuel prices:', error);
      updateResults.FuelPrices = 'Error';
    }
    
    // Обновление данных о сезонности
    try {
      await seasonalityAnalyzer.updateSeasonalityData();
      updateResults.Seasonality = 'Success';
    } catch (error) {
      console.error('Error updating seasonality data:', error);
      updateResults.Seasonality = 'Error';
    }
    
    res.json(updateResults);
  } catch (error) {
    console.error('Error updating freight indices:', error);
    res.status(500).json({ error: 'Failed to update freight indices' });
  }
});

// Маршрут для получения статистики использования
app.get('/api/admin/statistics', async (req, res) => {
  try {
    const { apiKey } = req.query;
    
    // Проверка API ключа
    if (apiKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({ error: 'Invalid API key' });
    }
    
    // Проверяем существование таблицы calculation_history
    const tableCheckResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'calculation_history'
      );
    `);
    
    // Если таблица не существует, возвращаем пустые данные
    if (!tableCheckResult.rows[0].exists) {
      return res.json({
        calculations: {
          total_calculations: 0,
          unique_users: 0,
          average_rate: 0,
          last_calculation: null
        },
        popularRoutes: [],
        containerTypes: []
      });
    }
    
    // Получение статистики по расчетам
    const calculationsResult = await pool.query(
      `SELECT 
        COUNT(*) as total_calculations,
        COUNT(DISTINCT email) as unique_users,
        AVG(total_rate) as average_rate,
        MAX(calculated_at) as last_calculation
       FROM calculation_history`
    );
    
    // Получение статистики по популярным маршрутам
    const routesResult = await pool.query(
      `SELECT 
        op.name as origin_port,
        dp.name as destination_port,
        COUNT(*) as count
       FROM calculation_history ch
       JOIN ports op ON ch.origin_port_id = op.id
       JOIN ports dp ON ch.destination_port_id = dp.id
       GROUP BY op.name, dp.name
       ORDER BY count DESC
       LIMIT 10`
    );
    
    // Получение статистики по типам контейнеров
    const containerTypesResult = await pool.query(
      `SELECT 
        ct.name as container_type,
        COUNT(*) as count
       FROM calculation_history ch
       JOIN container_types ct ON ch.container_type_id = ct.id
       GROUP BY ct.name
       ORDER BY count DESC`
    );
    
    res.json({
      calculations: calculationsResult.rows[0],
      popularRoutes: routesResult.rows,
      containerTypes: containerTypesResult.rows
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Запуск сервера
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);
  
  // Инициализация системы при запуске сервера
  await initializeSystem();
});

// Экспорт для тестирования
export default app;
