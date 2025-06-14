// Модуль для преобразования SCFI скрапера в ES модуль
// Обеспечивает совместимость с server.js

import axios from 'axios';
import * as cheerio from 'cheerio';
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

// URL для получения данных SCFI
const SCFI_URL = 'https://en.sse.net.cn/indices/scfinew.jsp';
// Альтернативный источник данных
const SCFI_ALT_URL = 'https://www.freightwaves.com/news/tag/scfi';

// Функция для получения данных SCFI
async function fetchSCFIData() {
  try {
    console.log('Fetching Shanghai Containerized Freight Index data...');
    
    // Попытка получить данные с основного источника
    let scfiData = await fetchSCFIFromPrimarySource();
    
    // Если не удалось получить данные с основного источника, используем альтернативный
    if (!scfiData || scfiData.length === 0) {
      scfiData = await fetchSCFIFromAlternativeSource();
    }
    
    // Если данные получены, сохраняем их в базу данных
    if (scfiData && scfiData.length > 0) {
      await saveSCFIData(scfiData);
      return scfiData;
    } else {
      throw new Error('Failed to fetch SCFI data from all sources');
    }
  } catch (error) {
    console.error('Error fetching SCFI data:', error);
    // В случае ошибки возвращаем моковые данные
    return fetchMockSCFIData();
  }
}

// Функция для получения данных SCFI с основного источника
async function fetchSCFIFromPrimarySource() {
  try {
    // Отправка запроса на сайт Shanghai Shipping Exchange
    const response = await axios.get(SCFI_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    // Проверка успешности запроса
    if (response.status !== 200) {
      throw new Error(`Failed to fetch SCFI data from primary source: ${response.status}`);
    }
    
    // Парсинг HTML-страницы
    const $ = cheerio.load(response.data);
    
    // Извлечение данных из таблицы
    const scfiData = [];
    
    // Получение текущей даты
    const currentDate = new Date().toISOString().split('T')[0];
    
    // Поиск таблицы с данными SCFI
    const scfiTable = $('table.scfitable');
    
    // Парсинг строк таблицы
    scfiTable.find('tr').each((i, row) => {
      // Пропускаем заголовок таблицы
      if (i === 0) return;
      
      const columns = $(row).find('td');
      
      // Проверяем, что строка содержит нужное количество колонок
      if (columns.length >= 3) {
        const route = $(columns[0]).text().trim();
        const currentIndexText = $(columns[1]).text().trim();
        const changeText = $(columns[2]).text().trim();
        
        // Извлечение числового значения индекса
        const currentIndex = parseFloat(currentIndexText.replace(',', ''));
        
        // Извлечение числового значения изменения
        const changeMatch = changeText.match(/([-+]?\d+(\.\d+)?)/);
        const change = changeMatch ? parseFloat(changeMatch[1]) : 0;
        
        // Добавление данных в массив, если маршрут не пустой и индекс является числом
        if (route && !isNaN(currentIndex)) {
          scfiData.push({
            route: `SCFI ${route}`,
            currentIndex,
            change,
            indexDate: currentDate
          });
        }
      }
    });
    
    // Если не удалось найти данные в таблице, ищем композитный индекс
    if (scfiData.length === 0) {
      const compositeIndex = $('.scfi-composite').text().trim();
      const compositeChange = $('.scfi-change').text().trim();
      
      // Извлечение числового значения индекса
      const currentIndex = parseFloat(compositeIndex.replace(',', ''));
      
      // Извлечение числового значения изменения
      const changeMatch = compositeChange.match(/([-+]?\d+(\.\d+)?)/);
      const change = changeMatch ? parseFloat(changeMatch[1]) : 0;
      
      // Добавление данных в массив, если индекс является числом
      if (!isNaN(currentIndex)) {
        scfiData.push({
          route: 'SCFI Composite Index',
          currentIndex,
          change,
          indexDate: currentDate
        });
      }
    }
    
    console.log(`Parsed SCFI data from primary source: ${scfiData.length} records`);
    
    return scfiData;
  } catch (error) {
    console.error('Error fetching SCFI data from primary source:', error);
    return [];
  }
}

// Функция для получения данных SCFI с альтернативного источника
async function fetchSCFIFromAlternativeSource() {
  try {
    // Отправка запроса на альтернативный сайт
    const response = await axios.get(SCFI_ALT_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });
    
    // Проверка успешности запроса
    if (response.status !== 200) {
      throw new Error(`Failed to fetch SCFI data from alternative source: ${response.status}`);
    }
    
    // Парсинг HTML-страницы
    const $ = cheerio.load(response.data);
    
    // Извлечение данных из статей
    const scfiData = [];
    
    // Получение текущей даты
    const currentDate = new Date().toISOString().split('T')[0];
    
    // Поиск статей с упоминанием SCFI
    const articles = $('article');
    
    // Ищем в статьях упоминания индекса SCFI и его значения
    articles.each((i, article) => {
      const articleText = $(article).text();
      
      // Ищем упоминание композитного индекса SCFI
      const indexMatch = articleText.match(/SCFI.*?(\d+(\.\d+)?)/i);
      
      if (indexMatch) {
        const currentIndex = parseFloat(indexMatch[1]);
        
        // Ищем упоминание изменения индекса
        const changeMatch = articleText.match(/(up|down).*?(\d+(\.\d+)?)/i);
        let change = 0;
        
        if (changeMatch) {
          change = parseFloat(changeMatch[2]);
          if (changeMatch[1].toLowerCase() === 'down') {
            change = -change;
          }
        }
        
        // Добавление данных в массив, если индекс является числом
        if (!isNaN(currentIndex)) {
          scfiData.push({
            route: 'SCFI Composite Index',
            currentIndex,
            change,
            indexDate: currentDate
          });
          
          // Берем только первое найденное значение
          return false;
        }
      }
    });
    
    console.log(`Parsed SCFI data from alternative source: ${scfiData.length} records`);
    
    return scfiData;
  } catch (error) {
    console.error('Error fetching SCFI data from alternative source:', error);
    return [];
  }
}

