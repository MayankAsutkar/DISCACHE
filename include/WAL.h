#ifndef DISCACHE_WAL_H
#define DISCACHE_WAL_H

#include "LRUCache.h"
#include <cstdint>
#include <fstream>
#include <mutex>
#include <string>
#include <vector>

namespace discache {

struct WALRecord {
    uint64_t seq;
    uint64_t timestamp_ms;
    std::string op; // "PUT" or "DELETE"
    std::string key;
    std::string value;
};

class WAL {
public:
    explicit WAL(const std::string& filepath);
    ~WAL();

    WAL(const WAL&) = delete;
    WAL& operator=(const WAL&) = delete;

    // Appends a PUT or DELETE record and flushes the C++ output stream
    // BEFORE updating memory. This does not call fsync/fdatasync.
    bool append_put(const std::string& key, const std::string& value);
    bool append_delete(const std::string& key);

    // Sequential WAL replay at node startup or simulated crash recovery
    std::size_t replay(LRUCache& cache);

    // Read all sequential records currently persisted in the WAL file
    std::vector<WALRecord> read_records(std::size_t max_records = 200) const;

    // Reset WAL file (for clean laboratory reset)
    void truncate();

    const std::string& filepath() const { return filepath_; }
    uint64_t sequence_number() const;

private:
    std::string filepath_;
    mutable std::mutex mutex_;
    std::ofstream out_;
    uint64_t next_seq_ = 1;

    static std::string hex_encode(const std::string& input);
    static std::string hex_decode(const std::string& hex);
    std::vector<WALRecord> read_records_unlocked() const;
};

} // namespace discache

#endif // DISCACHE_WAL_H
