//import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import pg from 'pg';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Setup middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Database connection
const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Convert ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Data source reliability weights
const SOURCE_WEIGHTS = {
  'Xeneta XSI': 1.2,
  'S&P Global Platts': 1.2,
  'Drewry WCI': 1.2,
  'Freightos FBX': 1.2,
  'World Container Index': 1.0,
  'Container Trades Statistics': 1.0,
  'Alphaliner': 1.0,
  'SCFI': 0.8,
  'Container xChange': 0.8
};

// Mock data sources for different routes
const DATA_SOURCES = {
  'Shanghai-Rotterdam': [
    { name: 'Xeneta XSI', rate: 1650, reliability: 0.95 },
    { name: 'S&P Global Platts', rate: 1720, reliability: 0.92 },
    { name: 'Drewry WCI', rate: 1580, reliability: 0.90 },
    { name: 'Freightos FBX', rate: 1690, reliability: 0.88 },
    { name: 'World Container Index', rate: 1620, reliability: 0.85 },
    { name: 'Container Trades Statistics', rate: 1550, reliability: 0.82 },
    { name: 'Alphaliner', rate: 1700, reliability: 0.80 }
  ],
  'Shanghai-Los Angeles': [
    { name: 'Xeneta XSI', rate: 2250, reliability: 0.95 },
    { name: 'S&P Global Platts', rate: 2320, reliability: 0.92 },
    { name: 'Drewry WCI', rate: 2180, reliability: 0.90 },
    { name: 'Freightos FBX', rate: 2290, reliability: 0.88 },
    { name: 'World Container Index', rate: 2220, reliability: 0.85 },
    { name: 'Container Trades Statistics', rate: 2150, reliability: 0.82 },
    { name: 'Alphaliner', rate: 2300, reliability: 0.80 }
  ],
  'Rotterdam-New York': [
    { name: 'Xeneta XSI', rate: 1850, reliability: 0.95 },
    { name: 'S&P Global Platts', rate: 1920, reliability: 0.92 },
    { name: 'Drewry WCI', rate: 1780, reliability: 0.90 },
    { name: 'Freightos FBX', rate: 1890, reliability: 0.88 },
    { name: 'World Container Index', rate: 1820, reliability: 0.85 },
    { name: 'Container Trades Statistics', rate: 1750, reliability: 0.82 },
    { name: 'Alphaliner', rate: 1900, reliability: 0.80 }
  ],
  'default': [
    { name: 'Xeneta XSI', rate: 1500, reliability: 0.95 },
    { name: 'S&P Global Platts', rate: 1570, reliability: 0.92 },
    { name: 'Drewry WCI', rate: 1430, reliability: 0.90 },
    { name: 'Freightos FBX', rate: 1540, reliability: 0.88 },
    { name: 'World Container Index', rate: 1470, reliability: 0.85 }
  ]
};

// Container type factors
const CONTAINER_FACTORS = {
  '20DV': 1.0,
  '40DV': 1.8,
  '40HQ': 2.0
};

// Distance factors for common routes
const DISTANCE_FACTORS = {
  'Shanghai-Rotterdam': 1.0,
  'Shanghai-Los Angeles': 0.85,
  'Rotterdam-New York': 0.9,
  'Shanghai-Singapore': 0.6,
  'Rotterdam-Hamburg': 0.3
};

// Seasonal factors by month (1-12)
const SEASONAL_FACTORS = {
  1: 1.15, // Jan (pre-CNY)
  2: 0.90, // Feb (post-CNY lull)
  3: 0.90, // Mar (post-CNY lull)
  4: 1.00, // Apr
  5: 1.00, // May
  6: 1.05, // Jun
  7: 1.10, // Jul (pre-Christmas)
  8: 1.10, // Aug (pre-Christmas)
  9: 1.10, // Sep (pre-Christmas)
  10: 1.05, // Oct
  11: 1.15, // Nov (pre-CNY)
  12: 1.15  // Dec (pre-CNY)
};

