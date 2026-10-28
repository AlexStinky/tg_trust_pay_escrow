const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const SystemConfigSchema = new Schema({
    _id: {
        type: String,
        default: 'main_config'
    },
    // 3 кошелька гарант-сервиса TRC20 для приема средств
    escrow_wallets: [{
        address: { type: String, required: true },
        label: { type: String, default: 'Кошелек' },
        active: { type: Boolean, default: true }
    }],
    fee_percent: {
        type: Number,
        default: 5 // 5%
    },
    min_fee_usdt: {
        type: Number,
        default: 2 // Минимум 2 USDT
    },
    min_deal_amount: {
        type: Number,
        default: 5 // Минимум 5 USDT
    },
    admin_channel_id: {
        type: String, // ID закрытого административного канала
        default: ''
    },
    created_at: {
        type: Date,
        default: Date.now
    }
}, { versionKey: false });

const SystemConfig = mongoose.model('SystemConfig', SystemConfigSchema);

module.exports = {
    SystemConfig
};

