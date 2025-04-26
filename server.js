// Обновленный файл server.js для калькулятора ставок фрахта
// Включает расширенную базу данных портов, поиск ближайших портов,
// запросы на добавление портов и верификацию email

const express = require('express');
const path = require('path');
const pg = require('pg');
const cors = require('cors');
const dotenv = require('dotenv');
const dns = require('dns');
const { promisify } = require('util');

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

// Get directory name
const __dirname = path.resolve();

// Import expanded ports list
const EXPANDED_PORTS = require('./data/expanded_ports.js');

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
  'Sydney-Rotterdam': [
    { name: 'Xeneta XSI', rate: 1950, reliability: 0.95 },
    { name: 'S&P Global Platts', rate: 2020, reliability: 0.92 },
    { name: 'Drewry WCI', rate: 1880, reliability: 0.90 },
    { name: 'Freightos FBX', rate: 1990, reliability: 0.88 },
    { name: 'World Container Index', rate: 1920, reliability: 0.85 },
    { name: 'Container Trades Statistics', rate: 1850, reliability: 0.82 },
    { name: 'Alphaliner', rate: 2000, reliability: 0.80 }
  ],
  'default': [
    { name: 'Xeneta XSI', rate: 1800, reliability: 0.95 },
    { name: 'S&P Global Platts', rate: 1870, reliability: 0.92 },
    { name: 'Drewry WCI', rate: 1730, reliability: 0.90 },
    { name: 'Freightos FBX', rate: 1840, reliability: 0.88 },
    { name: 'World Container Index', rate: 1770, reliability: 0.85 }
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
  'Rotterdam-Hamburg': 0.3,
  'Sydney-Rotterdam': 1.1
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

// List of common disposable email domains
const DISPOSABLE_EMAIL_DOMAINS = [
  '10minutemail.com', 'temp-mail.org', 'guerrillamail.com', 'mailinator.com',
  'tempmail.net', 'yopmail.com', 'maildrop.cc', 'getairmail.com',
  'getnada.com', 'mailnesia.com', 'tempr.email', 'dispostable.com',
  'sharklasers.com', 'guerrillamail.info', 'grr.la', 'spam4.me',
  'harakirimail.com', 'trashmail.com', 'temp-mail.io', 'fakeinbox.com',
  'tempail.com', 'throwawaymail.com', 'emailondeck.com', 'tempinbox.com',
  'disposable-email.com', 'mailcatch.com', 'tempmailaddress.com', 'anonbox.net',
  'jetable.org', 'mailexpire.com', 'moakt.com', 'mailforspam.com',
  'mytrashmail.com', 'inboxalias.com', 'tempmail.ninja', 'fakemail.net',
  'trash-mail.com', 'spamgourmet.com', 'incognitomail.com', 'meltmail.com',
  'mintemail.com', 'mailinator.net', 'mailinator.org', 'spamfree24.org',
  'spamfree24.net', 'spamfree24.com', 'spamfree.eu', 'discardmail.com',
  'discardmail.de', 'spambog.com', 'spambog.de', 'spambog.ru',
  'safetymail.info', 'filzmail.com', 'throwawaymail.com', 'trbvm.com',
  'drdrb.net', 'drdrb.com', 'tempmail.space', 'tempmail.plus',
  'temp-mail.ru', 'fake-email.com', 'throwam.com', 'throwawaymail.com',
  'yomail.info', 'cool.fr.nf', 'jetable.fr.nf', 'nospam.ze.tc',
  'nomail.xl.cx', 'mega.zik.dj', 'speed.1s.fr', 'courriel.fr.nf',
  'moncourrier.fr.nf', 'monemail.fr.nf', 'monmail.fr.nf', 'temporary-mail.net'
];

// Promisify DNS functions
const resolveMx = promisify(dns.resolveMx);
const lookup = promisify(dns.lookup);

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

    // Check if ports table is empty or needs updating
    const portsResult = await pool.query('SELECT COUNT(*) FROM ports');
    if (parseInt(portsResult.rows[0].count) < 20) {
      // Truncate ports table to avoid duplicates
      await pool.query('TRUNCATE TABLE ports');
      
      // Insert expanded ports list
      for (const port of EXPANDED_PORTS) {
        await pool.query(
          `INSERT INTO ports (id, name, country, region, latitude, longitude, popularity) 
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO UPDATE 
           SET name = $2, country = $3, region = $4, latitude = $5, longitude = $6, popularity = $7`,
          [
            port.id,
            port.name,
            port.country,
            port.region,
            port.latitude,
            port.longitude,
            port.popularity
          ]
        );
      }
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
    const baseRate = 1800 * distanceFactor * containerFactor * seasonalFactor;
    
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
      rate: 1800,
      min_rate: 1500,
      max_rate: 2100,
      currency: 'USD',
      sources: ['Emergency Fallback'],
      reliability: 0.3, // Low reliability for emergency fallback
      source_count: 0
    };
  }
}

/**
 * Calculate distance between two points using Haversine formula
 * @param {number} lat1 - Latitude of first point in degrees
 * @param {number} lon1 - Longitude of first point in degrees
 * @param {number} lat2 - Latitude of second point in degrees
 * @param {number} lon2 - Longitude of second point in degrees
 * @returns {number} Distance in kilometers
 */
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

/**
 * Find nearest ports based on coordinates
 * @param {Array} ports - Array of port objects
 * @param {number} latitude - Latitude in degrees
 * @param {number} longitude - Longitude in degrees
 * @param {number} limit - Maximum number of results to return
 * @returns {Array} Array of nearest ports with distances
 */
