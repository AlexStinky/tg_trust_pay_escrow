const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const DealSchema = new Schema({
    deal_number: {
        type: Number,
        unique: true
    },
    // ID чата, привязанного к сделке (группа или топик)
    chat_id: {
        type: String,
        index: true
    },
    chat_title: {
        type: String
    },
    chat_url: {
        type: String
    },
    // Источник (сообщество / группа, из которой создана сделка)
    source_chat_id: {
        type: String
    },
    source_chat_title: {
        type: String
    },
    // Сообщение карточки в закрытом канале администраторов
    admin_channel_message_id: {
        type: Number
    },
    // Статус сделки:
    // created (создана)
    // terms_agreed (условия согласованы, ожидание депозита)
    // paid (депозит получен, работа в процессе)
    // completed (работа выполнена, ожидает ручной выплаты гарантом)
    // payout_pending (на выплате)
    // paid_out (выплата продавцу выполнена)
    // refund_pending (на возврате)
    // refunded (возврат покупателю выполнен)
    // dispute (арбитраж/спор)
    // canceled (отменена)
    // paused (приостановлена администратором)
    status: {
        type: String,
        default: 'created',
        index: true
    },
    previous_status: {
        type: String
    },
    // Создатель сделки
    creator_role: {
        type: String, // 'buyer' или 'seller'
        default: 'buyer'
    },
    // Покупатель
    buyer: {
        chat_id: String,
        username: String,
        first_name: String,
        return_wallet: String, // Кошелек для возврата при споре
        terms_confirmed: {
            type: Boolean,
            default: false
        }
    },
    // Продавец
    seller: {
        chat_id: String,
        username: String,
        first_name: String,
        payout_wallet: String, // Кошелек продавца (конфиденциально!)
        terms_confirmed: {
            type: Boolean,
            default: false
        }
    },
    // Параметры сделки
    terms: {
        description: {
            type: String,
            default: ''
        },
        deadline: {
            type: String,
            default: ''
        }
    },
    // Финансы
    amount: {
        type: Number, // Чистая сумма сделки в USDT
        default: 0
    },
    fee_percent: {
        type: Number, // % комиссии
        default: 5
    },
    fee_amount: {
        type: Number, // сумма комиссии в USDT
        default: 0
    },
    fee_payer: {
        type: String, // 'buyer', 'seller', '50/50'
        default: 'buyer'
    },
    total_deposit_amount: {
        type: Number, // Точная сумма к оплате покупателем (сумма + комиссия если покупатель)
        default: 0
    },
    seller_receive_amount: {
        type: Number, // Сумма, которую получит продавец (сумма минус комиссия если продавец)
        default: 0
    },
    // Кошелек гаранта, назначенный для этой сделки
    assigned_escrow_wallet: {
        type: String, // Один из 3 системных кошельков
        index: true
    },
    deposit_txid: {
        type: String,
        index: true
    },
    deposit_amount_received: {
        type: Number,
        default: 0
    },
    deposit_confirmed_at: {
        type: Date
    },
    // Исходящая выплата / возврат (ручная гарантом)
    payout: {
        type: {
            type: String // 'seller_payout' или 'buyer_refund'
        },
        wallet: String,
        amount: Number,
        txid: String,
        confirmed_by: String, // chat_id гаранта/админа
        confirmed_at: Date
    },
    // Спор
    dispute: {
        is_active: {
            type: Boolean,
            default: false
        },
        opened_by: String, // buyer / seller
        opened_at: Date,
        reason: String,
        arbitrator_id: String,
        resolution: String,
        resolved_at: Date
    },
    created_at: {
        type: Date,
        default: Date.now
    },
    updated_at: {
        type: Date,
        default: Date.now
    }
}, { versionKey: false });

DealSchema.pre('save', function(next) {
    this.updated_at = new Date();
    next();
});

const Deal = mongoose.model('Deal', DealSchema);

module.exports = {
    Deal
};
