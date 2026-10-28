const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const PaymentSchema = new Schema({
    acquiring: {
        type: String,
        default: 'heleket'
    },
    address: {
        type: String
    },
    creation_date: {
        type: Date,
        default: Date.now
    },
    type: {
        type: String
    },
    uuid: {
        type: String
    },
    order_id: {
        type: String
    },
    amount: {
        type: String
    },
    payment_amount: {
        type: String
    },
    payment_amount_usd: {
        type: String
    },
    merchant_amount: {
        type: String
    },
    commission: {
        type: String
    },
    is_final: {
        type: Boolean
    },
    status: {
        type: String
    },
    from: {
        type: String
    },
    wallet_address_uuid: {
        type: String || null
    },
    network: {
        type: String
    },
    currency: {
        type: String
    },
    payer_currency: {
        type: String
    },
    additional_data: {
        type: String || null
    },
    convert: {
        type: Object
    },
    txid: {
        type: String
    },
    sign: {
        type: String
    },
}, { versionKey: false });

const Payment = mongoose.model('Payment', PaymentSchema);

module.exports = {
    Payment
}