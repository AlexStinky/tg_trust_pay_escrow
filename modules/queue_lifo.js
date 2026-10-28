class Queue {
    constructor() {
        this._storage = {};
        this._oldestIndex = 1;
        this._newestIndex = 1;
    }

    size() {
        return this._newestIndex - this._oldestIndex;
    }

    enqueue(data) {
        this._storage[this._newestIndex] = data;
        this._newestIndex++;
    }

    dequeue() {
        let oldestIndex = this._oldestIndex,
            newestIndex = this._newestIndex,
            deletedData;

        if (oldestIndex !== newestIndex) {
            deletedData = this._storage[oldestIndex];
            delete this._storage[oldestIndex];
            this._oldestIndex++;

            return deletedData;
        }
    }
}

module.exports = {
    Queue
};

