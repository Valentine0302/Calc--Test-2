// Интеграционный модуль для объединения всех компонентов улучшенного калькулятора фрахтовых ставок
// Объединяет скраперы данных, анализ сезонности и расчет топливной надбавки

import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

// Импорт модулей скраперов для различных индексов
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
import fuelSurchargeCalculator from './fuel_surcharge_calculator.js';
import enhancedFreightCalculator from './freight_calculator.js';

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

// Маршрут для расчета фрахтовой ставки
app.post('/api/calculate', async (req, res) => {
  try {
    const { originPort, destinationPort, containerType, weight, email } = req.body;
    
    // Проверка наличия всех необходимых параметров
    if (!originPort || !destinationPort || !containerType || !weight) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Проверка валидности email, если он предоставлен
    if (email && !validateEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Расчет фрахтовой ставки
    const result = await enhancedFreightCalculator.calculateFreightRate(
      originPort,
      destinationPort,
      containerType,
      weight
    );
    
    // Сохранение запроса в историю, если предоставлен email
    if (email) {
      await saveRequestToHistory(originPort, destinationPort, containerType, weight, result.finalRate, email);
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error calculating freight rate:', error);
    res.status(500).json({ error: 'Failed to calculate freight rate' });
  }
});

// Маршрут для получения истории расчетов
app.get('/api/history', async (req, res) => {
  try {
    const result = await enhancedFreightCalculator.getCalculationHistory();
    res.json(result);
  } catch (error) {
    console.error('Error fetching calculation history:', error);
    res.status(500).json({ error: 'Failed to fetch calculation history' });
  }
});

// Маршрут для получения коэффициентов сезонности
app.get('/api/seasonality', async (req, res) => {
  try {
    const { originRegion, destinationRegion } = req.query;
    
    // Если указаны регионы, возвращаем коэффициенты для конкретной пары
    if (originRegion && destinationRegion) {
      const factors = [];
      
      // Получение коэффициентов для всех месяцев
      for (let month = 1; month <= 12; month++) {
        const factor = await seasonalityAnalyzer.getSeasonalityFactor(originRegion, destinationRegion, month);
        factors.push({
          month,
          factor: factor.factor,
          confidence: factor.confidence
        });
      }
      
      res.json(factors);
    } else {
      // Иначе возвращаем все коэффициенты
      const factors = await seasonalityAnalyzer.getAllSeasonalityFactors();
      res.json(factors);
    }
  } catch (error) {
    console.error('Error fetching seasonality factors:', error);
    res.status(500).json({ error: 'Failed to fetch seasonality factors' });
  }
});

// Маршрут для получения исторических данных для визуализации
app.get('/api/historical-rates', async (req, res) => {
  try {
    const { originRegion, destinationRegion, containerType, months } = req.query;
    
    // Проверка наличия всех необходимых параметров
    if (!originRegion || !destinationRegion) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const historicalRates = await seasonalityAnalyzer.getHistoricalRatesForVisualization(
      originRegion,
      destinationRegion,
      containerType || '40DC',
      parseInt(months) || 24
    );
    
    res.json(historicalRates);
  } catch (error) {
    console.error('Error fetching historical rates:', error);
    res.status(500).json({ error: 'Failed to fetch historical rates' });
  }
});

// Маршрут для получения истории цен на топливо
app.get('/api/fuel-prices', async (req, res) => {
  try {
    const { fuelType, months } = req.query;
    
    const fuelPrices = await fuelSurchargeCalculator.getFuelPriceHistory(
      fuelType || 'VLSFO',
      parseInt(months) || 12
    );
    
    res.json(fuelPrices);
  } catch (error) {
    console.error('Error fetching fuel prices:', error);
    res.status(500).json({ error: 'Failed to fetch fuel prices' });
  }
});

// Маршрут для получения текущих значений индексов
app.get('/api/indices', async (req, res) => {
  try {
    // Сбор данных из всех доступных источников
    const indices = {};
    
    // SCFI
    try {
      const scfiData = await scfiScraper.getSCFIDataForCalculation();
      if (scfiData) {
        indices.SCFI = {
          currentIndex: scfiData.current_index,
          change: scfiData.change,
          indexDate: scfiData.index_date
        };
      }
    } catch (error) {
      console.error('Error fetching SCFI data:', error);
    }
    
    // FBX
    try {
      const fbxData = await fbxScraper.getFBXDataForCalculation();
      if (fbxData) {
        indices.FBX = {
          currentIndex: fbxData.current_index,
          change: fbxData.change,
          indexDate: fbxData.index_date
        };
      }
    } catch (error) {
      console.error('Error fetching FBX data:', error);
    }
    
    // WCI
    try {
      const wciData = await wciScraper.getWCIDataForCalculation();
      if (wciData) {
        indices.WCI = {
          currentIndex: wciData.current_index,
          change: wciData.change,
          indexDate: wciData.index_date
        };
      }
    } catch (error) {
      console.error('Error fetching WCI data:', error);
    }
    
    // BDI
    try {
      const bdiData = await bdiScraper.getBDIDataForCalculation();
      if (bdiData) {
        indices.BDI = {
          currentIndex: bdiData.current_index,
          change: bdiData.change,
          indexDate: bdiData.index_date
        };
      }
    } catch (error) {
      console.error('Error fetching BDI data:', error);
    }
    
    // CCFI
    try {
      const ccfiData = await ccfiScraper.getCCFIDataForCalculation();
      if (ccfiData) {
        indices.CCFI = {
          currentIndex: ccfiData.current_index,
          change: ccfiData.change,
          indexDate: ccfiData.index_date
        };
      }
    } catch (error) {
      console.error('Error fetching CCFI data:', error);
    }
    
    // Harpex
    try {
      const harpexData = await harpexScraper.getHarpexDataForCalculation();
      if (harpexData) {
        indices.Harpex = {
          currentIndex: harpexData.current_index,
          change: harpexData.change,
          indexDate: harpexData.index_date
        };
      }
    } catch (error) {
      console.error('Error fetching Harpex data:', error);
    }
    
    // New ConTex
    try {
      const contexData = await contexScraper.getContexDataForCalculation();
      if (contexData) {
        indices.NewConTex = {
          currentIndex: contexData.current_index,
          change: contexData.change,
          indexDate: contexData.index_date
        };
      }
    } catch (error) {
      console.error('Error fetching New ConTex data:', error);
    }
    
    // ISTFIX
    try {
      const istfixData = await istfixScraper.getISTFIXDataForCalculation();
      if (istfixData) {
        indices.ISTFIX = {
          currentIndex: istfixData.current_index,
          change: istfixData.change,
          indexDate: istfixData.index_date
        };
      }
    } catch (error) {
      console.error('Error fetching ISTFIX data:', error);
    }
    
    // CTS
    try {
      const ctsData = await ctsScraper.getCTSDataForCalculation();
      if (ctsData) {
        indices.CTS = {
          currentIndex: ctsData.current_index,
          change: ctsData.change,
          indexDate: ctsData.index_date
        };
      }
    } catch (error) {
      console.error('Error fetching CTS data:', error);
    }
    
    res.json(indices);
  } catch (error) {
    console.error('Error fetching indices:', error);
    res.status(500).json({ error: 'Failed to fetch indices' });
  }
});

// Маршрут для обновления данных индексов
app.post('/api/update-indices', async (req, res) => {
  try {
    const results = {};
    
    // Обновление данных SCFI
    try {
      const scfiData = await scfiScraper.fetchSCFIData();
      results.SCFI = { success: true, count: scfiData.length };
    } catch (error) {
      results.SCFI = { success: false, error: error.message };
    }
    
    // Обновление данных FBX
    try {
      const fbxData = await fbxScraper.fetchFBXData();
      results.FBX = { success: true, count: fbxData.length };
    } catch (error) {
      results.FBX = { success: false, error: error.message };
    }
    
    // Обновление данных WCI
    try {
      const wciData = await wciScraper.fetchWCIData();
      results.WCI = { success: true, count: wciData.length };
    } catch (error) {
      results.WCI = { success: false, error: error.message };
    }
    
    // Обновление данных BDI
    try {
      const bdiData = await bdiScraper.fetchBDIData();
      results.BDI = { success: true, count: bdiData.length };
    } catch (error) {
      results.BDI = { success: false, error: error.message };
    }
    
    // Обновление данных CCFI
    try {
      const ccfiData = await ccfiScraper.fetchCCFIData();
      results.CCFI = { success: true, count: ccfiData.length };
    } catch (error) {
      results.CCFI = { success: false, error: error.message };
    }
    
    // Обновление данных Harpex
    try {
      const harpexData = await harpexScraper.fetchHarpexData();
      results.Harpex = { success: true, count: harpexData.length };
    } catch (error) {
      results.Harpex = { success: false, error: error.message };
    }
    
    // Обновление данных New ConTex
    try {
      const contexData = await contexScraper.fetchContexData();
      results.NewConTex = { success: true, count: contexData.length };
    } catch (error) {
      results.NewConTex = { success: false, error: error.message };
    }
    
    // Обновление данных ISTFIX
    try {
      const istfixData = await istfixScraper.fetchISTFIXData();
      results.ISTFIX = { success: true, count: istfixData.length };
    } catch (error) {
      results.ISTFIX = { success: false, error: error.message };
    }
    
    // Обновление данных CTS
    try {
      const ctsData = await ctsScraper.fetchCTSData();
      results.CTS = { success: true, count: ctsData.length };
    } catch (error) {
      results.CTS = { success: false, error: error.message };
    }
    
    // Обновление цен на топливо
    try {
      const fuelPrices = await fuelSurchargeCalculator.fetchCurrentFuelPrices();
      results.FuelPrices = { success: true, count: Object.keys(fuelPrices).length };
    } catch (error) {
      results.FuelPrices = { success: false, error: error.message };
    }
    
    // Обновление коэффициентов сезонности
    try {
      await seasonalityAnalyzer.analyzeSeasonalityFactors();
      results.Seasonality = { success: true };
    } catch (error) {
      results.Seasonality = { success: false, error: error.message };
    }
    
    res.json(results);
  } catch (error) {
    console.error('Error updating indices:', error);
    res.status(500).json({ error: 'Failed to update indices' });
  }
});

// Маршрут для получения расчета топливной надбавки
app.post('/api/fuel-surcharge', async (req, res) => {
  try {
    const { originPort, destinationPort, containerType, fuelType } = req.body;
    
    // Проверка наличия всех необходимых параметров
    if (!originPort || !destinationPort || !containerType) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Расчет топливной надбавки
    const result = await fuelSurchargeCalculator.calculateFuelSurcharge(
      originPort,
      destinationPort,
      containerType,
      fuelType || 'VLSFO'
    );
    
    res.json(result);
  } catch (error) {
    console.error('Error calculating fuel surcharge:', error);
    res.status(500).json({ error: 'Failed to calculate fuel surcharge' });
  }
});

// Функция для сохранения запроса в историю
async function saveRequestToHistory(originPort, destinationPort, containerType, weight, rate, email) {
  try {
    // Проверка существования таблицы request_history
    const tableCheckResult = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'request_history'
      )
    `);
    
    // Если таблица не существует, создаем ее
    if (!tableCheckResult.rows[0].exists) {
      await pool.query(`
        CREATE TABLE request_history (
          id SERIAL PRIMARY KEY,
          origin_port_id INTEGER NOT NULL,
          destination_port_id INTEGER NOT NULL,
          container_type VARCHAR(10) NOT NULL,
          weight INTEGER NOT NULL,
          rate NUMERIC NOT NULL,
          email VARCHAR(255) NOT NULL,
          request_date TIMESTAMP NOT NULL DEFAULT NOW(),
          FOREIGN KEY (origin_port_id) REFERENCES ports(id),
          FOREIGN KEY (destination_port_id) REFERENCES ports(id)
        )
      `);
    }
    
    // Сохранение запроса в историю
    await pool.query(
      `INSERT INTO request_history 
       (origin_port_id, destination_port_id, container_type, weight, rate, email) 
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        originPort,
        destinationPort,
        containerType,
        weight,
        rate,
        email
      ]
    );
    
    console.log('Request saved to history');
  } catch (error) {
    console.error('Error saving request to history:', error);
    // Ошибка сохранения истории не должна прерывать основной процесс
  }
}

