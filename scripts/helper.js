const QRCode = require('qrcode');
const { TronWeb } = require('tronweb');

const helper = {
    isValidTronAddress(address) {
        if (!address || typeof address !== 'string') return false;
        return TronWeb.isAddress(address);
    },

    async generateQRBuffer(text) {
        try {
            return await QRCode.toBuffer(text, {
                width: 350,
                margin: 2,
                color: {
                    dark: '#000000',
                    light: '#FFFFFF'
                }
            });
        } catch (e) {
            console.error('[QRCode Error]:', e);
            return null;
        }
    },

    formatMoney(amount) {
        const num = Number(amount) || 0;
        return num.toFixed(2);
    },

    formatDate(date) {
        if (!date) return '—';
        return new Date(date).toLocaleString('ru-RU', { timeZone: 'UTC' }) + ' UTC';
    }
};

module.exports = helper;
