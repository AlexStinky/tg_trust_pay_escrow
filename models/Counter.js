const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const CounterSchema = new Schema({
    _id: {
        type: String,
        required: true
    },
    seq: {
        type: Number,
        default: 1000
    }
}, { versionKey: false });

const Counter = mongoose.model('Counter', CounterSchema);

async function getNextDealNumber() {
    const counter = await Counter.findByIdAndUpdate(
        { _id: 'deal_number' },
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return counter.seq;
}

module.exports = {
    Counter,
    getNextDealNumber
};

