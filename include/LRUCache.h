#ifndef DISCACHE_LRU_CACHE_H
#define DISCACHE_LRU_CACHE_H

#include <cstddef>
#include <cstdint>
#include <optional>
#include <shared_mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace discache {

struct CacheEntryView {
    std::string key;
    std::string value;
};

struct PutOutcome {
    bool updated_existing;
    bool evicted;
    std::string evicted_key;
    std::string evicted_value;
};

struct CacheSnapshot {
    std::size_t size;
    std::size_t capacity;
    std::string mru_key;
    std::string lru_key;
    uint64_t hits;
    uint64_t misses;
    uint64_t evictions;
    std::vector<CacheEntryView> entries_mru_to_lru; // Ordered from head (MRU) to tail (LRU)
};

class LRUCache {
public:
    static constexpr std::size_t DEFAULT_CAPACITY = 100000;

    explicit LRUCache(std::size_t capacity = DEFAULT_CAPACITY);
    ~LRUCache();

    LRUCache(const LRUCache&) = delete;
    LRUCache& operator=(const LRUCache&) = delete;

    // O(1) Cache operations
    std::optional<std::string> get(const std::string& key);
    PutOutcome put(const std::string& key, const std::string& value);
    bool del(const std::string& key);

    // Read-only inspection using std::shared_lock<std::shared_mutex>
    std::optional<std::string> peek(const std::string& key) const;
    CacheSnapshot snapshot(std::size_t max_entries = 200) const;

    // Administrative / Recovery helpers
    void clear();
    void set_capacity(std::size_t new_capacity);
    std::size_t size() const;
    std::size_t capacity() const;

private:
    struct Node {
        std::string key;
        std::string value;
        Node* prev = nullptr;
        Node* next = nullptr;
    };

    // Internal O(1) doubly linked list helpers (caller must hold unique_lock)
    void attach_front(Node* node);
    void detach(Node* node);
    void move_to_head(Node* node);
    Node* pop_tail();
    void clear_unlocked();

    std::size_t capacity_;
    Node* head_ = nullptr; // Most Recently Used (MRU)
    Node* tail_ = nullptr; // Least Recently Used (LRU)
    std::unordered_map<std::string, Node*> map_;

    mutable std::shared_mutex rw_mutex_;
    uint64_t hits_ = 0;
    uint64_t misses_ = 0;
    uint64_t evictions_ = 0;
};

} // namespace discache

#endif // DISCACHE_LRU_CACHE_H