// Функция для получения моковых данных SCFI
async function fetchMockSCFIData() {
  console.log('Using mock data for SCFI');
  
  // Получение текущей даты
  const currentDate = new Date().toISOString().split('T')[0];
  
  // Создание моковых данных на основе реальных значений SCFI
  const mockData = [
    {
      route: 'SCFI Composite Index',
      currentIndex: 1950,
      change: 25,
      indexDate: currentDate
    },
    {
      route: 'SCFI Europe/Mediterranean',
      currentIndex: 2020,
      change: 35,
      indexDate: currentDate
    },
    {
      route: 'SCFI North America West Coast',
      currentIndex: 2250,
      change: 40,
      indexDate: currentDate
    },
    {
      route: 'SCFI North America East Coast',
      currentIndex: 2350,
      change: 45,
      indexDate: currentDate
    },
    {
      route: 'SCFI Southeast Asia',
      currentIndex: 1750,
      change: 15,
      indexDate: currentDate
    }
  ];
  
  // Сохранение моковых данных в базу данных
  await saveSCFIData(mockData);
  
  return mockData;
}

// Функция для сохранения данных SCFI в базу данных
async function saveSCFIData(scfiData) {
  const client = await pool.connect();
  
  try {
    // Начало транзакции
    await client.query('BEGIN');
    
    // Создание таблицы, если она не существует
    await client.query(`
      CREATE TABLE IF NOT EXISTS freight_indices_scfi (
        id SERIAL PRIMARY KEY,
        route VARCHAR(255) NOT NULL,
        current_index NUMERIC NOT NULL,
        change NUMERIC,
        index_date DATE NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        UNIQUE(route, index_date)
      )
    `);
    
    // Вставка данных
    for (const data of scfiData) {
      await client.query(
        `INSERT INTO freight_indices_scfi 
         (route, current_index, change, index_date) 
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (route, index_date) 
         DO UPDATE SET 
           current_index = $2,
           change = $3`,
        [
          data.route,
          data.currentIndex,
          data.change,
          data.indexDate
        ]
      );
    }
    
    // Завершение транзакции
    await client.query('COMMIT');
    
    console.log(`Saved ${scfiData.length} SCFI records to database`);
  } catch (error) {
    // Откат транзакции в случае ошибки
    await client.query('ROLLBACK');
    console.error('Error saving SCFI data to database:', error);
    throw error;
  } finally {
    // Освобождение клиента
    client.release();
  }
}

