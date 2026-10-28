const fs = require('fs');
const readline = require('readline');
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const QRCode = require('qrcode');
require('dotenv').config();

const apiId = Number(process.env.TELEGRAM_APP_ID);
const apiHash = process.env.TELEGRAM_APP_HASH;
const sessionFile = './telegram_session.txt';

if (!apiId || !apiHash) {
    console.error('❌ Ошибка: Укажите TELEGRAM_APP_ID и TELEGRAM_APP_HASH в файле .env');
    process.exit(1);
}

const stringSession = new StringSession("");

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (query) => new Promise(resolve => rl.question(query, resolve));

(async () => {
    console.log('====================================================');
    console.log('  Авторизация Userbot через QR-код (без ожидания СМС)');
    console.log('====================================================');

    const client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 5,
        useIPV6: false
    });

    await client.connect();

    console.log('⏳ Генерация QR-кода для входа...');

    try {
        const user = await client.signInUserWithQrCode(
            { apiId, apiHash },
            {
                qrCode: async (code) => {
                    const url = `tg://login?token=${code.token.toString("base64url")}`;
                    
                    console.log('\n📲 ---------------------------------------------');
                    console.log('Отсканируйте этот QR-код в приложении Telegram:');
                    console.log('  1. Откройте Telegram на телефоне');
                    console.log('  2. Настройки (Settings) -> Устройства (Devices)');
                    console.log('  3. Нажмите "Подключить устройство" (Link Desktop Device)');
                    console.log('------------------------------------------------\n');

                    try {
                        const qrAscii = await QRCode.toString(url, { type: 'terminal', small: true });
                        console.log(qrAscii);
                    } catch (e) {
                        console.log('Ссылка для входа (если QR не отрисовался):', url);
                    }
                },
                password: async (hint) => {
                    console.log(`🔐 На аккаунте включен 2FA пароль (Подсказка: ${hint || 'нет'})`);
                    const pwd = await question('Введите ваш 2FA пароль: ');
                    return pwd.trim();
                },
                onError: async (err) => {
                    console.error('⚠️ Ошибка при генерации QR:', err.message || err);
                }
            }
        );

        console.log(`\n🎉 Авторизация успешна! Аккаунт: @${user.username || user.firstName || user.id}`);

        const sessionString = client.session.save();
        fs.writeFileSync(sessionFile, sessionString);
        console.log(`✅ Сессия успешно сохранена в файл ${sessionFile}`);
        console.log('Теперь бот bot.js сможет создавать группы автоматически!\n');

        rl.close();
        process.exit(0);
    } catch (err) {
        console.error('\n❌ Ошибка авторизации по QR-коду:', err.message || err);
        rl.close();
        process.exit(1);
    }
})();
