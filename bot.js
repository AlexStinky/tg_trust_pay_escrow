require('dotenv').config();

const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');

const middlewares = require('./scripts/middlewares');
const { sender } = require('./services/sender');
const { blockchainService } = require('./services/blockchain');
const { adminChannelService } = require('./services/admin_channel');
const { userbotService } = require('./services/telegram');
const { systemConfigService } = require('./services/db');

const DB_CONN = process.env.DB_CONN || 'mongodb://127.0.0.1:27017/escrow_db';
const BOT_TOKEN = process.env.BOT_TOKEN;

if (!BOT_TOKEN) {
    console.error('❌ ОШИБКА: BOT_TOKEN не указан в файле .env');
    process.exit(1);
}

// Подключение к MongoDB
mongoose.connect(DB_CONN, {
    useUnifiedTopology: true,
    useNewUrlParser: true
}).then(() => {
    console.log('✅ Успешное подключение к MongoDB');
}).catch(err => {
    console.error('❌ Ошибка подключения к MongoDB:', err.message);
});

const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 90000 });

// Инициализация связок сервисов
adminChannelService.init(bot);
blockchainService.setDependencies(sender, adminChannelService);

// Регистрация промежуточных слоев
bot.use(middlewares.userMiddleware);

// Обработка текстовых сообщений и команд
bot.on('text', middlewares.textHandler);

// Обработка callback query (нажатий на инлайн кнопки)
bot.on('callback_query', middlewares.callbackHandler);

// Обработка ошибок
bot.catch((err, ctx) => {
    const msg = err.message || String(err);
    // Игнорируем штатные предупреждения Telegram API (например, повторное нажатие кнопки без изменения текста)
    if (msg.includes('message is not modified') || msg.includes('message to edit not found')) {
        return;
    }
    console.error(`[Telegraf Error] update_type: ${ctx && ctx.updateType}:`, msg);
});

// Запуск бота и фоновых сервисов
(async () => {
    try {
        await sender.create(bot);

        // Инициализация и запуск юзербота (интерактивная авторизация в Telegram при необходимости)
        userbotService.create().then(ready => {
            if (ready) {
                console.log('🤖 Юзербот готов к автоматическому созданию чатов сделок');
            }
        }).catch(err => {
            console.error('[Userbot Init Error]:', err.message);
        });

        // Инициализация системного конфига и кошельков
        const config = await systemConfigService.getConfig();
        console.log('⚙️ Конфигурация системы загружена.');
        console.log(`🏛 Активных кошельков гаранта в пуле: ${config.escrow_wallets.length}`);

        // Запуск мониторинга входящих USDT TRC20 депозитов
        blockchainService.startMonitoring(25000); // каждые 25 секунд

        const botInfo = await bot.telegram.getMe();
        console.log(`🤖 Бот успешно запущен: @${botInfo.username}`);

        await bot.launch();
    } catch (error) {
        console.error('❌ Ошибка при инициализации сервисов бота:', error);
    }
})();

// Graceful shutdown
process.once('SIGINT', async () => {
    console.log('Остановка бота (SIGINT)...');
    await bot.stop();
    await mongoose.disconnect();
    process.exit(0);
});

process.once('SIGTERM', async () => {
    console.log('Остановка бота (SIGTERM)...');
    await bot.stop();
    await mongoose.disconnect();
    process.exit(0);
});
