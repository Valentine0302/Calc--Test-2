// Модуль для сбора данных из Shanghai Containerized Freight Index (SCFI)
// Использует веб-скрапинг для получения еженедельных данных о ставках фрахта

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

// Функция для получения данных SCFI
async function fetchSCFIData() {
  try {
    console.log('Fetching SCFI data...');
    
    // Отправка запроса на сайт Shanghai Shipping Exchange
    const response = await axios.get(SCFI_URL);
    
    // Проверка успешности запроса
    if (response.status !== 200) {
      throw new Error(`Failed to fetch SCFI data: ${response.status}`);
    }
    
    // Парсинг HTML-страницы
    const $ = cheerio.load(response.data);
    
    // Извлечение данных из таблицы
    // Примечание: селекторы могут потребовать корректировки в зависимости от структуры страницы
    const scfiData = [];
    
    // Поиск таблицы с данными SCFI
    const table = $('.content-table');
    
    // Получение даты публикации
    const publicationDate = $('.date-info').text().trim();
    const dateMatch = publicationDate.match(/(\d{4}-\d{2}-\d{2})/);
    const indexDate = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];
    
    // Парсинг строк таблицы
    table.find('tr').each((i, row) => {
      // Пропуск заголовка таблицы
      if (i === 0) return;
      
      const route = $(row).find('td:nth-child(1)').text().trim();
      const currentIndex = parseFloat($(row).find('td:nth-child(2)').text().trim());
      const previousIndex = parseFloat($(row).find('td:nth-child(3)').text().trim());
      const change = parseFloat($(row).find('td:nth-child(4)').text().trim());
      
      // Добавление данных в массив, если маршрут не пустой
      if (route) {
        scfiData.push({
          route,
          currentIndex,
          previousIndex,
          change,
          indexDate
        });
      }
    });
    
    console.log(`Parsed ${scfiData.length} SCFI routes`);
    
    // Сохранение данных в базу данных
    await saveScfiData(scfiData);
    
    return scfiData;
  } catch (error) {
    console.error('Error fetching SCFI data:', error);
    throw error;
  }
}

// Функция для сохранения данных SCFI в базу данных
async function saveScfiData(scfiData) {
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
        previous_index NUMERIC,
        change NUMERIC,
        index_date DATE NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    
    // Вставка данных
    for (const data of scfiData) {
      await client.query(
        `INSERT INTO freight_indices_scfi 
         (route, current_index, previous_index, change, index_date) 
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (route, index_date) 
         DO UPDATE SET 
           current_index = $2,
           previous_index = $3,
           change = $4`,
        [
          data.route,
          data.currentIndex,
          data.previousIndex,
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

// Функция для получения данных SCFI для конкретного маршрута
async function getSCFIDataForRoute(origin, destination) {
  try {
    // Преобразование кодов портов в названия для поиска в данных SCFI
    const originName = await getPortNameById(origin);
    const destinationName = await getPortNameById(destination);
    
    // Поиск подходящего маршрута в данных SCFI
    const query = `
      SELECT * FROM freight_indices_scfi 
      WHERE route ILIKE $1 
      ORDER BY index_date DESC 
      LIMIT 1
    `;
    
    // Создание шаблона поиска маршрута
    // Примечание: это упрощенный подход, может потребоваться более сложная логика сопоставления
    const routePattern = `%${originName}%${destinationName}%`;
    
    const result = await pool.query(query, [routePattern]);
    
    if (result.rows.length > 0) {
      return result.rows[0];
    }
    
    // Если точное совпадение не найдено, попробуем найти похожие маршруты
    const fallbackQuery = `
      SELECT * FROM freight_indices_scfi 
      WHERE route ILIKE $1 OR route ILIKE $2
      ORDER BY index_date DESC 
      LIMIT 1
    `;
    
    const originPattern = `%${originName}%`;
    const destPattern = `%${destinationName}%`;
    
    const fallbackResult = await pool.query(fallbackQuery, [originPattern, destPattern]);
    
    return fallbackResult.rows.length > 0 ? fallbackResult.rows[0] : null;
  } catch (error) {
    console.error('Error getting SCFI data for route:', error);
    return null;
  }
}

// Вспомогательная функция для получения названия порта по его ID
async function getPortNameById(portId) {
  try {
    const result = await pool.query('SELECT name FROM ports WHERE id = $1', [portId]);
    return result.rows.length > 0 ? result.rows[0].name : portId;
  } catch (error) {
    console.error('Error getting port name:', error);
    return portId;
  }
}

// Экспорт функций
export default {
  fetchSCFIData,
  getSCFIDataForRoute
};
