// Модифицированный server.js с автоматическим сбросом проблемных таблиц при запуске

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const path = require('path');
const enhancedFreightCalculator = require('./freight_calculator.js');
const seasonalityAnalyzer = require('./seasonality_analyzer.js');
const fuelSurchargeCalculator = require('./fuel_surcharge_calculator.js');

// Загрузка переменных окружения
dotenv.config();

// Настройка Express
const app = express();
const PORT = process.env.PORT || 10000;

// Настройка CORS
app.use(cors());
app.use(express.json());

// Настройка статических файлов
const __dirname = path.dirname(__filename);
app.use(express.static(path.join(__dirname, 'public')));

// Подключение к базе данных
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
    sslmode: 'require'
  }
});

// Функция для автоматического сброса проблемных таблиц при запуске
async function resetProblematicTables() {
  try {
    console.log('Resetting problematic tables...');
    await pool.query('DROP TABLE IF EXISTS historical_rates CASCADE');
    await pool.query('DROP TABLE IF EXISTS fuel_prices CASCADE');
    console.log('Tables reset successfully');
  } catch (error) {
    console.error('Error resetting tables:', error);
  }
}

// Функция для инициализации системы
async function initializeSystem() {
  console.log('Initializing enhanced freight calculator system...');
  
  // Сначала сбрасываем проблемные таблицы
  await resetProblematicTables();
  
  // Инициализация данных для анализа сезонности
  await seasonalityAnalyzer.initializeAndUpdateSeasonalityData();
  
  // Инициализация данных для расчета топливных надбавок
  await fuelSurchargeCalculator.initializeAndUpdateFuelSurchargeData();
  
  console.log('System initialization completed');
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

// Маршрут для получения списка типов контейнеров
app.get('/api/container-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM container_types ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching container types:', error);
    res.status(500).json({ error: 'Failed to fetch container types' });
  }
});