// Функция для получения данных SCFI для расчета ставки фрахта
async function getSCFIDataForCalculation() {
  try {
    console.log('Getting SCFI data for calculation...');
    
    // Получение последних данных композитного индекса SCFI из базы данных
    const query = `
      SELECT * FROM freight_indices_scfi 
      WHERE route = 'SCFI Composite Index'
      ORDER BY index_date DESC 
      LIMIT 1
    `;
    
    const result = await pool.query(query);
    
    // Если данные найдены в базе, возвращаем их
    if (result.rows.length > 0) {
      const data = result.rows[0];
      console.log('Found SCFI data in database:', data);
      
      return {
        index: 'SCFI',
        value: data.current_index,
        change: data.change,
        date: data.index_date,
        trend: data.change > 0 ? 'up' : 'down',
        source: 'database'
      };
    }
    
    // Если данных нет в базе, пытаемся получить их через API
    console.log('No SCFI data in database, fetching from API...');
    try {
      const scfiData = await fetchSCFIData();
      
      // Ищем композитный индекс в полученных данных
      const compositeData = scfiData.find(data => data.route.includes('Composite Index'));
      
      if (compositeData) {
        console.log('Fetched SCFI data from API:', compositeData);
        
        return {
          index: 'SCFI',
          value: compositeData.currentIndex,
          change: compositeData.change,
          date: compositeData.indexDate,
          trend: compositeData.change > 0 ? 'up' : 'down',
          source: 'api'
        };
      }
    } catch (error) {
      console.error('Error fetching SCFI data from API:', error);
    }
    
    // Если данные не удалось получить, возвращаем моковые данные
    console.log('Failed to get SCFI data, using mock data');
    return {
      index: 'SCFI',
      value: 1950,
      change: 25,
      date: new Date().toISOString().split('T')[0],
      trend: 'up',
      source: 'mock'
    };
  } catch (error) {
    console.error('Error getting SCFI data for calculation:', error);
    
    // В случае ошибки возвращаем моковые данные
    return {
      index: 'SCFI',
      value: 1950,
      change: 25,
      date: new Date().toISOString().split('T')[0],
      trend: 'up',
      source: 'mock'
    };
  }
}

// Функция для получения данных SCFI для конкретного маршрута
async function getSCFIDataForRoute(origin, destination) {
  try {
    // Определение региона порта отправления
    const originRegion = await getPortRegionById(origin);
    
    // Определение региона порта назначения
    const destinationRegion = await getPortRegionById(destination);
    
    // Создание шаблонов поиска маршрута на основе регионов
    let routePatterns = [];
    
    // Сопоставление регионов с маршрутами SCFI
    if (originRegion === 'Asia' && destinationRegion === 'Europe') {
      routePatterns.push('%SCFI Europe%', '%SCFI Mediterranean%');
    } else if (originRegion === 'Asia' && destinationRegion === 'North America') {
      if (isWestCoast(destination)) {
        routePatterns.push('%SCFI North America West%');
      } else {
        routePatterns.push('%SCFI North America East%');
      }
    } else if (originRegion === 'Asia' && destinationRegion === 'Asia') {
      routePatterns.push('%SCFI Southeast Asia%');
    }
    
    // Поиск подходящего маршрута в данных SCFI
    for (const pattern of routePatterns) {
      const query = `
        SELECT * FROM freight_indices_scfi 
        WHERE route ILIKE $1 
        ORDER BY index_date DESC 
        LIMIT 1
      `;
      
      const result = await pool.query(query, [pattern]);
      
      if (result.rows.length > 0) {
        return result.rows[0];
      }
    }
    
    // Если точное совпадение не найдено, вернем композитный индекс SCFI
    const globalQuery = `
      SELECT * FROM freight_indices_scfi 
      WHERE route = 'SCFI Composite Index'
      ORDER BY index_date DESC 
      LIMIT 1
    `;
    
    const globalResult = await pool.query(globalQuery);
    
    return globalResult.rows.length > 0 ? globalResult.rows[0] : null;
  } catch (error) {
    console.error('Error getting SCFI data for route:', error);
    return null;
  }
}

// Вспомогательная функция для получения региона порта по его ID
async function getPortRegionById(portId) {
  try {
    const result = await pool.query('SELECT region FROM ports WHERE id = $1', [portId]);
    return result.rows.length > 0 ? result.rows[0].region : 'Unknown';
  } catch (error) {
    console.error('Error getting port region:', error);
    return 'Unknown';
  }
}

// Вспомогательная функция для определения, находится ли порт на западном побережье
function isWestCoast(portId) {
  // Список ID портов западного побережья Северной Америки
  const westCoastPorts = [
    // Порты западного побережья США
    'USLAX', 'USLGB', 'USSEA', 'USOAK', 'USSFO', 'USPDX',
    // Порты западного побережья Канады
    'CAVAN', 'CAPRI'
  ];
  
  return westCoastPorts.includes(portId);
}

// Экспорт функций в формате ES модулей
export { 
  fetchSCFIData,
  getSCFIDataForRoute,
  getSCFIDataForCalculation
};

// Экспорт по умолчанию для обратной совместимости
export default {
  fetchSCFIData,
  getSCFIDataForRoute,
  getSCFIDataForCalculation
};