// Initialize database tables
async function initializeDatabase() {
  try {
    // Create tables if they don't exist
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
        source_count INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ports (
        id VARCHAR(10) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        country VARCHAR(100) NOT NULL,
        region VARCHAR(100) NOT NULL
      );

      CREATE TABLE IF NOT EXISTS container_types (
        id VARCHAR(10) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        description VARCHAR(255) NOT NULL
      );
    `);

    // Check if container_types table is empty
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

    // Check if ports table is empty
    const portsResult = await pool.query('SELECT COUNT(*) FROM ports');
    if (parseInt(portsResult.rows[0].count) === 0) {
      // Insert sample ports
      await pool.query(`
        INSERT INTO ports (id, name, country, region) VALUES
        ('CNSHA', 'Shanghai', 'China', 'Asia'),
        ('NLRTM', 'Rotterdam', 'Netherlands', 'Europe'),
        ('USLAX', 'Los Angeles', 'United States', 'North America'),
        ('SGSIN', 'Singapore', 'Singapore', 'Asia'),
        ('USNYC', 'New York', 'United States', 'North America'),
        ('DEHAM', 'Hamburg', 'Germany', 'Europe'),
        ('HKHKG', 'Hong Kong', 'China', 'Asia'),
        ('GBFXT', 'Felixstowe', 'United Kingdom', 'Europe'),
        ('JPTYO', 'Tokyo', 'Japan', 'Asia'),
        ('AEDXB', 'Dubai', 'United Arab Emirates', 'Middle East'),
        ('MYPKG', 'Port Klang', 'Malaysia', 'Asia'),
        ('ITGOA', 'Genoa', 'Italy', 'Europe'),
        ('BRRIG', 'Rio Grande', 'Brazil', 'South America'),
        ('ZADUR', 'Durban', 'South Africa', 'Africa'),
        ('AUSYD', 'Sydney', 'Australia', 'Oceania')
      `);
    }

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Calculate freight rate
function calculateFreightRate(origin, destination, containerType) {
  try {
    // Create route key
    const routeKey = `${origin}-${destination}`;
    
    // Get data sources for the route or use default
    const sources = DATA_SOURCES[routeKey] || DATA_SOURCES['default'];
    
    // Apply container type factor
    const containerFactor = CONTAINER_FACTORS[containerType] || 1.0;
    
    // Apply distance factor
    const distanceFactor = DISTANCE_FACTORS[routeKey] || 1.0;
    
    // Apply seasonal factor
    const currentMonth = new Date().getMonth() + 1; // 1-12
    const seasonalFactor = SEASONAL_FACTORS[currentMonth] || 1.0;
    
    // Apply market trend factor (simplified)
    const marketTrendFactor = 0.95; // Current market conditions (April 2025)
    
    // Calculate adjusted rates for each source
    const adjustedRates = sources.map(source => {
      const adjustedRate = source.rate * containerFactor * distanceFactor * seasonalFactor * marketTrendFactor;
      return {
        ...source,
        adjustedRate,
        weight: SOURCE_WEIGHTS[source.name] || 0.5
      };
    });
    
    // Calculate weighted average rate
    const totalWeight = adjustedRates.reduce((sum, source) => sum + source.weight, 0);
    const weightedSum = adjustedRates.reduce((sum, source) => sum + source.adjustedRate * source.weight, 0);
    const weightedAvgRate = totalWeight > 0 ? weightedSum / totalWeight : 0;
    
    // Find min and max rates
    const rateValues = adjustedRates.map(source => source.adjustedRate);
    const minRate = Math.min(...rateValues);
    const maxRate = Math.max(...rateValues);
    
    // Calculate reliability score
    let reliability = 0;
    if (adjustedRates.length > 1) {
      // Calculate coefficient of variation
      const mean = rateValues.reduce((sum, rate) => sum + rate, 0) / rateValues.length;
      const squaredDiffs = rateValues.map(rate => Math.pow(rate - mean, 2));
      const variance = squaredDiffs.reduce((sum, diff) => sum + diff, 0) / rateValues.length;
      const stdDev = Math.sqrt(variance);
      const cv = mean > 0 ? stdDev / mean : 1.0;
      
      // Reliability decreases with increasing coefficient of variation
      const rateAgreement = Math.max(0, 1 - Math.min(cv, 1.0));
      
      // Average reliability of sources
      const avgReliability = adjustedRates.reduce((sum, source) => sum + source.reliability, 0) / adjustedRates.length;
      
      // Combined reliability score
      reliability = 0.7 * rateAgreement + 0.3 * avgReliability;
    } else if (adjustedRates.length === 1) {
      // Single source reliability
      reliability = adjustedRates[0].reliability * 0.8; // Penalty for single source
    }
    
    // Round to nearest 10
    const roundedAvgRate = Math.round(weightedAvgRate / 10) * 10;
    const roundedMinRate = Math.round(minRate / 10) * 10;
    const roundedMaxRate = Math.round(maxRate / 10) * 10;
    
    // Ensure min <= avg <= max
    const finalMinRate = Math.min(roundedMinRate, roundedAvgRate);
    const finalMaxRate = Math.max(roundedMaxRate, roundedAvgRate);
    
    // Return result
    return {
      rate: roundedAvgRate,
      min_rate: finalMinRate,
      max_rate: finalMaxRate,
      currency: 'USD',
      sources: adjustedRates.map(source => source.name),
      reliability: parseFloat(reliability.toFixed(2)),
      source_count: adjustedRates.length
    };
  } catch (error) {
    console.error('Error in calculateFreightRate:', error);
    
    // Fallback calculation
    return calculateFallbackRate(origin, destination, containerType);
  }
}

// Calculate fallback rate when normal calculation fails
function calculateFallbackRate(origin, destination, containerType) {
  try {
    // Create route key
    const routeKey = `${origin}-${destination}`;
    
    // Get distance factor
    const distanceFactor = DISTANCE_FACTORS[routeKey] || 1.0;
    
    // Get container factor
    const containerFactor = CONTAINER_FACTORS[containerType] || 1.0;
    
    // Get seasonal factor
    const currentMonth = new Date().getMonth() + 1; // 1-12
    const seasonalFactor = SEASONAL_FACTORS[currentMonth] || 1.0;
    
    // Base rate calculation
    const baseRate = 1500 * distanceFactor * containerFactor * seasonalFactor;
    
    // Add some randomness (±8%)
    const fluctuation = 1.0 + (Math.random() * 0.16 - 0.08);
    const adjustedBaseRate = baseRate * fluctuation;
    
    // Calculate min and max rates (±15% from base)
    const minRate = adjustedBaseRate * 0.85;
    const maxRate = adjustedBaseRate * 1.15;
    
    // Round to nearest 10
    const roundedBaseRate = Math.round(adjustedBaseRate / 10) * 10;
    const roundedMinRate = Math.round(minRate / 10) * 10;
    const roundedMaxRate = Math.round(maxRate / 10) * 10;
    
    return {
      rate: roundedBaseRate,
      min_rate: roundedMinRate,
      max_rate: roundedMaxRate,
      currency: 'USD',
      sources: ['Fallback Calculation'],
      reliability: 0.5, // Medium reliability for fallback
      source_count: 0
    };
  } catch (error) {
    console.error('Error in calculateFallbackRate:', error);
    
    // Emergency fallback with fixed values
    return {
      rate: 1500,
      min_rate: 1200,
      max_rate: 1800,
      currency: 'USD',
      sources: ['Emergency Fallback'],
      reliability: 0.3, // Low reliability for emergency fallback
      source_count: 0
    };
  }
}

// API Routes
// Get ports list
app.get('/api/ports', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ports ORDER BY region, country, name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching ports:', error);
    res.status(500).json({ error: 'Failed to fetch ports' });
  }
});

// Get container types
app.get('/api/container-types', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM container_types ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching container types:', error);
    res.status(500).json({ error: 'Failed to fetch container types' });
  }
});

// Calculate freight rate
app.post('/api/calculate', async (req, res) => {
  try {
    const { origin, destination, containerType, email } = req.body;
    
    // Validate input
    if (!origin || !destination || !containerType || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Calculate freight rate
    const result = calculateFreightRate(origin, destination, containerType);
    
    // Save calculation to history
    try {
      await pool.query(
        `INSERT INTO calculation_history 
         (timestamp, email, origin, destination, container_type, rate, min_rate, max_rate, reliability, source_count) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          new Date().toISOString(),
          email,
          origin,
          destination,
          containerType,
          result.rate,
          result.min_rate,
          result.max_rate,
          result.reliability,
          result.source_count
        ]
      );
    } catch (error) {
      console.error('Error saving calculation history:', error);
      // Continue even if history saving fails
    }
    
    res.json(result);
  } catch (error) {
    console.error('Error calculating freight rate:', error);
    res.status(500).json({ error: 'Failed to calculate freight rate' });
  }
});

// Get calculation history
app.get('/api/history', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM calculation_history ORDER BY timestamp DESC LIMIT 50');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching calculation history:', error);
    res.status(500).json({ error: 'Failed to fetch calculation history' });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'operational',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Admin dashboard
app.get('/admin', (req, res) => {
  // Basic auth check
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Access"');
    return res.status(401).send('Authentication required');
  }
  
  // Decode credentials
  const credentials = Buffer.from(auth.split(' ')[1], 'base64').toString().split(':');
  const username = credentials[0];
  const password = credentials[1];
  
  // Check credentials
  if (username !== process.env.ADMIN_USERNAME || password !== process.env.ADMIN_PASSWORD) {
    res.set('WWW-Authenticate', 'Basic realm="Admin Access"');
    return res.status(401).send('Invalid credentials');
  }
  
  // Serve admin page
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve the main page for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start the server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initializeDatabase();
});

export default app;
