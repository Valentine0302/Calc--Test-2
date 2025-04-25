const express = require('express');
const pg = require('pg');
const cors = require('cors');
const dotenv = require('dotenv');

// Загрузка переменных окружения
dotenv.config();

// Инициализация Express приложения
const app = express();
const PORT = process.env.PORT || 10000;

// Настройка middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

// Подключение к базе данных
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL
});

// Маршруты API
app.get('/api/ports', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM ports ORDER BY name');
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка при получении списка портов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Запуск сервера
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Экспорт приложения для тестирования
module.exports = app;
