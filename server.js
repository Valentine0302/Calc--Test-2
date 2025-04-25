// Обновленный server.js с интеграцией модулей для улучшенного расчета ставок фрахта
// Включает кэширование данных для оптимизации производительности

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';
import { promisify } from 'util';

// Импорт модулей для расчета ставок фрахта
import freightCalculator from './freight_calculator.js';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Setup middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Database connection with enhanced SSL parameters
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
    sslmode: 'require'
  }
});

// Convert ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Кэш для данных о ставках фрахта
const rateCache = {
  lastUpdate: null,
  updateInterval: 3600000, // 1 час в миллисекундах
  isUpdating: false
};

// Initialize database tables if they don't exist
async function initializeTables() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS calculation_history (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP NOT NULL,
        email VARCHAR(255) NOT NULL,
        origin VARCHAR(50) NOT NULL,
        destination VARCHAR(50) NOT NULL,
        container_type VARCHAR(50) NOT NULL,
        rate NUMERIC NOT NULL,
        min_rate NUMERIC NOT NULL,
        max_rate NUMERIC NOT NULL,
        reliability NUMERIC NOT NULL,
        source_count INTEGER NOT NULL,
        sources TEXT
      );

      CREATE TABLE IF NOT EXISTS ports (
        id VARCHAR(10) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        country VARCHAR(100) NOT NULL,
        region VARCHAR(100) NOT NULL,
        latitude NUMERIC,
        longitude NUMERIC,
        popularity NUMERIC DEFAULT 0.5
      );

      CREATE TABLE IF NOT EXISTS container_types (
        id VARCHAR(10) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description VARCHAR(255) NOT NULL
      );
      
      CREATE TABLE IF NOT EXISTS port_requests (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMP NOT NULL,
        port_name VARCHAR(100) NOT NULL,
        country VARCHAR(100) NOT NULL,
        region VARCHAR(100),
        request_reason TEXT,
        user_email VARCHAR(255) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'pending'
      );
      
      CREATE TABLE IF NOT EXISTS verified_emails (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) NOT NULL UNIQUE,
        verified_at TIMESTAMP NOT NULL
      );

      CREATE TABLE IF NOT EXISTS freight_indices_update_log (
        id SERIAL PRIMARY KEY,
        source VARCHAR(50) NOT NULL,
        update_time TIMESTAMP NOT NULL DEFAULT NOW(),
        status VARCHAR(20) NOT NULL,
        message TEXT
      );
    `);
    
    // Check if container types exist
    const containerTypesResult = await pool.query('SELECT COUNT(*) FROM container_types');
    if (parseInt(containerTypesResult.rows[0].count) === 0) {
      // Insert initial container types
      await pool.query(`
        INSERT INTO container_types (id, name, description) VALUES
        ('20DV', '20'' Dry Van', 'Standard 20-foot dry container'),
        ('40DV', '40'' Dry Van', 'Standard 40-foot dry container'),
        ('40HQ', '40'' High Cube', '40-foot high cube container with extra height')
      `);
    }
    
    // Add basic ports if none exist
    const portsResult = await pool.query('SELECT COUNT(*) FROM ports');
    if (parseInt(portsResult.rows[0].count) === 0) {
      await pool.query(`
        INSERT INTO ports (id, name, country, region, latitude, longitude, popularity) VALUES
        ('EETLL', 'Tallinn', 'Estonia', 'Europe', 59.4427, 24.7536, 0.75),
        ('NLRTM', 'Rotterdam', 'Netherlands', 'Europe', 51.9244, 4.4777, 1.00),
        ('DEHAM', 'Hamburg', 'Germany', 'Europe', 53.5511, 9.9937, 0.95),
        ('CNSHA', 'Shanghai', 'China', 'Asia', 31.2304, 121.4737, 1.00),
        ('SGSIN', 'Singapore', 'Singapore', 'Asia', 1.3521, 103.8198, 1.00),
        ('USNYC', 'New York', 'United States', 'North America', 40.7128, -74.0060, 0.95)
        ON CONFLICT (id) DO NOTHING
      `);
    }
    
    console.log('Database tables initialized successfully');
    return true;
  } catch (error) {
    console.error('Error initializing database tables:', error);
    return false;
  }
}

// Функция для обновления данных о ставках фрахта
async function updateFreightRatesData() {
  // Проверка, не выполняется ли уже обновление
  if (rateCache.isUpdating) {
    console.log('Update already in progress, skipping');
    return;
  }
  
  // Проверка, нужно ли обновлять данные
  const now = Date.now();
  if (rateCache.lastUpdate && (now - rateCache.lastUpdate < rateCache.updateInterval)) {
    console.log('Using cached freight rates data');
    return;
  }
  
  try {
    // Установка флага обновления
    rateCache.isUpdating = true;
    
    // Логирование начала обновления
    await pool.query(
      `INSERT INTO freight_indices_update_log (source, status, message) 
       VALUES ($1, $2, $3)`,
      ['ALL', 'STARTED', 'Starting update of all freight indices']
    );
    
    // Обновление данных из всех источников
    await freightCalculator.updateAllSourcesData();
    
    // Обновление времени последнего обновления
    rateCache.lastUpdate = now;
    
    // Логирование успешного обновления
    await pool.query(
      `INSERT INTO freight_indices_update_log (source, status, message) 
       VALUES ($1, $2, $3)`,
      ['ALL', 'COMPLETED', 'Successfully updated all freight indices']
    );
    
    console.log('Freight rates data updated successfully');
  } catch (error) {
    console.error('Error updating freight rates data:', error);
    
    // Логирование ошибки
    await pool.query(
      `INSERT INTO freight_indices_update_log (source, status, message) 
       VALUES ($1, $2, $3)`,
      ['ALL', 'ERROR', `Error updating freight indices: ${error.message}`]
    );
  } finally {
    // Сброс флага обновления
    rateCache.isUpdating = false;
  }
}

// API endpoint to get all ports
app.get('/api/ports', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ports ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка при получении списка портов:', error);
    res.status(500).json({ error: 'Failed to fetch ports' });
  }
});

// API endpoint to get container types
app.get('/api/container-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM container_types');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching container types:', error);
    res.status(500).json({ error: 'Failed to fetch container types' });
  }
});

// API endpoint to calculate freight rate
app.post('/api/calculate', async (req, res) => {
  try {
    console.log('Received calculation request:', req.body);
    const { email, origin, destination, containerType } = req.body;
    
    // Validate input
    if (!email || !origin || !destination || !containerType) {
      console.log('Validation failed: Missing required fields');
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    // Simple email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      console.log('Validation failed: Invalid email format');
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Обновление данных о ставках фрахта (если необходимо)
    await updateFreightRatesData();
    
    // Расчет ставки с использованием улучшенного алгоритма
    const result = await freightCalculator.calculateFreightRate(origin, destination, containerType);
    
    // Save calculation to history
    await pool.query(
      `INSERT INTO calculation_history 
       (timestamp, email, origin, destination, container_type, rate, min_rate, max_rate, reliability, source_count, sources)
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        email, 
        origin, 
        destination, 
        containerType, 
        result.rate, 
        result.minRate, 
        result.maxRate, 
        result.reliability, 
        result.sourceCount,
        result.sources ? result.sources.join(', ') : 'Base calculation'
      ]
    );
    
    console.log('Calculation result:', result);
    
    // Return calculation result
    res.json(result);
  } catch (error) {
    console.error('Error calculating freight rate:', error);
    res.status(500).json({ error: 'Failed to calculate freight rate' });
  }
});

// API endpoint to get calculation history
app.get('/api/history', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM calculation_history ORDER BY timestamp DESC LIMIT 100');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching calculation history:', error);
    res.status(500).json({ error: 'Failed to fetch calculation history' });
  }
});

// Admin authentication middleware
const authenticateAdmin = (req, res, next) => {
  const { username, password } = req.query;
  
  // Check admin credentials from environment variables
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin';
  
  if (username === adminUsername && password === adminPassword) {
    next();
  } else {
    res.status(401).json({ error: 'Unauthorized' });
  }
};

// Admin API endpoints
app.get('/api/admin/history', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM calculation_history ORDER BY timestamp DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching admin history:', error);
    res.status(500).json({ error: 'Failed to fetch admin history' });
  }
});

// Serve admin page
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve main page for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Initialize database and start server
async function startServer() {
  try {
    // Initialize database tables
    await initializeTables();
    
    // Start the server
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
  }
}

startServer();

export default app;