// Функция для валидации email
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

// Запуск сервера
// Маршруты для административной панели
// Добавляем в server.js

// Маршрут для административной панели
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Маршрут для получения всех данных о портах для администратора
app.get('/api/admin/ports', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ports ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching ports for admin:', error);
    res.status(500).json({ error: 'Failed to fetch ports' });
  }
});

// Маршрут для получения всех расчетов для администратора
app.get('/api/admin/calculations', async (req, res) => {
  try {
    const query = `
      SELECT 
        ch.id,
        p1.name as origin_port_name,
        p2.name as destination_port_name,
        ch.container_type,
        ch.weight,
        ch.rate,
        ch.email,
        ch.created_at
      FROM calculation_history ch
      JOIN ports p1 ON ch.origin_port_id = p1.id
      JOIN ports p2 ON ch.destination_port_id = p2.id
      ORDER BY ch.created_at DESC
      LIMIT 100
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching calculations for admin:', error);
    res.status(500).json({ error: 'Failed to fetch calculations' });
  }
});

// Маршрут для получения всех индексов для администратора
app.get('/api/admin/indices', async (req, res) => {
  try {
    // Получение всех индексов из базы данных
    const query = `
      SELECT * FROM indices
      ORDER BY index_date DESC
    `;
    
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching indices for admin:', error);
    res.status(500).json({ error: 'Failed to fetch indices' });
  }
});

// Маршрут для обновления данных порта
app.put('/api/admin/ports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, region, latitude, longitude } = req.body;
    
    // Проверка наличия всех необходимых параметров
    if (!name || !code || !region) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Обновление данных порта
    const query = `
      UPDATE ports
      SET name = $1, code = $2, region = $3, latitude = $4, longitude = $5
      WHERE id = $6
      RETURNING *
    `;
    
    const result = await pool.query(query, [name, code, region, latitude, longitude, id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Port not found' });
    }
    
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating port:', error);
    res.status(500).json({ error: 'Failed to update port' });
  }
});

// Маршрут для добавления нового порта
app.post('/api/admin/ports', async (req, res) => {
  try {
    const { name, code, region, latitude, longitude } = req.body;
    
    // Проверка наличия всех необходимых параметров
    if (!name || !code || !region) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Добавление нового порта
    const query = `
      INSERT INTO ports (name, code, region, latitude, longitude)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *
    `;
    
    const result = await pool.query(query, [name, code, region, latitude, longitude]);
    
    res.status(201).json(result.rows[0]);
  } catch (error) {
    console.error('Error adding port:', error);
    res.status(500).json({ error: 'Failed to add port' });
  }
});

// Маршрут для удаления порта
app.delete('/api/admin/ports/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Проверка использования порта в расчетах
    const checkQuery = `
      SELECT COUNT(*) FROM calculation_history
      WHERE origin_port_id = $1 OR destination_port_id = $1
    `;
    
    const checkResult = await pool.query(checkQuery, [id]);
    
    if (checkResult.rows[0].count > 0) {
      return res.status(400).json({ error: 'Cannot delete port that is used in calculations' });
    }
    
    // Удаление порта
    const query = `
      DELETE FROM ports
      WHERE id = $1
      RETURNING *
    `;
    
    const result = await pool.query(query, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Port not found' });
    }
    
    res.json({ message: 'Port deleted successfully' });
  } catch (error) {
    console.error('Error deleting port:', error);
    res.status(500).json({ error: 'Failed to delete port' });
  }
});
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Инициализация системы при запуске сервера
  await initializeSystem();
});

export default app;