async function findNearestPorts(latitude, longitude, limit = 5) {
  try {
    const result = await pool.query(
      `SELECT *, 
       (6371 * acos(cos(radians($1)) * cos(radians(latitude)) * cos(radians(longitude) - radians($2)) + sin(radians($1)) * sin(radians(latitude)))) AS distance 
       FROM ports 
       WHERE latitude IS NOT NULL AND longitude IS NOT NULL
       ORDER BY distance ASC
       LIMIT $3`,
      [latitude, longitude, limit]
    );
    
    return result.rows;
  } catch (error) {
    console.error('Error finding nearest ports:', error);
    return [];
  }
}

/**
 * Verify email address
 * @param {string} email - Email address to verify
 * @returns {Object} Verification result with status and details
 */
async function verifyEmail(email) {
  try {
    // Check if email is already verified
    const existingResult = await pool.query(
      'SELECT * FROM verified_emails WHERE email = $1',
      [email]
    );
    
    if (existingResult.rows.length > 0) {
      return {
        valid: true,
        verified: true,
        message: 'Email already verified'
      };
    }
    
    // Basic format validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return {
        valid: false,
        verified: false,
        message: 'Invalid email format'
      };
    }
    
    // Check for disposable email domains
    const domain = email.split('@')[1].toLowerCase();
    if (DISPOSABLE_EMAIL_DOMAINS.includes(domain)) {
      return {
        valid: false,
        verified: false,
        message: 'Disposable email addresses are not allowed'
      };
    }
    
    // Check if domain exists (has MX records)
    try {
      const mxRecords = await resolveMx(domain);
      if (!mxRecords || mxRecords.length === 0) {
        return {
          valid: false,
          verified: false,
          message: 'Domain does not have valid mail servers'
        };
      }
    } catch (error) {
      // Try to lookup domain directly if MX lookup fails
      try {
        await lookup(domain);
      } catch (lookupError) {
        return {
          valid: false,
          verified: false,
          message: 'Domain does not exist'
        };
      }
    }
    
    // Save verified email
    await pool.query(
      'INSERT INTO verified_emails (email, verified_at) VALUES ($1, NOW())',
      [email]
    );
    
    return {
      valid: true,
      verified: true,
      message: 'Email verified successfully'
    };
  } catch (error) {
    console.error('Error verifying email:', error);
    return {
      valid: false,
      verified: false,
      message: 'Error during verification process'
    };
  }
}

// API Routes

// Get all ports
app.get('/api/ports', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ports ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching ports:', error);
    res.status(500).json({ error: 'Failed to fetch ports' });
  }
});

// Get all container types
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
    
    // Validate required fields
    if (!origin || !destination || !containerType || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Verify email
    const emailVerification = await verifyEmail(email);
    if (!emailVerification.valid) {
      return res.status(400).json({ error: emailVerification.message });
    }
    
    // Calculate rate
    const result = calculateFreightRate(origin, destination, containerType);
    
    // Save calculation to history
    await pool.query(
      `INSERT INTO calculation_history 
       (timestamp, email, origin, destination, container_type, rate, min_rate, max_rate, reliability, source_count) 
       VALUES (NOW(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
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
    
    res.json(result);
  } catch (error) {
    console.error('Error calculating freight rate:', error);
    res.status(500).json({ error: 'Failed to calculate freight rate' });
  }
});

// Find nearest ports
app.get('/api/nearest-ports', async (req, res) => {
  try {
    const { latitude, longitude, limit } = req.query;
    
    // Validate required fields
    if (!latitude || !longitude) {
      return res.status(400).json({ error: 'Missing latitude or longitude' });
    }
    
    // Find nearest ports
    const nearestPorts = await findNearestPorts(
      parseFloat(latitude),
      parseFloat(longitude),
      limit ? parseInt(limit) : 5
    );
    
    res.json(nearestPorts);
  } catch (error) {
    console.error('Error finding nearest ports:', error);
    res.status(500).json({ error: 'Failed to find nearest ports' });
  }
});

// Submit port request
app.post('/api/port-request', async (req, res) => {
  try {
    const { portName, country, region, requestReason, email } = req.body;
    
    // Validate required fields
    if (!portName || !country || !email) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    
    // Verify email
    const emailVerification = await verifyEmail(email);
    if (!emailVerification.valid) {
      return res.status(400).json({ error: emailVerification.message });
    }
    
    // Save port request
    await pool.query(
      `INSERT INTO port_requests 
       (timestamp, port_name, country, region, request_reason, user_email) 
       VALUES (NOW(), $1, $2, $3, $4, $5)`,
      [portName, country, region || '', requestReason || '', email]
    );
    
    res.json({ success: true, message: 'Port request submitted successfully' });
  } catch (error) {
    console.error('Error submitting port request:', error);
    res.status(500).json({ error: 'Failed to submit port request' });
  }
});

// Verify email
app.post('/api/verify-email', async (req, res) => {
  try {
    const { email } = req.body;
    
    // Validate required fields
    if (!email) {
      return res.status(400).json({ error: 'Missing email' });
    }
    
    // Verify email
    const result = await verifyEmail(email);
    
    res.json(result);
  } catch (error) {
    console.error('Error verifying email:', error);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

// Get calculation history for a specific email
app.get('/api/history', async (req, res) => {
  try {
    const { email } = req.query;
    
    // Validate required fields
    if (!email) {
      return res.status(400).json({ error: 'Missing email' });
    }
    
    // Get calculation history
    const result = await pool.query(
      `SELECT * FROM calculation_history 
       WHERE email = $1 
       ORDER BY timestamp DESC`,
      [email]
    );
    
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching calculation history:', error);
    res.status(500).json({ error: 'Failed to fetch calculation history' });
  }
});

// Serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  await initializeDatabase();
});

module.exports = app;
