#include "../include/WAL.h"
#include <chrono>
#include <iomanip>
#include <sstream>

namespace discache {

static uint64_t current_time_ms() {
    using namespace std::chrono;
    return static_cast<uint64_t>(
        duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count()
    );
}

WAL::WAL(const std::string& filepath) : filepath_(filepath) {
    auto existing = read_records_unlocked();
    if (!existing.empty()) {
        next_seq_ = existing.back().seq + 1;
    }
    out_.open(filepath_, std::ios::out | std::ios::app);
}

WAL::~WAL() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (out_.is_open()) {
        out_.flush();
        out_.close();
    }
}

std::string WAL::hex_encode(const std::string& input) {
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');
    for (unsigned char c : input) {
        oss << std::setw(2) << static_cast<int>(c);
    }
    return oss.str();
}

std::string WAL::hex_decode(const std::string& hex) {
    std::string out;
    out.reserve(hex.size() / 2);
    for (std::size_t i = 0; i + 1 < hex.size(); i += 2) {
        std::string byte_str = hex.substr(i, 2);
        char byte = static_cast<char>(std::strtol(byte_str.c_str(), nullptr, 16));
        out.push_back(byte);
    }
    return out;
}

bool WAL::append_put(const std::string& key, const std::string& value) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!out_.is_open()) {
        out_.open(filepath_, std::ios::out | std::ios::app);
        if (!out_.is_open()) return false;
    }

    uint64_t seq = next_seq_++;
    uint64_t ts = current_time_ms();
    // Format: SEQ <seq> <ts> PUT <hex_key> <hex_val> | <readable_key>=<readable_val>
    out_ << seq << " " << ts << " PUT "
         << hex_encode(key) << " " << hex_encode(value) << "\n";
    out_.flush();
    return out_.good();
}

bool WAL::append_delete(const std::string& key) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!out_.is_open()) {
        out_.open(filepath_, std::ios::out | std::ios::app);
        if (!out_.is_open()) return false;
    }

    uint64_t seq = next_seq_++;
    uint64_t ts = current_time_ms();
    out_ << seq << " " << ts << " DELETE "
         << hex_encode(key) << " -\n";
    out_.flush();
    return out_.good();
}

std::vector<WALRecord> WAL::read_records_unlocked() const {
    std::vector<WALRecord> records;
    std::ifstream in(filepath_);
    if (!in.is_open()) {
        return records;
    }

    std::string line;
    while (std::getline(in, line)) {
        if (line.empty()) continue;
        std::istringstream iss(line);
        uint64_t seq = 0;
        uint64_t ts = 0;
        std::string op;
        std::string hex_key;
        std::string hex_val;
        if (!(iss >> seq >> ts >> op >> hex_key >> hex_val)) {
            continue;
        }
        WALRecord rec;
        rec.seq = seq;
        rec.timestamp_ms = ts;
        rec.op = op;
        rec.key = hex_decode(hex_key);
        rec.value = (op == "PUT" && hex_val != "-") ? hex_decode(hex_val) : "";
        records.push_back(std::move(rec));
    }
    return records;
}

std::size_t WAL::replay(LRUCache& cache) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (out_.is_open()) {
        out_.flush();
    }
    auto records = read_records_unlocked();
    cache.clear();
    for (const auto& rec : records) {
        if (rec.op == "PUT") {
            cache.put(rec.key, rec.value);
        } else if (rec.op == "DELETE") {
            cache.del(rec.key);
        }
    }
    if (!records.empty()) {
        next_seq_ = records.back().seq + 1;
    }
    return records.size();
}

std::vector<WALRecord> WAL::read_records(std::size_t max_records) const {
    std::lock_guard<std::mutex> lock(mutex_);
    auto all = read_records_unlocked();
    if (all.size() <= max_records) {
        return all;
    }
    return std::vector<WALRecord>(all.end() - static_cast<std::ptrdiff_t>(max_records), all.end());
}

void WAL::truncate() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (out_.is_open()) {
        out_.close();
    }
    out_.open(filepath_, std::ios::out | std::ios::trunc);
    out_.flush();
    next_seq_ = 1;
}

uint64_t WAL::sequence_number() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return next_seq_ - 1;
}

} // namespace discache