// Маршрут для расчета ставки фрахта
app.post('/api/calculate', async (req, res) => {
  try {
    const { originPort, destinationPort, containerType, weight, email } = req.body;
    
    // Проверка наличия всех необходимых параметров
    if (!originPort || !destinationPort || !containerType) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    // Расчет ставки фрахта
    const result = await enhancedFreightCalculator.calculateFreightRate(
      originPort,
      destinationPort,
      containerType,
      weight || 20000 // Используем значение по умолчанию, если не указано
    );
    
    // Сохранение результата расчета в базу данных
    await saveCalculationHistory(originPort, destinationPort, containerType, result.rate, result.sources);
    
    // Отправка результата на email, если он указан
    if (email) {
      await sendResultByEmail(email, originPort, destinationPort, containerType, result);
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error calculating freight rate:', error);
    res.status(500).json({ error: 'Failed to calculate freight rate' });
  }
});

// Функция для сохранения истории расчетов
async function saveCalculationHistory(originPort, destinationPort, containerType, rate, sources) {
  try {
    // Проверяем структуру таблицы calculation_history
    const columnsQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'calculation_history'
    `;
    
    const columnsResult = await pool.query(columnsQuery);
    const columns = columnsResult.rows.map(row => row.column_name);
    
    // Формируем запрос в зависимости от доступных колонок
    let query;
    let params;
    
    if (columns.includes('origin_port_id') && columns.includes('destination_port_id')) {
      query = `
        INSERT INTO calculation_history 
        (origin_port_id, destination_port_id, container_type, rate, sources, created_at) 
        VALUES ($1, $2, $3, $4, $5, NOW())
      `;
      params = [originPort, destinationPort, containerType, rate, sources];
    } else if (columns.includes('origin_port') && columns.includes('destination_port')) {
      query = `
        INSERT INTO calculation_history 
        (origin_port, destination_port, container_type, rate, sources, created_at) 
        VALUES ($1, $2, $3, $4, $5, NOW())
      `;
      params = [originPort, destinationPort, containerType, rate, sources];
    } else {
      // Если таблица не существует или имеет неожиданную структуру, создаем её
      await pool.query(`
        CREATE TABLE IF NOT EXISTS calculation_history (
          id SERIAL PRIMARY KEY,
          origin_port_id VARCHAR(10) NOT NULL,
          destination_port_id VARCHAR(10) NOT NULL,
          container_type VARCHAR(10) NOT NULL,
          rate NUMERIC NOT NULL,
          sources TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `);
      
      query = `
        INSERT INTO calculation_history 
        (origin_port_id, destination_port_id, container_type, rate, sources, created_at) 
        VALUES ($1, $2, $3, $4, $5, NOW())
      `;
      params = [originPort, destinationPort, containerType, rate, sources];
    }
    
    await pool.query(query, params);
    console.log('Calculation history saved');
  } catch (error) {
    console.error('Error saving calculation history:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать ответ API
  }
}

// Функция для отправки результата расчета по email
async function sendResultByEmail(email, originPort, destinationPort, containerType, result) {
  try {
    // Получение информации о портах
    const originPortInfo = await getPortInfo(originPort);
    const destinationPortInfo = await getPortInfo(destinationPort);
    
    // Получение информации о типе контейнера
    const containerTypeInfo = await getContainerTypeInfo(containerType);
    
    // Настройка транспорта для отправки email
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      secure: process.env.EMAIL_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      }
    });
    
    // Формирование текста письма
    const mailOptions = {
      from: process.env.EMAIL_FROM,
      to: email,
      subject: 'Freight Rate Calculation Result',
      html: `
        <h2>Freight Rate Calculation Result</h2>
        <p><strong>Route:</strong> ${originPortInfo.name} (${originPort}) → ${destinationPortInfo.name} (${destinationPort})</p>
        <p><strong>Container Type:</strong> ${containerTypeInfo.name} - ${containerTypeInfo.description}</p>
        <p><strong>Calculated Rate:</strong> $${result.rate}</p>
        <p><strong>Rate Range:</strong> $${result.minRate || result.min_rate} - $${result.maxRate || result.max_rate}</p>
        <p><strong>Reliability:</strong> ${Math.round((result.reliability || 0.7) * 100)}%</p>
        <p><strong>Based on:</strong> ${result.sourceCount || result.source_count} sources</p>
        <p><strong>Calculation Date:</strong> ${new Date().toLocaleDateString()}</p>
        <hr>
        <p>This is an automated message from the Freight Rate Calculator.</p>
      `
    };
    
    // Отправка письма
    await transporter.sendMail(mailOptions);
    console.log(`Calculation result sent to ${email}`);
  } catch (error) {
    console.error('Error sending email:', error);
    // Не пробрасываем ошибку дальше, чтобы не прерывать ответ API
  }
}

// Функция для получения информации о порте
async function getPortInfo(portId) {
  try {
    const result = await pool.query('SELECT * FROM ports WHERE id = $1', [portId]);
    return result.rows[0] || { name: 'Unknown Port', region: 'Unknown' };
  } catch (error) {
    console.error('Error getting port info:', error);
    return { name: 'Unknown Port', region: 'Unknown' };
  }
}

// Функция для получения информации о типе контейнера
async function getContainerTypeInfo(containerTypeId) {
  try {
    const result = await pool.query('SELECT * FROM container_types WHERE id = $1', [containerTypeId]);
    return result.rows[0] || { name: 'Unknown Container', description: '' };
  } catch (error) {
    console.error('Error getting container type info:', error);
    return { name: 'Unknown Container', description: '' };
  }
}

// Маршрут для административной панели
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Маршрут для получения данных о сезонности
app.get('/api/seasonality', async (req, res) => {
  try {
    const factors = await seasonalityAnalyzer.getAllSeasonalityFactors();
    res.json(factors);
  } catch (error) {
    console.error('Error fetching seasonality data:', error);
    res.status(500).json({ error: 'Failed to fetch seasonality data' });
  }
});

// Маршрут для получения данных о ценах на топливо
app.get('/api/fuel-prices', async (req, res) => {
  try {
    const months = req.query.months ? parseInt(req.query.months) : 12;
    const prices = await fuelSurchargeCalculator.getFuelPriceHistory(months);
    res.json(prices);
  } catch (error) {
    console.error('Error fetching fuel prices:', error);
    res.status(500).json({ error: 'Failed to fetch fuel prices' });
  }
});

// Маршрут для получения коэффициентов топливных надбавок
app.get('/api/fuel-surcharge-factors', async (req, res) => {
  try {
    const factors = await fuelSurchargeCalculator.getAllFuelSurchargeFactors();
    res.json(factors);
  } catch (error) {
    console.error('Error fetching fuel surcharge factors:', error);
    res.status(500).json({ error: 'Failed to fetch fuel surcharge factors' });
  }
});

// Маршрут для обновления коэффициентов топливных надбавок
app.post('/api/fuel-surcharge-factors', async (req, res) => {
  try {
    const { factors } = req.body;
    
    if (!factors || !Array.isArray(factors)) {
      return res.status(400).json({ error: 'Invalid factors data' });
    }
    
    const result = await fuelSurchargeCalculator.updateFuelSurchargeFactors(factors);
    
    if (result) {
      res.json({ success: true, message: 'Fuel surcharge factors updated successfully' });
    } else {
      res.status(500).json({ error: 'Failed to update fuel surcharge factors' });
    }
  } catch (error) {
    console.error('Error updating fuel surcharge factors:', error);
    res.status(500).json({ error: 'Failed to update fuel surcharge factors' });
  }
});

// Маршрут для получения исторических данных о ставках
app.get('/api/historical-rates', async (req, res) => {
  try {
    const { originRegion, destinationRegion, containerType, months } = req.query;
    
    if (!originRegion || !destinationRegion || !containerType) {
      return res.status(400).json({ error: 'Missing required parameters' });
    }
    
    const data = await seasonalityAnalyzer.getHistoricalRatesForVisualization(
      originRegion,
      destinationRegion,
      containerType,
      parseInt(months) || 12
    );
    
    res.json(data);
  } catch (error) {
    console.error('Error fetching historical rates:', error);
    res.status(500).json({ error: 'Failed to fetch historical rates' });
  }
});

// Маршрут для запуска анализа сезонности
app.post('/api/analyze-seasonality', async (req, res) => {
  try {
    const result = await seasonalityAnalyzer.analyzeSeasonalityFactors();
    
    if (result) {
      res.json({ success: true, message: 'Seasonality analysis completed successfully' });
    } else {
      res.status(500).json({ error: 'Failed to analyze seasonality' });
    }
  } catch (error) {
    console.error('Error analyzing seasonality:', error);
    res.status(500).json({ error: 'Failed to analyze seasonality' });
  }
});

// Запуск сервера
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  
  // Инициализация системы при запуске
  await initializeSystem();
});
